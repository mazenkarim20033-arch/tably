import asyncio
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import service
from .config import get_settings
from .db import SessionLocal, get_db
from . import payments, views
from .models import Bill, Item, Participant, Payment, ReceiptImage, Transfer
from .money import extras_total
from .providers import PROVIDERS, NotImplementedProvider, WebhookRejected
from .ratelimit import limit
from .schemas import (
    BillCreate, ClaimSet, LinkUpdate, PaidBody, ParticipantCreate, PaymentCreate, PayeeIn, ReviewBody, TransferCreate,
)
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
    return views.public_view(bill, db)


def _pinned_ids(db: Session, bill: Bill) -> frozenset[str]:
    return frozenset(payments.pinned_amounts(payments.for_bill(db, bill)))


def _participant(db: Session, bill: Bill, pid: str | None, secret: str | None) -> Participant:
    p = db.get(Participant, pid) if pid else None
    if p is None or p.bill_id != bill.id or not token_matches(secret, p.secret_hash):
        raise HTTPException(401, "Join the bill first.")
    return p


def _payment_error(e: payments.PaymentError) -> HTTPException:
    detail = {"code": e.code, "message": e.message} if e.code else e.message
    return HTTPException(e.status, detail)


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
    if body.payee:
        _apply_payee(bill, body.payee)
    db.add(bill)
    db.commit()
    return {"id": bill.id, "share_token": bill.share_token, "admin_token": admin_token,
            "share_expires_at": bill.share_expires_at}


@bills.get("/{bill_id}")
def admin_view(bill_id: str, x_admin_token: str | None = Header(default=None), db: Session = Depends(get_db)):
    return views.admin_view(_admin_bill(db, bill_id, x_admin_token), db)


def _apply_payee(bill: Bill, payee) -> None:
    bill.payee_name = payee.payee_name
    bill.instapay_address = payee.instapay_address
    bill.instapay_phone = payee.instapay_phone
    bill.instapay_link = payee.instapay_link


@bills.put("/{bill_id}/payee", dependencies=[Depends(limit("payee", 30, 3600))])
def update_payee(bill_id: str, body: PayeeIn, x_admin_token: str | None = Header(default=None),
                 db: Session = Depends(get_db)):
    bill = _admin_bill(db, bill_id, x_admin_token)
    if _pinned_ids(db, bill):
        # Changing where money goes after someone started paying would misdirect or confuse them.
        raise HTTPException(409, "Someone has already started paying. Payment details can no longer change.")
    _apply_payee(bill, body)
    service.bump(db, bill.id)
    db.commit()
    return views.admin_view(bill, db)


def _review(bill_id: str, payment_id: str, to: str, note: str, x_admin_token: str | None, db: Session):
    bill = _admin_bill(db, bill_id, x_admin_token)
    p = db.get(Payment, payment_id)
    if p is None or p.bill_id != bill.id:
        raise HTTPException(404, "Payment not found.")
    try:
        payments.transition(db, p, to, "creator", note or ("Confirmed by the bill creator" if to == "verified" else "Rejected by the bill creator"))
        db.commit()
    except payments.PaymentError as e:
        db.rollback()
        raise _payment_error(e)
    return views.admin_view(bill, db)


@bills.post("/{bill_id}/payments/{payment_id}/confirm", dependencies=[Depends(limit("review", 120, 3600))])
def confirm_payment(bill_id: str, payment_id: str, body: ReviewBody, x_admin_token: str | None = Header(default=None),
                    db: Session = Depends(get_db)):
    """Manual reconciliation: the creator checked their own bank and saw the money arrive."""
    return _review(bill_id, payment_id, "verified", body.note, x_admin_token, db)


@bills.post("/{bill_id}/payments/{payment_id}/reject", dependencies=[Depends(limit("review", 120, 3600))])
def reject_payment(bill_id: str, payment_id: str, body: ReviewBody, x_admin_token: str | None = Header(default=None),
                   db: Session = Depends(get_db)):
    return _review(bill_id, payment_id, "failed", body.note, x_admin_token, db)


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
    kind = next((t for magic, t in IMAGE_TYPES.items() if data.startswith(magic)), None)
    if kind is None:
        raise HTTPException(415, "Only JPEG and PNG images are accepted.")
    content_type = "image/jpeg" if kind == "jpg" else "image/png"  # decided here, never taken from the client
    if bill.image is None:
        bill.image = ReceiptImage(content_type=content_type, data=data)
    else:
        bill.image.content_type, bill.image.data = content_type, data
    db.commit()
    return Response(status_code=204)


@bills.get("/{bill_id}/image")
def get_image(bill_id: str, x_admin_token: str | None = Header(default=None), db: Session = Depends(get_db)):
    bill = _admin_bill(db, bill_id, x_admin_token)
    if bill.image is None:
        raise HTTPException(404, "No image.")
    return Response(content=bill.image.data, media_type=bill.image.content_type,
                    headers={"Content-Disposition": "inline", "Cache-Control": "private, no-store"})


@bills.post("/{bill_id}/transfers", status_code=201, dependencies=[Depends(limit("transfer", 60, 3600))])
def add_transfer(bill_id: str, body: TransferCreate, x_admin_token: str | None = Header(default=None),
                 db: Session = Depends(get_db)):
    bill = _admin_bill(db, bill_id, x_admin_token)
    ids = {p.id for p in bill.participants}
    if body.payer_id == body.beneficiary_id or not {body.payer_id, body.beneficiary_id} <= ids:
        raise HTTPException(422, "Pick two different people on this bill.")
    if {body.payer_id, body.beneficiary_id} & _pinned_ids(db, bill):
        raise HTTPException(409, "One of them has already started paying, so their amount is locked.")
    t = Transfer(bill_id=bill.id, payer_id=body.payer_id, beneficiary_id=body.beneficiary_id,
                 amount=body.amount, note=body.note)
    db.add(t)
    service.bump(db, bill.id)
    db.commit()
    return _public_view(bill, db)


@bills.delete("/{bill_id}/transfers/{transfer_id}")
def remove_transfer(bill_id: str, transfer_id: str, x_admin_token: str | None = Header(default=None),
                    db: Session = Depends(get_db)):
    bill = _admin_bill(db, bill_id, x_admin_token)
    t = db.get(Transfer, transfer_id)
    if t is None or t.bill_id != bill.id:
        raise HTTPException(404, "Adjustment not found.")
    if {t.payer_id, t.beneficiary_id} & _pinned_ids(db, bill):
        raise HTTPException(409, "Someone involved has already started paying, so this is locked.")
    db.delete(t)
    service.bump(db, bill.id)
    db.commit()
    db.refresh(bill)
    return _public_view(bill, db)


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
        service.bump(db, bill.id)
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
    p = _participant(db, bill, x_participant_id, x_participant_token)
    try:
        service.set_claim(db, bill, p, body.item_id, units=body.units, share=body.share,
                          locked_ids=_pinned_ids(db, bill))
    except service.ClaimLocked:
        raise HTTPException(
            409, {"code": "locked", "message": "Payment for this has started, so it can't change. Ask the bill creator."}
        )
    except LookupError:
        raise HTTPException(404, "Item not found.")
    except service.ClaimConflict as e:
        db.rollback()
        raise HTTPException(
            409, {"code": "taken", "available": e.available, "message": "Someone else already took that."}
        )
    db.refresh(bill)
    return _public_view(bill, db)


@public.get("/{token}/events", dependencies=[Depends(limit("events", 30, 60))])
async def events(token: str, request: Request):
    """Server-Sent Events: tells the page when the bill changed so it can refetch.

    It watches Bill.version in the database, so it works across several server instances with no extra
    infrastructure. Each connection costs one tiny query per poll interval.
    """
    cfg = get_settings()

    def read_version() -> int | None:
        with SessionLocal() as db:
            bill = db.scalar(select(Bill).where(Bill.share_token == token))
            if bill is None or service.link_problem(bill):
                return None
            return bill.version

    first = await run_in_threadpool(read_version)
    if first is None:
        raise HTTPException(404, "Bill not found.")

    async def stream():
        last = first
        started = last_sent = time.monotonic()
        yield f"retry: 3000\nevent: ready\ndata: {last}\n\n"
        while time.monotonic() - started < cfg.sse_max_seconds:
            if await request.is_disconnected():
                return
            await asyncio.sleep(cfg.sse_poll_seconds)
            current = await run_in_threadpool(read_version)
            if current is None:
                yield "event: gone\ndata: {}\n\n"
                return
            if current != last:
                last = current
                yield f"event: changed\ndata: {current}\n\n"
                last_sent = time.monotonic()
            elif time.monotonic() - last_sent > 15:
                yield ": ping\n\n"
                last_sent = time.monotonic()

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"}
    )


# ---------- payments (participant, via the share link) ----------

def _payment_for(db: Session, bill: Bill, p: Participant, payment_id: str) -> Payment:
    pay = db.get(Payment, payment_id)
    if pay is None or pay.bill_id != bill.id or pay.participant_id != p.id:
        raise HTTPException(404, "Payment not found.")
    return pay


def _payment_payload(bill: Bill, pay: Payment) -> dict:
    prov = PROVIDERS.get(pay.provider)
    return {
        "payment": {"id": pay.id, "status": pay.status, "amount": pay.amount, "currency": pay.currency,
                    "reference": pay.reference, "provider": pay.provider},
        "instructions": prov.instructions(bill, pay) if prov else {},
    }


@public.post("/{token}/payments", status_code=201, dependencies=[Depends(limit("pay", 30, 600))])
def start_payment(token: str, body: PaymentCreate, x_participant_token: str | None = Header(default=None),
                  x_participant_id: str | None = Header(default=None),
                  idempotency_key: str | None = Header(default=None, max_length=64), db: Session = Depends(get_db)):
    bill = _shared_bill(db, token)
    p = _participant(db, bill, x_participant_id, x_participant_token)
    try:
        pay = payments.create_payment(db, bill, p, body.provider, idempotency_key)
    except payments.PaymentError as e:
        raise _payment_error(e)
    return _payment_payload(bill, pay)


@public.get("/{token}/payments/{payment_id}", dependencies=[Depends(limit("view", 600, 60))])
def get_payment(token: str, payment_id: str, x_participant_token: str | None = Header(default=None),
                x_participant_id: str | None = Header(default=None), db: Session = Depends(get_db)):
    bill = _shared_bill(db, token)
    p = _participant(db, bill, x_participant_id, x_participant_token)
    payments.expire_stale(db, bill)
    return _payment_payload(bill, _payment_for(db, bill, p, payment_id))


@public.post("/{token}/payments/{payment_id}/paid", dependencies=[Depends(limit("pay", 30, 600))])
def say_paid(token: str, payment_id: str, body: PaidBody, x_participant_token: str | None = Header(default=None),
             x_participant_id: str | None = Header(default=None), db: Session = Depends(get_db)):
    """The payer reports they sent the money. The payment becomes *awaiting confirmation*, never *verified*."""
    bill = _shared_bill(db, token)
    p = _participant(db, bill, x_participant_id, x_participant_token)
    pay = _payment_for(db, bill, p, payment_id)
    try:
        payments.mark_paid_by_payer(db, pay, body.payer_note)
    except payments.PaymentError as e:
        db.rollback()
        raise _payment_error(e)
    return _payment_payload(bill, pay)


@public.post("/{token}/payments/{payment_id}/cancel", dependencies=[Depends(limit("pay", 30, 600))])
def cancel_payment(token: str, payment_id: str, x_participant_token: str | None = Header(default=None),
                   x_participant_id: str | None = Header(default=None), db: Session = Depends(get_db)):
    bill = _shared_bill(db, token)
    p = _participant(db, bill, x_participant_id, x_participant_token)
    pay = _payment_for(db, bill, p, payment_id)
    try:
        payments.transition(db, pay, "cancelled", "payer", "Cancelled by payer")
        db.commit()
    except payments.PaymentError as e:
        db.rollback()
        raise _payment_error(e)
    return _payment_payload(bill, pay)


# ---------- provider webhooks ----------

webhooks = APIRouter(prefix="/api/webhooks", tags=["webhooks"])


@webhooks.post("/{provider_key}", dependencies=[Depends(limit("webhook", 300, 60))])
async def provider_webhook(provider_key: str, request: Request, db: Session = Depends(get_db)):
    """Provider -> TABLY. The signature is checked on the raw body before anything is read from it."""
    provider = PROVIDERS.get(provider_key)
    if provider is None:
        raise HTTPException(404, "Unknown provider.")
    raw = await request.body()
    if len(raw) > 64_000:
        raise HTTPException(413, "Body too large.")
    try:
        event = provider.verify_webhook(request.headers, raw)
    except (WebhookRejected, NotImplementedProvider):
        raise HTTPException(401, "Invalid signature.")
    outcome = payments.apply_provider_event(db, provider_key, event)
    return {"result": outcome}  # 200 for duplicates too, so the provider stops retrying
