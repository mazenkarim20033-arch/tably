from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import service
from .config import get_settings
from .db import get_db
from .models import Bill, Item, Participant
from .money import extras_total
from .ratelimit import limit
from .schemas import BillCreate, ClaimSet, LinkUpdate, ParticipantCreate
from .security import hash_token, new_token, token_matches

bills = APIRouter(prefix="/api/bills", tags=["creator"])
public = APIRouter(prefix="/api/s", tags=["shared"])

MAX_PARTICIPANTS = 50
IMAGE_TYPES = {b"\xff\xd8\xff": "jpg", b"\x89PNG": "png"}


# ---------- helpers ----------

def _admin_bill(db: Session, bill_id: str, x_admin_token: str | None) -> Bill:
    bill = db.get(Bill, bill_id)
    # Same answer for "no such bill" and "wrong token" so ids cannot be probed.
    if bill is None or not token_matches(x_admin_token, bill.admin_token_hash):
        raise HTTPException(404, "Bill not found.")
    return bill


def _shared_bill(db: Session, token: str) -> Bill:
    bill = db.scalar(select(Bill).where(Bill.share_token == token))
    if bill is None:
        raise HTTPException(404, "Bill not found.")
    problem = service.link_problem(bill)
    if problem:
        raise HTTPException(*problem)
    return bill


def _public_view(bill: Bill, db: Session) -> dict:
    state = service.compute_state(bill, service.load_claims(db, bill))
    return {
        "store": bill.store,
        "date": bill.receipt_date,
        "currency": bill.currency,
        "status": bill.status,
        **state,
    }


# ---------- creator ----------

@bills.post("", status_code=201, dependencies=[Depends(limit("create", 20, 3600))])
def create_bill(body: BillCreate, db: Session = Depends(get_db)):
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
    admin_token = new_token(32)
    bill = Bill(
        store=body.store, receipt_date=body.receipt_date, currency=body.currency,
        discounts=body.discounts, tax=body.tax, service=body.service, tip=body.tip,
        tax_included=body.tax_included, printed_total=body.printed_total,
        share_token=new_token(24), admin_token_hash=hash_token(admin_token),
        share_expires_at=datetime.now(timezone.utc) + timedelta(days=get_settings().share_link_days),
        items=[Item(position=n, description=i.description, quantity=i.quantity, line_total=i.line_total)
               for n, i in enumerate(body.items)],
    )
    db.add(bill)
    db.commit()
    return {"id": bill.id, "share_token": bill.share_token, "admin_token": admin_token,
            "share_expires_at": bill.share_expires_at}


@bills.get("/{bill_id}")
def admin_view(bill_id: str, x_admin_token: str | None = Header(default=None), db: Session = Depends(get_db)):
    bill = _admin_bill(db, bill_id, x_admin_token)
    return {
        **_public_view(bill, db),
        "id": bill.id,
        "share_token": bill.share_token,
        "share_disabled": bill.share_disabled,
        "share_expires_at": bill.share_expires_at,
        "printed_total": bill.printed_total,
        "tax_included": bill.tax_included,
        "has_image": bool(bill.image_path),
        "created_at": bill.created_at,
    }


@bills.post("/{bill_id}/link", dependencies=[Depends(limit("link", 60, 3600))])
def update_link(bill_id: str, body: LinkUpdate, x_admin_token: str | None = Header(default=None),
                db: Session = Depends(get_db)):
    bill = _admin_bill(db, bill_id, x_admin_token)
    if body.disabled is not None:
        bill.share_disabled = body.disabled
    if body.rotate:
        bill.share_token = new_token(24)  # old link stops working immediately
    if body.extend_days:
        bill.share_expires_at = datetime.now(timezone.utc) + timedelta(days=body.extend_days)
    db.commit()
    return {"share_token": bill.share_token, "share_disabled": bill.share_disabled,
            "share_expires_at": bill.share_expires_at}


@bills.post("/{bill_id}/image", status_code=204, dependencies=[Depends(limit("image", 20, 3600))])
async def upload_image(bill_id: str, file: UploadFile, x_admin_token: str | None = Header(default=None),
                       db: Session = Depends(get_db)):
    bill = _admin_bill(db, bill_id, x_admin_token)
    cfg = get_settings()
    data = await file.read(cfg.max_upload_bytes + 1)
    if len(data) > cfg.max_upload_bytes:
        raise HTTPException(413, "Image is too large.")
    ext = next((e for magic, e in IMAGE_TYPES.items() if data.startswith(magic)), None)
    if ext is None:
        raise HTTPException(415, "Only JPEG and PNG images are accepted.")
    folder = Path(cfg.upload_dir)
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{bill.id}.{ext}"  # server-generated; the client filename is never used
    (folder / name).write_bytes(data)
    bill.image_path = name
    db.commit()
    return Response(status_code=204)


@bills.get("/{bill_id}/image")
def get_image(bill_id: str, x_admin_token: str | None = Header(default=None), db: Session = Depends(get_db)):
    bill = _admin_bill(db, bill_id, x_admin_token)
    if not bill.image_path:
        raise HTTPException(404, "No image.")
    return FileResponse(Path(get_settings().upload_dir) / bill.image_path)


# ---------- participants (public link) ----------

@public.get("/{token}", dependencies=[Depends(limit("view", 600, 60))])
def view(token: str, db: Session = Depends(get_db)):
    return _public_view(_shared_bill(db, token), db)


@public.post("/{token}/participants", status_code=201, dependencies=[Depends(limit("join", 20, 600))])
def join(token: str, body: ParticipantCreate, db: Session = Depends(get_db)):
    bill = _shared_bill(db, token)
    if bill.status != "open":
        raise HTTPException(409, "This bill is closed.")
    if len(bill.participants) >= MAX_PARTICIPANTS:
        raise HTTPException(409, "This bill has too many people.")
    secret = new_token(24)
    p = Participant(bill_id=bill.id, name=body.name, name_key=body.name.casefold(), secret_hash=hash_token(secret))
    db.add(p)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Someone already uses that name on this bill. Try adding an initial.")
    # The secret is shown once; it lets this browser edit only this person's selections.
    return {"participant_id": p.id, "participant_token": secret, "name": p.name}


@public.put("/{token}/claims", dependencies=[Depends(limit("claim", 240, 60))])
def set_claim(token: str, body: ClaimSet, x_participant_token: str | None = Header(default=None),
              x_participant_id: str | None = Header(default=None), db: Session = Depends(get_db)):
    bill = _shared_bill(db, token)
    if bill.status != "open":
        raise HTTPException(409, "This bill is closed.")
    p = db.get(Participant, x_participant_id) if x_participant_id else None
    if p is None or p.bill_id != bill.id or not token_matches(x_participant_token, p.secret_hash):
        raise HTTPException(401, "Join the bill first.")
    try:
        service.set_claim(db, bill, p, body.item_id, body.units)
    except LookupError:
        raise HTTPException(404, "Item not found.")
    except service.ClaimConflict as e:
        db.rollback()
        raise HTTPException(
            409, {"code": "taken", "available": e.available, "message": "Someone else already took that."}
        )
    db.refresh(bill)
    return _public_view(bill, db)
