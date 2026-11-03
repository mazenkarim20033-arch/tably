from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

MAX_MINOR = 100_000_000_00  # 100M in major units; keeps every sum far inside int64

Money = Annotated[int, Field(ge=0, le=MAX_MINOR)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ItemIn(StrictModel):
    description: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
    quantity: int = Field(ge=1, le=999)
    line_total: Money


class BillCreate(StrictModel):
    store: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    receipt_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    items: list[ItemIn] = Field(min_length=1, max_length=200)
    discounts: int = Field(default=0, le=0, ge=-MAX_MINOR)  # negative = savings
    tax: Money = 0
    service: Money = 0
    tip: Money = 0
    tax_included: bool = False
    printed_total: Money | None = None
    # The creator has seen that items do not add up to the printed total and wants to go ahead.
    accept_mismatch: bool = False
    payee: "PayeeIn | None" = None


class ParticipantCreate(StrictModel):
    name: Name


class ClaimSet(StrictModel):
    """Set whole units (`units`) or join/leave the item's shared pool (`share`). Exactly one."""

    item_id: str = Field(min_length=1, max_length=32)
    units: int | None = Field(default=None, ge=0, le=999)
    share: bool | None = None

    @model_validator(mode="after")
    def _one_of(self):
        if (self.units is None) == (self.share is None):
            raise ValueError("send either units or share")
        return self


class TransferCreate(StrictModel):
    payer_id: str = Field(min_length=1, max_length=32)
    beneficiary_id: str = Field(min_length=1, max_length=32)
    amount: int = Field(ge=1, le=MAX_MINOR)
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=80)] = ""


class LinkUpdate(StrictModel):
    disabled: bool | None = None
    extend_days: int | None = Field(default=None, ge=1, le=365)
    rotate: bool = False


class PayeeIn(StrictModel):
    """Where friends send money. At least one of address, phone or link."""

    payee_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
    instapay_address: str | None = Field(default=None, pattern=r"^[A-Za-z0-9._-]{2,40}@[A-Za-z]{2,20}$")
    instapay_phone: str | None = Field(default=None, pattern=r"^01[0125]\d{8}$")
    instapay_link: str | None = Field(default=None, max_length=300)

    @model_validator(mode="after")
    def _check(self):
        from .providers import link_host_allowed

        if not (self.instapay_address or self.instapay_phone or self.instapay_link):
            raise ValueError("add an InstaPay address, phone number or payment link")
        if self.instapay_link and not link_host_allowed(self.instapay_link):
            raise ValueError("payment link must be an https link on an allowed InstaPay host")
        if self.instapay_address:
            self.instapay_address = self.instapay_address.lower()
        return self


class PaymentCreate(StrictModel):
    provider: str = Field(default="manual_instapay", max_length=30)


class PaidBody(StrictModel):
    payer_note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=80)] | None = None


class ReviewBody(StrictModel):
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] = ""


class ItemEdit(StrictModel):
    id: str | None = Field(default=None, max_length=32)  # omit for a new item
    description: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
    quantity: int = Field(ge=1, le=999)
    line_total: Money


class BillEdit(StrictModel):
    store: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    receipt_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    items: list[ItemEdit] = Field(min_length=1, max_length=200)
    discounts: int = Field(default=0, le=0, ge=-MAX_MINOR)
    tax: Money = 0
    service: Money = 0
    tip: Money = 0
    tax_included: bool = False
    printed_total: Money | None = None
    accept_mismatch: bool = False


class CloseBody(StrictModel):
    force: bool = False  # close even though not everyone has paid (for example someone never will)


class ReminderLog(StrictModel):
    participant_ids: list[str] = Field(min_length=1, max_length=50)


class SummaryRequest(StrictModel):
    bills: list[dict[str, str]] = Field(min_length=1, max_length=50)  # [{"id": ..., "admin_token": ...}]


BillCreate.model_rebuild()
