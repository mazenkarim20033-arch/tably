"""Bill state and claim logic. The server is the only place totals are calculated."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .models import Bill, Claim, Item, Participant
from .money import allocate


class ClaimConflict(Exception):
    def __init__(self, available: int):
        self.available = available


def _extras(bill: Bill) -> dict[str, int]:
    inc = bill.tax_included
    return {
        "discounts": bill.discounts,
        "tax": 0 if inc else bill.tax,
        "service": 0 if inc else bill.service,
        "tip": bill.tip,
    }


def compute_state(bill: Bill, claims: list[Claim]) -> dict:
    """Per-item holders, per-participant totals and bill totals.

    Each item's line total is split by claimed units (plus an "unclaimed" bucket). Discounts, tax, service and
    tip are then split in proportion to each person's item subtotal, with the unclaimed subtotal as a bucket
    too, so what someone owes does not move when other people claim more. Every split sums exactly.
    """
    people = list(bill.participants)
    index = {p.id: n for n, p in enumerate(people)}
    held: dict[str, dict[str, int]] = defaultdict(dict)  # item_id -> {participant_id: units}
    for c in claims:
        if c.participant_id in index:
            held[c.item_id][c.participant_id] = c.units

    base = [0] * len(people)
    unassigned_base = 0
    items_out = []
    for it in bill.items:
        holders = held.get(it.id, {})
        units = [holders.get(p.id, 0) for p in people]
        left = it.quantity - sum(units)
        shares = allocate(it.line_total, units + [left])
        for n, s in enumerate(shares[:-1]):
            base[n] += s
        unassigned_base += shares[-1]
        items_out.append(
            {
                "id": it.id,
                "description": it.description,
                "quantity": it.quantity,
                "line_total": it.line_total,
                "remaining": left,
                "claims": [{"participant_id": pid, "units": u} for pid, u in holders.items() if u > 0],
            }
        )

    weights = base + [unassigned_base]
    extras = _extras(bill)
    parts: dict[str, list[int]] = {}
    for kind, amount in extras.items():
        parts[kind] = allocate(amount, weights) if amount and sum(weights) > 0 else [0] * len(weights)

    items_sum = sum(i.line_total for i in bill.items)
    participants_out = []
    assigned = 0
    for n, p in enumerate(people):
        row = {"id": p.id, "name": p.name, "items_total": base[n]}
        row.update({k: parts[k][n] for k in extras})
        row["total"] = base[n] + sum(parts[k][n] for k in extras)
        assigned += row["total"]
        participants_out.append(row)

    total = items_sum + sum(extras.values())
    return {
        "items": items_out,
        "participants": participants_out,
        "totals": {
            "items": items_sum,
            **extras,
            "total": total,
            "assigned": assigned,
            "unassigned": total - assigned,
        },
    }


def load_claims(db: Session, bill: Bill) -> list[Claim]:
    ids = [i.id for i in bill.items]
    if not ids:
        return []
    return list(db.scalars(select(Claim).where(Claim.item_id.in_(ids))))


def link_problem(bill: Bill) -> tuple[int, str] | None:
    if bill.share_disabled:
        return 403, "This link has been turned off by the person who created the bill."
    exp = bill.share_expires_at
    if exp is not None:
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp <= datetime.now(timezone.utc):
            return 410, "This link has expired."
    return None


def set_claim(db: Session, bill: Bill, participant: Participant, item_id: str, units: int) -> None:
    """Atomically set how many units of an item a participant holds (0 releases it).

    The item row is locked (SELECT ... FOR UPDATE; BEGIN IMMEDIATE on SQLite) so concurrent claims on the
    same item are serialized and the capacity check cannot be raced.
    """
    item = db.execute(
        select(Item).where(Item.id == item_id, Item.bill_id == bill.id).with_for_update()
    ).scalar_one_or_none()
    if item is None:
        raise LookupError("item")
    others = db.scalar(
        select(func.coalesce(func.sum(Claim.units), 0)).where(
            Claim.item_id == item_id, Claim.participant_id != participant.id
        )
    )
    if others + units > item.quantity:
        db.rollback()
        raise ClaimConflict(available=item.quantity - others)
    existing = db.get(Claim, (participant.id, item_id))
    if units == 0:
        if existing:
            db.execute(delete(Claim).where(Claim.participant_id == participant.id, Claim.item_id == item_id))
    elif existing:
        existing.units = units
    else:
        db.add(Claim(participant_id=participant.id, item_id=item_id, units=units))
    db.commit()
