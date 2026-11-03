"""Payment providers. Each one is a replaceable adapter behind the same small interface.

Honest status of each adapter:
  manual_instapay  WORKS, but is manual: the payer sends money in their own banking app and the creator
                   confirms receipt. TABLY never sees the transfer, so nothing is verified automatically.
  kashier          NOT IMPLEMENTED. Kashier documents InstaPay collection (QR / request-to-pay) and signed
                   webhooks, but that needs a Kashier merchant account and credentials. See `KashierProvider`.
  telda            NOT IMPLEMENTED. No public Telda merchant API was found.

No provider here talks to a private or undocumented InstaPay interface.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Mapping
from urllib.parse import urlparse

from .config import get_settings
from .models import Bill, Payment


class WebhookRejected(Exception):
    """Signature missing or wrong, or body unreadable. The endpoint answers 401 without detail."""


class NotImplementedProvider(Exception):
    pass


@dataclass(frozen=True)
class Availability:
    enabled: bool
    reason: str = ""


@dataclass(frozen=True)
class ProviderEvent:
    """A provider's authenticated statement about one payment."""

    event_id: str  # unique per provider event; used for idempotency
    reference: str  # our TBL-XXXXXX reference
    status: Literal["paid", "failed", "expired"]
    amount: int  # minor units, as the provider reports it
    currency: str


class Provider:
    key = ""
    label = ""
    automated = False  # True only if the provider itself confirms payments

    def availability(self, bill: Bill) -> Availability:
        raise NotImplementedError

    def instructions(self, bill: Bill, payment: Payment) -> dict:
        return {}

    def verify_webhook(self, headers: Mapping[str, str], raw_body: bytes) -> ProviderEvent:
        raise NotImplementedProvider(f"{self.key} has no webhook")


def link_host_allowed(url: str) -> bool:
    """Payment links must be https and on an allowlisted host, so a creator cannot point friends anywhere."""
    try:
        u = urlparse(url)
    except ValueError:
        return False
    allowed = {h.strip().lower() for h in get_settings().payment_link_hosts.split(",") if h.strip()}
    return u.scheme == "https" and not u.username and not u.password and (u.hostname or "").lower() in allowed


class ManualInstapay(Provider):
    key = "manual_instapay"
    label = "InstaPay (manual)"
    automated = False

    def availability(self, bill: Bill) -> Availability:
        if bill.instapay_address or bill.instapay_phone or bill.instapay_link:
            return Availability(True)
        return Availability(False, "The bill creator has not added payment details yet.")

    def instructions(self, bill: Bill, payment: Payment) -> dict:
        return {
            "provider": self.key,
            "payee_name": bill.payee_name,
            "instapay_address": bill.instapay_address,
            "instapay_phone": bill.instapay_phone,
            "instapay_link": bill.instapay_link,
            "amount": payment.amount,
            "currency": payment.currency,
            "reference": payment.reference,
            "steps": [
                f"Open your banking app or InstaPay and send exactly the amount to {bill.payee_name or 'the bill creator'}.",
                f"Put {payment.reference} in the transfer note so they can match it.",
                "Come back here and tap \"I've paid\". It is only marked paid once they confirm they received it.",
            ],
        }


class KashierProvider(Provider):
    """Adapter slot for Kashier InstaPay collection (QR / request-to-pay) with signed webhooks.

    Not implemented. To build it we need: a Kashier merchant account, test and live credentials, and the
    exact webhook signature recipe from Kashier's docs (it is an HMAC-SHA256 in `x-kashier-signature`; the
    precise signed payload must be taken from their documentation, not guessed). Until then it reports
    itself unavailable and rejects every webhook.
    """

    key = "kashier"
    label = "InstaPay via Kashier (automatic)"
    automated = True

    def availability(self, bill: Bill) -> Availability:
        return Availability(False, "Needs a Kashier merchant account and credentials. Not implemented yet.")

    def verify_webhook(self, headers: Mapping[str, str], raw_body: bytes) -> ProviderEvent:
        raise WebhookRejected("kashier webhook verification is not implemented")


class TeldaProvider(Provider):
    key = "telda"
    label = "Telda"
    automated = False

    def availability(self, bill: Bill) -> Availability:
        return Availability(False, "No public Telda merchant API is available, so this is not supported.")

    def verify_webhook(self, headers: Mapping[str, str], raw_body: bytes) -> ProviderEvent:
        raise WebhookRejected("telda has no webhook")


PROVIDERS: dict[str, Provider] = {p.key: p for p in (ManualInstapay(), KashierProvider(), TeldaProvider())}
