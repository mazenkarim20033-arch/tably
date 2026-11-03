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
