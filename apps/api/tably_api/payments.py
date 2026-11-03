"""Payment state machine and the operations on it.

Statuses: initiated, awaiting_confirmation, verified, failed, expired, cancelled. "Unpaid" means no row.

The one rule that matters: a payment becomes `verified` only through the creator's review or an
authenticated provider event. The payer can move their own payment to awaiting_confirmation or cancel it,
and that is all.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import service
from .config import get_settings
from .models import ACTIVE_STATUSES, PINNING_STATUSES, Bill, Participant, Payment, PaymentEvent
from .providers import PROVIDERS, ProviderEvent

ALLOWED: dict[tuple[str, str], set[str]] = {
    ("initiated", "awaiting_confirmation"): {"payer"},
    ("initiated", "cancelled"): {"payer"},
    ("initiated", "expired"): {"system", "provider"},
    ("initiated", "verified"): {"creator", "provider"},
    ("initiated", "failed"): {"creator", "provider"},
    ("awaiting_confirmation", "verified"): {"creator", "provider"},
    ("awaiting_confirmation", "failed"): {"creator", "provider"},
    ("awaiting_confirmation", "expired"): {"provider"},
    ("expired", "verified"): {"creator", "provider"},  # money arrived after the attempt timed out
    ("failed", "verified"): {"creator"},  # creator corrects a mistaken rejection
}

_REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O/1/I to avoid misreading


class PaymentError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None):
        self.status, self.message, self.code = status, message, code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def new_reference() -> str:
    return "TBL-" + "".join(secrets.choice(_REF_ALPHABET) for _ in range(6))


def for_bill(db: Session, bill: Bill) -> list[Payment]:
    return list(db.scalars(select(Payment).where(Payment.bill_id == bill.id).order_by(Payment.created_at)))


def pinned_amounts(payments: list[Payment]) -> dict[str, int]:
    """Participants whose total is frozen because they have a live or settled payment."""
    return {p.participant_id: p.amount for p in payments if p.status in PINNING_STATUSES}


def transition(
    db: Session, payment: Payment, to: str, actor: str, note: str = "", provider_event_id: str | None = None
) -> None:
    if actor not in ALLOWED.get((payment.status, to), set()):
        raise PaymentError(409, f"A payment that is {payment.status.replace('_', ' ')} cannot be changed that way.", "bad_transition")
    db.add(
        PaymentEvent(
            payment_id=payment.id, actor=actor, from_status=payment.status, to_status=to,
            note=note[:200], provider_event_id=provider_event_id,
        )
    )
    payment.status = to
    service.bump(db, payment.bill_id)


def expire_stale(db: Session, bill: Bill) -> None:
    now = _now()
    changed = False
    for p in for_bill(db, bill):
        exp = p.expires_at
        if p.status == "initiated" and exp is not None:
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if exp <= now:
                transition(db, p, "expired", "system", "Attempt timed out")
                changed = True
    if changed:
        db.commit()


def live_payment(db: Session, participant_id: str) -> Payment | None:
    return db.scalar(
        select(Payment).where(Payment.participant_id == participant_id, Payment.status.in_(PINNING_STATUSES))
    )


def create_payment(
    db: Session, bill: Bill, participant: Participant, provider_key: str, idempotency_key: str | None
) -> Payment:
    provider = PROVIDERS.get(provider_key)
    if provider is None:
        raise PaymentError(422, "Unknown payment method.")
    avail = provider.availability(bill)
    if not avail.enabled:
        raise PaymentError(409, avail.reason or "This payment method is not available.", "unavailable")
    if bill.status != "open":
        raise PaymentError(409, "This bill is closed.")

    # Serialize double-taps for one person; the partial unique index is the backstop.
    db.execute(select(Participant).where(Participant.id == participant.id).with_for_update())

    if idempotency_key:
        same = db.scalar(
            select(Payment).where(Payment.participant_id == participant.id, Payment.idempotency_key == idempotency_key)
        )
        if same:
            return same
    existing = live_payment(db, participant.id)
    if existing:
        if existing.status == "verified":
            raise PaymentError(409, "Your share is already paid.", "already_paid")
        return existing  # an attempt is already open; reuse it instead of creating a duplicate

    state = service.compute_state(bill, service.load_claims(db, bill), pinned_amounts(for_bill(db, bill)))
    row = next(r for r in state["participants"] if r["id"] == participant.id)
    if row["total"] <= 0:
        raise PaymentError(409, "You have nothing to pay yet. Pick your items first.", "nothing_due")

    payment = Payment(
        bill_id=bill.id, participant_id=participant.id, provider=provider_key, amount=row["total"],
        currency=bill.currency, status="initiated", reference=_unique_reference(db, bill.id),
        idempotency_key=idempotency_key,
        expires_at=_now() + timedelta(hours=get_settings().payment_initiated_hours),
    )
    try:
        db.add(payment)
        db.flush()  # assigns payment.id; the partial unique index rejects a duplicate live payment here
        db.add(PaymentEvent(payment_id=payment.id, actor="payer", from_status=None, to_status="initiated"))
        service.bump(db, bill.id)
        db.commit()
    except IntegrityError:
        db.rollback()
        again = live_payment(db, participant.id)
        if again:
            return again
        raise
    return payment


def _unique_reference(db: Session, bill_id: str) -> str:
    for _ in range(20):
        ref = new_reference()
        if not db.scalar(select(Payment.id).where(Payment.bill_id == bill_id, Payment.reference == ref)):
            return ref
    raise PaymentError(500, "Could not allocate a payment reference.")


def mark_paid_by_payer(db: Session, payment: Payment, payer_note: str | None) -> None:
    """The payer says they sent the money. This asks for confirmation; it does not confirm anything."""
    if payer_note:
        payment.payer_note = payer_note[:80]
    transition(db, payment, "awaiting_confirmation", "payer", payer_note or "")
    db.commit()


def apply_provider_event(db: Session, provider_key: str, event: ProviderEvent) -> str:
    """Apply an already-authenticated provider event. Returns: applied | duplicate | ignored | mismatch."""
    if db.scalar(select(PaymentEvent.id).where(PaymentEvent.provider_event_id == event.event_id)):
        return "duplicate"
    payment = db.scalar(select(Payment).where(Payment.provider == provider_key, Payment.reference == event.reference))
    if payment is None:
        return "ignored"
    target = {"paid": "verified", "failed": "failed", "expired": "expired"}[event.status]
    if target == "verified" and (event.amount != payment.amount or event.currency != payment.currency):
        # Money arrived but not the amount we asked for. Never auto-verify; leave it for the creator.
        db.add(
            PaymentEvent(
                payment_id=payment.id, actor="provider", from_status=payment.status, to_status=payment.status,
                note=f"Amount mismatch: provider says {event.amount} {event.currency}, expected {payment.amount} {payment.currency}",
                provider_event_id=event.event_id,
            )
        )
        db.commit()
        return "mismatch"
    try:
        transition(db, payment, target, "provider", f"Provider event {event.status}", event.event_id)
        db.commit()
    except IntegrityError:  # same event delivered twice at the same time
        db.rollback()
        return "duplicate"
    except PaymentError:
        db.rollback()
        return "ignored"
    return "applied"


__all__ = [
    "ACTIVE_STATUSES", "PINNING_STATUSES", "PaymentError", "ALLOWED", "transition", "create_payment",
    "mark_paid_by_payer", "apply_provider_event", "expire_stale", "for_bill", "pinned_amounts", "live_payment",
]
