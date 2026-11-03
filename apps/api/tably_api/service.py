"""Bill state and claim logic. The server is the only place totals are calculated."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from .models import Bill, Claim, Item, Participant, Transfer
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

    Per item: exclusive units are priced per unit; the remaining units form a pool split equally among
    the people sharing it (or stay unclaimed). Discounts, tax, service and tip are then split in proportion
    to each person's item subtotal, with the unclaimed subtotal as a bucket, so what someone owes does not
    move when other people claim more. Creator transfers then move money between people without changing
    the bill total. Every split sums exactly.
    """
    people = list(bill.participants)
    index = {p.id: n for n, p in enumerate(people)}
    held: dict[str, dict[str, Claim]] = {}
    for c in claims:
        if c.participant_id in index:
            held.setdefault(c.item_id, {})[c.participant_id] = c

    base = [0] * len(people)
    unassigned_base = 0
    items_out = []
    for it in bill.items:
        holders = held.get(it.id, {})
        excl = [(holders[p.id].units if p.id in holders and not holders[p.id].shared else 0) for p in people]
        sharers = [n for n, p in enumerate(people) if p.id in holders and holders[p.id].shared]
        pool_units = it.quantity - sum(excl)
        shares = allocate(it.line_total, excl + [pool_units])
        for n, s in enumerate(shares[:-1]):
            base[n] += s
        pool_amount = shares[-1]
        if sharers:
            for n, s in zip(sharers, allocate(pool_amount, [1] * len(sharers))):
                base[n] += s
        else:
            unassigned_base += pool_amount
        items_out.append(
            {
                "id": it.id,
                "description": it.description,
                "quantity": it.quantity,
                "line_total": it.line_total,
                "exclusive": sum(excl),
                "remaining": 0 if sharers else pool_units,
                "claims": [
                    {"participant_id": pid, "units": c.units, "shared": c.shared} for pid, c in holders.items()
                ],
            }
        )

    weights = base + [unassigned_base]
    extras = _extras(bill)
    parts: dict[str, list[int]] = {}
    for kind, amount in extras.items():
        parts[kind] = allocate(amount, weights) if amount and sum(weights) > 0 else [0] * len(weights)

    totals = [base[n] + sum(parts[k][n] for k in extras) for n in range(len(people))]
    adjustment = [0] * len(people)
    transfers_out = []
    for t in bill.transfers:
        a, b = index.get(t.payer_id), index.get(t.beneficiary_id)
        if a is None or b is None:
            continue
        moved = max(0, min(t.amount, totals[b]))  # cannot relieve someone of more than they owe
        totals[a] += moved
        totals[b] -= moved
        adjustment[a] += moved
        adjustment[b] -= moved
        transfers_out.append(
            {"id": t.id, "payer_id": t.payer_id, "beneficiary_id": t.beneficiary_id, "amount": moved, "note": t.note}
        )

    items_sum = sum(i.line_total for i in bill.items)
    participants_out = []
    for n, p in enumerate(people):
        row = {"id": p.id, "name": p.name, "items_total": base[n]}
        row.update({k: parts[k][n] for k in extras})
        row["adjustment"] = adjustment[n]
        row["total"] = totals[n]
        participants_out.append(row)

    assigned = sum(totals)
    total = items_sum + sum(extras.values())
    return {
        "items": items_out,
        "participants": participants_out,
        "transfers": transfers_out,
        "totals": {"items": items_sum, **extras, "total": total, "assigned": assigned, "unassigned": total - assigned},
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


def bump(db: Session, bill_id: str) -> None:
    db.execute(update(Bill).where(Bill.id == bill_id).values(version=Bill.version + 1))


def set_claim(
    db: Session, bill: Bill, participant: Participant, item_id: str, units: int | None = None, share: bool | None = None
) -> None:
    """Atomically change one participant's hold on an item.

    `units=n` holds n whole units (0 releases). `share=True` takes a seat in the item's shared pool,
    `share=False` leaves it. The item row is locked (SELECT ... FOR UPDATE; BEGIN IMMEDIATE on SQLite) so
    concurrent changes to the same item are serialized and the capacity checks cannot be raced.

    Capacity: exclusive units across everyone never exceed the quantity, and when anyone shares, at least
    one unit stays in the pool so sharers are never left holding nothing.
    """
    item = db.execute(
        select(Item).where(Item.id == item_id, Item.bill_id == bill.id).with_for_update()
    ).scalar_one_or_none()
    if item is None:
        raise LookupError("item")

    others_excl = db.scalar(
        select(func.coalesce(func.sum(Claim.units), 0)).where(
            Claim.item_id == item_id, Claim.participant_id != participant.id, Claim.shared.is_(False)
        )
    )
    other_sharers = db.scalar(
        select(func.count()).select_from(Claim).where(
            Claim.item_id == item_id, Claim.participant_id != participant.id, Claim.shared.is_(True)
        )
    )
    existing = db.get(Claim, (participant.id, item_id))

    if share is True:
        if item.quantity - others_excl < 1:
            db.rollback()
            raise ClaimConflict(available=0)
        if existing:
            existing.shared, existing.units = True, 0
        else:
            db.add(Claim(participant_id=participant.id, item_id=item_id, units=0, shared=True))
    elif units:
        cap = item.quantity - others_excl - (1 if other_sharers else 0)
        if units > cap:
            db.rollback()
            raise ClaimConflict(available=max(cap, 0))
        if existing:
            existing.shared, existing.units = False, units
        else:
            db.add(Claim(participant_id=participant.id, item_id=item_id, units=units, shared=False))
    elif existing and (units == 0 or (share is False and existing.shared)):
        db.execute(delete(Claim).where(Claim.participant_id == participant.id, Claim.item_id == item_id))

    bump(db, bill.id)
    db.commit()
