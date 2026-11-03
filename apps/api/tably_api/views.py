"""Builds the JSON the creator and the shared page see, from bill + claims + payments."""

from __future__ import annotations

from sqlalchemy.orm import Session

from . import payments, service
from .models import Bill, Payment
from .providers import PROVIDERS


def _summary(p: Payment | None) -> dict | None:
    if p is None:
        return None
    return {"id": p.id, "status": p.status, "amount": p.amount, "reference": p.reference, "provider": p.provider}


def _relevant(pays: list[Payment]) -> dict[str, Payment]:
    """Per participant: the verified payment, else the live one, else the most recent attempt."""
    best: dict[str, Payment] = {}
    rank = {"verified": 3, "awaiting_confirmation": 2, "initiated": 2}
    for p in pays:  # ordered oldest to newest
        cur = best.get(p.participant_id)
        if cur is None or rank.get(p.status, 1) >= rank.get(cur.status, 1):
            best[p.participant_id] = p
    return best


def public_view(bill: Bill, db: Session) -> dict:
    payments.expire_stale(db, bill)
    pays = payments.for_bill(db, bill)
    state = service.compute_state(bill, service.load_claims(db, bill), payments.pinned_amounts(pays))
    best = _relevant(pays)
    for row in state["participants"]:
        row["payment"] = _summary(best.get(row["id"]))
    collected = sum(p.amount for p in pays if p.status == "verified")
    awaiting = sum(p.amount for p in pays if p.status == "awaiting_confirmation")
    totals = state["totals"]
    totals.update({"collected": collected, "awaiting": awaiting, "outstanding": totals["total"] - collected})
    methods = []
    for prov in PROVIDERS.values():
        a = prov.availability(bill)
        methods.append({"key": prov.key, "label": prov.label, "automated": prov.automated,
                        "enabled": a.enabled, "reason": a.reason})
    has_payee = bool(bill.instapay_address or bill.instapay_phone or bill.instapay_link)
    return {
        "store": bill.store, "date": bill.receipt_date, "currency": bill.currency, "status": bill.status,
        **state,
        "payee": {
            "name": bill.payee_name, "instapay_address": bill.instapay_address,
            "instapay_phone": bill.instapay_phone, "instapay_link": bill.instapay_link,
        } if has_payee else None,
        "payment_methods": methods,
    }


def admin_view(bill: Bill, db: Session) -> dict:
    view = public_view(bill, db)
    names = {p.id: p.name for p in bill.participants}
    reminders = {p.id: (p.last_reminded_at, p.reminder_count or 0) for p in bill.participants}
    for row in view["participants"]:
        row["last_reminded_at"], row["reminder_count"] = reminders.get(row["id"], (None, 0))
    pays = payments.for_bill(db, bill)
    return {
        **view,
        "id": bill.id,
        "share_token": bill.share_token,
        "share_disabled": bill.share_disabled,
        "share_expires_at": bill.share_expires_at,
        "printed_total": bill.printed_total,
        "tax_included": bill.tax_included,
        # Raw receipt figures, so an edit screen can show them even when tax is included in prices.
        "receipt": {"discounts": bill.discounts, "tax": bill.tax, "service": bill.service, "tip": bill.tip},
        "has_image": bill.image is not None,
        "created_at": bill.created_at,
        "payments": [
            {
                **_summary(p), "participant_id": p.participant_id, "participant_name": names.get(p.participant_id, "?"),
                "payer_note": p.payer_note, "created_at": p.created_at,
                "events": [
                    {"at": e.at, "actor": e.actor, "from": e.from_status, "to": e.to_status, "note": e.note}
                    for e in p.events
                ],
            }
            for p in pays
        ],
    }
