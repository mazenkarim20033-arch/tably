from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
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

    bill: Mapped[Bill] = relationship(back_populates="participants")


class Claim(Base):
    """`units` of an item held by one participant. The sum over an item never exceeds its quantity."""

    __tablename__ = "claims"
    __table_args__ = (CheckConstraint("units >= 1", name="ck_claim_units"),)

    participant_id: Mapped[str] = mapped_column(ForeignKey("participants.id", ondelete="CASCADE"), primary_key=True)
    item_id: Mapped[str] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"), primary_key=True, index=True)
    units: Mapped[int] = mapped_column(Integer)
