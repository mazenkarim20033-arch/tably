from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Index, text,
    BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id() -> str:
    return uuid.uuid4().hex


class Bill(Base):
    __tablename__ = "bills"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    store: Mapped[str] = mapped_column(String(120))
    receipt_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    currency: Mapped[str] = mapped_column(String(3))
    # All money is integer minor units (piastres).
    discounts: Mapped[int] = mapped_column(BigInteger, default=0)
    tax: Mapped[int] = mapped_column(BigInteger, default=0)
    service: Mapped[int] = mapped_column(BigInteger, default=0)
    tip: Mapped[int] = mapped_column(BigInteger, default=0)
    tax_included: Mapped[bool] = mapped_column(Boolean, default=False)
    printed_total: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    status: Mapped[str] = mapped_column(String(10), default="open")  # open | closed
    # Where friends pay the creator (manual InstaPay). Any one of address / phone / link is enough.
    payee_name: Mapped[str | None] = mapped_column(String(60), nullable=True)
    instapay_address: Mapped[str | None] = mapped_column(String(60), nullable=True)
    instapay_phone: Mapped[str | None] = mapped_column(String(11), nullable=True)
    instapay_link: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # Bumped on every change a viewer could see; the live-update stream watches it.
    version: Mapped[int] = mapped_column(Integer, default=0)

    share_token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    share_disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    share_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    admin_token_hash: Mapped[str] = mapped_column(String(64))
    image_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    items: Mapped[list[Item]] = relationship(back_populates="bill", order_by="Item.position", cascade="all, delete-orphan")
    participants: Mapped[list[Participant]] = relationship(
        back_populates="bill", order_by="Participant.created_at", cascade="all, delete-orphan"
    )
    transfers: Mapped[list["Transfer"]] = relationship(order_by="Transfer.created_at", cascade="all, delete-orphan")


class Item(Base):
    __tablename__ = "items"
    __table_args__ = (CheckConstraint("quantity >= 1", name="ck_item_qty"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    bill_id: Mapped[str] = mapped_column(ForeignKey("bills.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer)
    description: Mapped[str] = mapped_column(String(160))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    line_total: Mapped[int] = mapped_column(BigInteger)

    bill: Mapped[Bill] = relationship(back_populates="items")


class Participant(Base):
    __tablename__ = "participants"
    __table_args__ = (UniqueConstraint("bill_id", "name_key", name="uq_participant_name"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    bill_id: Mapped[str] = mapped_column(ForeignKey("bills.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(40))
    name_key: Mapped[str] = mapped_column(String(40))  # casefolded, for uniqueness
    secret_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_reminded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reminder_count: Mapped[int] = mapped_column(Integer, default=0)

    bill: Mapped[Bill] = relationship(back_populates="participants")


class Claim(Base):
    """One participant's hold on an item: either `units` whole units, or a seat in its shared pool.

    Units nobody claimed exclusively form the pool; the pool is split equally among its sharers.
    """

    __tablename__ = "claims"
    __table_args__ = (
        CheckConstraint(
            "(shared = TRUE AND units = 0) OR (shared = FALSE AND units >= 1)", name="ck_claim_mode"
        ),
    )

    participant_id: Mapped[str] = mapped_column(ForeignKey("participants.id", ondelete="CASCADE"), primary_key=True)
    item_id: Mapped[str] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"), primary_key=True, index=True)
    units: Mapped[int] = mapped_column(Integer, default=0)
    shared: Mapped[bool] = mapped_column(Boolean, default=False)


class Transfer(Base):
    """Creator-entered adjustment: `payer` covers `amount` of what `beneficiary` would owe. Moves, never adds."""

    __tablename__ = "transfers"
    __table_args__ = (CheckConstraint("amount > 0", name="ck_transfer_amount"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    bill_id: Mapped[str] = mapped_column(ForeignKey("bills.id", ondelete="CASCADE"), index=True)
    payer_id: Mapped[str] = mapped_column(ForeignKey("participants.id", ondelete="CASCADE"))
    beneficiary_id: Mapped[str] = mapped_column(ForeignKey("participants.id", ondelete="CASCADE"))
    amount: Mapped[int] = mapped_column(BigInteger)
    note: Mapped[str] = mapped_column(String(80), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


ACTIVE_STATUSES = ("initiated", "awaiting_confirmation")
PINNING_STATUSES = ("initiated", "awaiting_confirmation", "verified")


class Payment(Base):
    """One attempt by a participant to pay the creator. No row means unpaid.

    Status moves only through payments.transition(); `verified` needs the creator's review or an
    authenticated provider event, never the payer's own say-so.
    """

    __tablename__ = "payments"
    __table_args__ = (
        UniqueConstraint("bill_id", "reference", name="uq_payment_reference"),
        UniqueConstraint("participant_id", "idempotency_key", name="uq_payment_idempotency"),
        CheckConstraint("amount > 0", name="ck_payment_amount"),
        # At most one live or settled payment per participant: blocks duplicate payment records.
        Index(
            "uq_payment_one_live",
            "participant_id",
            unique=True,
            postgresql_where=text("status IN ('initiated','awaiting_confirmation','verified')"),
            sqlite_where=text("status IN ('initiated','awaiting_confirmation','verified')"),
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    bill_id: Mapped[str] = mapped_column(ForeignKey("bills.id", ondelete="CASCADE"), index=True)
    participant_id: Mapped[str] = mapped_column(ForeignKey("participants.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(30))
    amount: Mapped[int] = mapped_column(BigInteger)  # snapshot of what the payer was asked to send
    currency: Mapped[str] = mapped_column(String(3))
    status: Mapped[str] = mapped_column(String(24), default="initiated")
    reference: Mapped[str] = mapped_column(String(16))  # printed in the bank transfer note for reconciliation
    external_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    payer_note: Mapped[str | None] = mapped_column(String(80), nullable=True)  # payer's own bank reference
    idempotency_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    events: Mapped[list[PaymentEvent]] = relationship(order_by="PaymentEvent.at", cascade="all, delete-orphan")


class PaymentEvent(Base):
    """Append-only audit trail of every status change, and the idempotency record for provider events."""

    __tablename__ = "payment_events"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    payment_id: Mapped[str] = mapped_column(ForeignKey("payments.id", ondelete="CASCADE"), index=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    actor: Mapped[str] = mapped_column(String(12))  # payer | creator | provider | system
    from_status: Mapped[str | None] = mapped_column(String(24), nullable=True)
    to_status: Mapped[str] = mapped_column(String(24))
    note: Mapped[str] = mapped_column(String(200), default="")
    provider_event_id: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)
