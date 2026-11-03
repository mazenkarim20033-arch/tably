"""Creator-side management of a bill: edit the receipt, manage people, close, remind, summarize."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import service, views
from .db import get_db
from .models import Bill, Claim, Item, Participant
from .money import extras_total
from .ratelimit import limit
from .routes import _admin_bill, _pinned_ids
from .schemas import BillEdit, ClaimSet, CloseBody, ParticipantCreate, ReminderLog, SummaryRequest
from .security import hash_token, new_token, token_matches

manage = APIRouter(prefix="/api/bills", tags=["manage"])


def _open_bill(bill: Bill) -> None:
    if bill.status != "open":
        raise HTTPException(409, {"code": "closed", "message": "This bill is closed. Reopen it to make changes."})


def _not_locked(bill: Bill, db: Session) -> None:
    if _pinned_ids(db, bill):
        raise HTTPException(
            409,
            {
                "code": "locked",
                "message": "Someone has started or finished paying, so the receipt can no longer be edited. "
                "Use an adjustment to move money between people instead.",
            },
        )


# ---------- receipt ----------

@manage.patch("/{bill_id}/receipt", dependencies=[Depends(limit("edit", 60, 3600))])
def edit_receipt(bill_id: str, body: BillEdit, x_admin_token: str | None = Header(default=None),
                 db: Session = Depends(get_db)):
    """Edit an unfinalized receipt. Blocked once any payment has started; after that, use adjustments."""
    bill = _admin_bill(db, bill_id, x_admin_token)
    _open_bill(bill)
    _not_locked(bill, db)

    items_sum = sum(i.line_total for i in body.items)
    computed = items_sum + extras_total(body.discounts, body.tax, body.service, body.tip, body.tax_included)
    if items_sum <= 0 or computed <= 0:
        raise HTTPException(422, "The bill total must be greater than zero.")
    if body.printed_total is not None and body.printed_total != computed and not body.accept_mismatch:
        raise HTTPException(
            422,
            {"code": "mismatch", "computed_total": computed, "printed_total": body.printed_total,
             "message": "Items do not add up to the receipt total."},
        )

    existing = {i.id: i for i in bill.items}
    seen: set[str] = set()
    for n, e in enumerate(body.items):
        if e.id is not None:
            if e.id not in existing or e.id in seen:
                raise HTTPException(422, "Unknown or repeated item.")
            seen.add(e.id)
            it = existing[e.id]
            it.description, it.quantity, it.line_total, it.position = e.description, e.quantity, e.line_total, n
        else:
            bill.items.append(Item(position=n, description=e.description, quantity=e.quantity, line_total=e.line_total))
    for item_id, it in existing.items():
        if item_id not in seen:
            bill.items.remove(it)  # its claims go with it

    bill.store, bill.receipt_date = body.store, body.receipt_date
    bill.discounts, bill.tax, bill.service, bill.tip = body.discounts, body.tax, body.service, body.tip
    bill.tax_included, bill.printed_total = body.tax_included, body.printed_total
    db.flush()

    # Existing claims must still fit the edited quantities; otherwise the creator fixes assignments first.
    conflicts = []
    for it in bill.items:
        rows = list(db.scalars(select(Claim).where(Claim.item_id == it.id)))
        excl = sum(c.units for c in rows if not c.shared)
        if excl > it.quantity - (1 if any(c.shared for c in rows) else 0):
            conflicts.append(it.description)
    if conflicts:
        db.rollback()
        raise HTTPException(
            409,
            {"code": "claims_conflict", "items": conflicts,
             "message": "More of these are claimed than the new quantity: " + ", ".join(conflicts)
             + ". Change who has what first."},
        )
    service.bump(db, bill.id)
    db.commit()
    db.refresh(bill)
    return views.admin_view(bill, db)


# ---------- people ----------

def _person(db: Session, bill: Bill, pid: str) -> Participant:
    p = db.get(Participant, pid)
    if p is None or p.bill_id != bill.id:
        raise HTTPException(404, "Person not found.")
    return p


@manage.post("/{bill_id}/participants", status_code=201, dependencies=[Depends(limit("people", 60, 3600))])
def add_person(bill_id: str, body: ParticipantCreate, x_admin_token: str | None = Header(default=None),
               db: Session = Depends(get_db)):
    """Add someone who is not using the link; the creator assigns their items for them."""
    bill = _admin_bill(db, bill_id, x_admin_token)
    _open_bill(bill)
    if len(bill.participants) >= 50:
        raise HTTPException(409, "This bill has too many people.")
    if any(p.name_key == body.name.casefold() for p in bill.participants):
        raise HTTPException(409, "Someone already uses that name on this bill.")
    # No usable secret is handed out, so only the creator can change this person's selections.
    db.add(Participant(bill_id=bill.id, name=body.name, name_key=body.name.casefold(),
                       secret_hash=hash_token(new_token(32))))
    service.bump(db, bill.id)
    db.commit()
    db.refresh(bill)
    return views.admin_view(bill, db)


@manage.delete("/{bill_id}/participants/{pid}")
def remove_person(bill_id: str, pid: str, x_admin_token: str | None = Header(default=None),
                  db: Session = Depends(get_db)):
    bill = _admin_bill(db, bill_id, x_admin_token)
    _open_bill(bill)
    p = _person(db, bill, pid)
    if p.id in _pinned_ids(db, bill):
        raise HTTPException(
            409,
            {"code": "locked", "message": "This person has started or finished paying. Reject or cancel their payment first."},
        )
    # Their claims, any adjustments involving them and past payment attempts go with them.
    db.execute(Claim.__table__.delete().where(Claim.participant_id == p.id))
    for t in list(bill.transfers):
        if pid in (t.payer_id, t.beneficiary_id):
            bill.transfers.remove(t)
    bill.participants.remove(p)
    service.bump(db, bill.id)
    db.commit()
    db.refresh(bill)
    return views.admin_view(bill, db)


@manage.put("/{bill_id}/participants/{pid}/claims", dependencies=[Depends(limit("assign", 240, 3600))])
def assign_for_person(bill_id: str, pid: str, body: ClaimSet, x_admin_token: str | None = Header(default=None),
                      db: Session = Depends(get_db)):
    """Creator corrects an assignment on someone's behalf. Same capacity and lock rules as the person's own change."""
    bill = _admin_bill(db, bill_id, x_admin_token)
    _open_bill(bill)
    p = _person(db, bill, pid)
    try:
        service.set_claim(db, bill, p, body.item_id, units=body.units, share=body.share,
                          locked_ids=_pinned_ids(db, bill))
    except service.ClaimLocked:
        raise HTTPException(409, {"code": "locked", "message": "Payment for this has started, so it can't change."})
    except LookupError:
        raise HTTPException(404, "Item not found.")
    except service.ClaimConflict as e:
        raise HTTPException(409, {"code": "taken", "available": e.available, "message": "Not enough left of that item."})
    db.refresh(bill)
    return views.admin_view(bill, db)


# ---------- closing ----------

def _settled(view: dict) -> tuple[bool, str]:
    people = view["participants"]
    if not people:
        return False, "Nobody has joined this bill yet."
    if view["totals"]["unassigned"] != 0:
        return False, "Some of the bill is still unclaimed."
    unpaid = [p["name"] for p in people if p["total"] > 0 and (p["payment"] or {}).get("status") != "verified"]
    if unpaid:
        return False, "Not confirmed paid yet: " + ", ".join(unpaid) + "."
    return True, ""


@manage.post("/{bill_id}/close")
def close_bill(bill_id: str, body: CloseBody, x_admin_token: str | None = Header(default=None),
               db: Session = Depends(get_db)):
    bill = _admin_bill(db, bill_id, x_admin_token)
    if bill.status == "closed":
        return views.admin_view(bill, db)
    ok, why = _settled(views.public_view(bill, db))
    if not ok and not body.force:
        raise HTTPException(409, {"code": "unsettled", "message": why})
    bill.status = "closed"
    service.bump(db, bill.id)
    db.commit()
    return views.admin_view(bill, db)


@manage.post("/{bill_id}/reopen")
def reopen_bill(bill_id: str, x_admin_token: str | None = Header(default=None), db: Session = Depends(get_db)):
    bill = _admin_bill(db, bill_id, x_admin_token)
    bill.status = "open"
    service.bump(db, bill.id)
    db.commit()
    return views.admin_view(bill, db)


# ---------- reminders ----------

@manage.post("/{bill_id}/reminders", dependencies=[Depends(limit("remind", 120, 3600))])
def log_reminders(bill_id: str, body: ReminderLog, x_admin_token: str | None = Header(default=None),
                  db: Session = Depends(get_db)):
    """Record that the creator sent reminders. TABLY sends nothing itself: no SMS or push is available, so the
    app opens the share sheet (WhatsApp, iMessage...) and the creator sends the message."""
    bill = _admin_bill(db, bill_id, x_admin_token)
    ids = set(body.participant_ids)
    now = datetime.now(timezone.utc)
    for p in bill.participants:
        if p.id in ids:
            p.last_reminded_at = now
            p.reminder_count = (p.reminder_count or 0) + 1
    db.commit()
    return views.admin_view(bill, db)


# ---------- history ----------

@manage.post("/summaries", dependencies=[Depends(limit("summaries", 60, 600))])
def summaries(body: SummaryRequest, db: Session = Depends(get_db)):
    """One-call history for the phone: it sends the admin tokens it holds and gets one line per bill."""
    out = []
    for ref in body.bills:
        bill = db.get(Bill, ref.get("id", ""))
        if bill is None or not token_matches(ref.get("admin_token"), bill.admin_token_hash):
            out.append({"id": ref.get("id"), "missing": True})
            continue
        v = views.public_view(bill, db)
        t = v["totals"]
        out.append({
            "id": bill.id, "store": bill.store, "date": bill.receipt_date, "currency": bill.currency,
            "status": bill.status, "total": t["total"], "collected": t["collected"], "outstanding": t["outstanding"],
            "people": len(v["participants"]),
            "waiting": sum(1 for p in v["participants"] if (p["payment"] or {}).get("status") == "awaiting_confirmation"),
            "link_disabled": bill.share_disabled,
        })
    return {"bills": out}
