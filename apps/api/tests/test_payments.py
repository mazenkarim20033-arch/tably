import hashlib
import hmac
import json
import threading
from datetime import datetime, timedelta, timezone

import pytest

from tably_api.db import SessionLocal
from tably_api.models import Payment, PaymentEvent
from tably_api.providers import PROVIDERS, Availability, Provider, ProviderEvent, WebhookRejected

from .conftest import claim, join, sample_bill

PAYEE = {"payee_name": "Mazen", "instapay_address": "mazen@instapay"}
SECRET = b"whsec_test"


class FakeProvider(Provider):
    """Test-only automated provider: HMAC-SHA256 over the raw body in x-signature."""

    key = "fake"
    label = "Fake"
    automated = True

    def availability(self, bill):
        return Availability(True)

    def verify_webhook(self, headers, raw_body):
        want = hmac.new(SECRET, raw_body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(want, headers.get("x-signature", "")):
            raise WebhookRejected("bad signature")
        d = json.loads(raw_body)
        return ProviderEvent(d["event_id"], d["reference"], d["status"], d["amount"], d["currency"])


@pytest.fixture(autouse=True)
def fake_provider():
    PROVIDERS["fake"] = FakeProvider()
    yield
    PROVIDERS.pop("fake", None)


@pytest.fixture()
def pbill(client):
    r = client.post("/api/bills", json=sample_bill(payee=PAYEE))
    assert r.status_code == 201, r.text
    return r.json()


def admin(b):
    return {"X-Admin-Token": b["admin_token"]}


def view(client, t):
    return client.get(f"/api/s/{t}").json()


def iid(d, name):
    return next(i["id"] for i in d["items"] if i["description"] == name)


def setup_payer(client, b, name="Alice", item="Koshari"):
    t = b["share_token"]
    h = join(client, t, name)
    assert claim(client, t, h, iid(view(client, t), item), 1).status_code == 200
    return t, h


def start(client, t, h, key=None, provider="manual_instapay"):
    headers = dict(h)
    if key:
        headers["Idempotency-Key"] = key
    return client.post(f"/api/s/{t}/payments", json={"provider": provider}, headers=headers)


def say_paid(client, t, h, pid, note=None):
    return client.post(f"/api/s/{t}/payments/{pid}/paid", json={"payer_note": note} if note else {}, headers=h)


def confirm(client, b, pid, note=""):
    return client.post(f"/api/bills/{b['id']}/payments/{pid}/confirm", json={"note": note}, headers=admin(b))


def pay_row(client, t, name="Alice"):
    return next(p for p in view(client, t)["participants"] if p["name"] == name)


# ---------- payee details ----------

def test_payee_validation(client):
    bad = [
        {"payee_name": "M"},  # nothing to pay to
        {"payee_name": "M", "instapay_address": "not an address"},
        {"payee_name": "M", "instapay_phone": "123"},
        {"payee_name": "M", "instapay_link": "https://evil.example/pay"},
        {"payee_name": "M", "instapay_link": "http://ipn.eg/x"},
        {"payee_name": "M", "instapay_link": "https://user:pw@ipn.eg/x"},
    ]
    for payee in bad:
        assert client.post("/api/bills", json=sample_bill(payee=payee)).status_code == 422, payee
    ok = {"payee_name": "M", "instapay_phone": "01012345678", "instapay_link": "https://ipn.eg/S/mazen/instapay/abc"}
    assert client.post("/api/bills", json=sample_bill(payee=ok)).status_code == 201


def test_payee_is_shown_and_can_be_set_later(client):
    b = client.post("/api/bills", json=sample_bill()).json()
    t = b["share_token"]
    assert view(client, t)["payee"] is None
    h = {"X-Admin-Token": b["admin_token"]}
    r = client.put(f"/api/bills/{b['id']}/payee", json={"payee_name": "Mo", "instapay_address": "MO@instapay"}, headers=h)
    assert r.status_code == 200
    assert view(client, t)["payee"]["instapay_address"] == "mo@instapay"
    assert client.put(f"/api/bills/{b['id']}/payee", json=PAYEE).status_code == 404  # needs admin token


# ---------- starting a payment ----------

def test_cannot_pay_without_payee_details(client, bill):
    t, h = setup_payer(client, bill)
    r = start(client, t, h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "unavailable"


def test_start_payment_snapshots_amount_and_gives_instructions(client, pbill):
    t, h = setup_payer(client, pbill)
    due = pay_row(client, t)["total"]
    r = start(client, t, h)
    assert r.status_code == 201
    d = r.json()
    assert d["payment"]["status"] == "initiated" and d["payment"]["amount"] == due > 0
    assert d["payment"]["reference"].startswith("TBL-")
    ins = d["instructions"]
    assert ins["instapay_address"] == "mazen@instapay" and d["payment"]["reference"] in " ".join(ins["steps"])
    assert pay_row(client, t)["payment"]["status"] == "initiated"


def test_nothing_due_blocks_payment(client, pbill):
    t = pbill["share_token"]
    h = join(client, t, "Idle")
    assert start(client, t, h).json()["detail"]["code"] == "nothing_due"


def test_requires_participant_credentials(client, pbill):
    t, h = setup_payer(client, pbill)
    assert client.post(f"/api/s/{t}/payments", json={}).status_code == 401
    assert client.post(f"/api/s/{t}/payments", json={}, headers={**h, "X-Participant-Token": "x"}).status_code == 401


def test_duplicate_starts_return_the_same_payment(client, pbill):
    t, h = setup_payer(client, pbill)
    a = start(client, t, h, key="k1").json()["payment"]["id"]
    assert start(client, t, h, key="k1").json()["payment"]["id"] == a
    assert start(client, t, h, key="other").json()["payment"]["id"] == a  # one live attempt only
    with SessionLocal() as db:
        assert db.query(Payment).count() == 1


def test_concurrent_starts_make_one_payment(client, pbill):
    t, h = setup_payer(client, pbill)
    barrier = threading.Barrier(8)
    ids: list[str] = []
    lock = threading.Lock()

    def go():
        barrier.wait()
        r = start(client, t, h)
        with lock:
            if r.status_code == 201:
                ids.append(r.json()["payment"]["id"])

    ts = [threading.Thread(target=go) for _ in range(8)]
    [x.start() for x in ts]
    [x.join() for x in ts]
    assert len(set(ids)) == 1
    with SessionLocal() as db:
        assert db.query(Payment).count() == 1


# ---------- "I've paid" is not verification ----------

def test_payer_saying_paid_only_awaits_confirmation(client, pbill):
    t, h = setup_payer(client, pbill)
    pid = start(client, t, h).json()["payment"]["id"]
    r = say_paid(client, t, h, pid, note="IPN 998877")
    assert r.json()["payment"]["status"] == "awaiting_confirmation"
    d = view(client, t)
    assert d["totals"]["collected"] == 0 and d["totals"]["awaiting"] > 0
    assert d["totals"]["outstanding"] == d["totals"]["total"]
    assert pay_row(client, t)["payment"]["status"] == "awaiting_confirmation"


def test_payer_cannot_verify_by_any_route(client, pbill):
    t, h = setup_payer(client, pbill)
    pid = start(client, t, h).json()["payment"]["id"]
    say_paid(client, t, h, pid)
    url = f"/api/bills/{pbill['id']}/payments/{pid}/confirm"
    assert client.post(url, json={}).status_code == 404
    assert client.post(url, json={}, headers={"X-Admin-Token": h["X-Participant-Token"]}).status_code == 404
    assert client.post(url, json={}, headers={"X-Admin-Token": pbill["share_token"]}).status_code == 404
    assert pay_row(client, t)["payment"]["status"] == "awaiting_confirmation"


def test_cannot_pay_for_someone_elses_payment(client, pbill):
    t, h = setup_payer(client, pbill)
    other = join(client, t, "Eve")
    pid = start(client, t, h).json()["payment"]["id"]
    assert say_paid(client, t, other, pid).status_code == 404


def test_creator_confirmation_marks_verified_and_counts_as_collected(client, pbill):
    t, h = setup_payer(client, pbill)
    pid = start(client, t, h).json()["payment"]["id"]
    say_paid(client, t, h, pid, note="IPN 1")
    r = confirm(client, pbill, pid, "saw it in my bank")
    assert r.status_code == 200
    d = view(client, t)
    due = pay_row(client, t)["payment"]["amount"]
    assert d["totals"]["collected"] == due and d["totals"]["outstanding"] == d["totals"]["total"] - due
    assert pay_row(client, t)["payment"]["status"] == "verified"
    # nothing can undo or repeat it
    assert confirm(client, pbill, pid).status_code == 409
    assert client.post(f"/api/bills/{pbill['id']}/payments/{pid}/reject", json={}, headers=admin(pbill)).status_code == 409
    assert start(client, t, h).json()["detail"]["code"] == "already_paid"


def test_admin_view_has_audit_trail(client, pbill):
    t, h = setup_payer(client, pbill)
    pid = start(client, t, h).json()["payment"]["id"]
    say_paid(client, t, h, pid, note="IPN 77")
    confirm(client, pbill, pid, "ok")
    d = client.get(f"/api/bills/{pbill['id']}", headers=admin(pbill)).json()
    p = d["payments"][0]
    assert p["payer_note"] == "IPN 77" and p["participant_name"] == "Alice"
    assert [(e["actor"], e["to"]) for e in p["events"]] == [("payer", "initiated"), ("payer", "awaiting_confirmation"), ("creator", "verified")]


def test_rejection_then_retry(client, pbill):
    t, h = setup_payer(client, pbill)
    pid = start(client, t, h).json()["payment"]["id"]
    say_paid(client, t, h, pid)
    r = client.post(f"/api/bills/{pbill['id']}/payments/{pid}/reject", json={"note": "not received"}, headers=admin(pbill))
    assert r.status_code == 200
    assert pay_row(client, t)["payment"]["status"] == "failed"
    second = start(client, t, h)
    assert second.status_code == 201 and second.json()["payment"]["id"] != pid


def test_cancel_only_before_paid(client, pbill):
    t, h = setup_payer(client, pbill)
    pid = start(client, t, h).json()["payment"]["id"]
    assert client.post(f"/api/s/{t}/payments/{pid}/cancel", headers=h).json()["payment"]["status"] == "cancelled"
    pid2 = start(client, t, h).json()["payment"]["id"]
    say_paid(client, t, h, pid2)
    assert client.post(f"/api/s/{t}/payments/{pid2}/cancel", headers=h).status_code == 409


def test_stale_attempt_expires_but_creator_can_still_confirm_late_money(client, pbill):
    t, h = setup_payer(client, pbill)
    pid = start(client, t, h).json()["payment"]["id"]
    with SessionLocal() as db:
        db.get(Payment, pid).expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.commit()
    assert pay_row(client, t)["payment"]["status"] == "expired"
    assert say_paid(client, t, h, pid).status_code == 409
    assert confirm(client, pbill, pid, "paid late").status_code == 200
    assert pay_row(client, t)["payment"]["status"] == "verified"


# ---------- locks after payment starts ----------

def test_amount_and_selection_lock_once_payment_starts(client, pbill):
    t, h = setup_payer(client, pbill)
    due = pay_row(client, t)["total"]
    start(client, t, h)
    kid = iid(view(client, t), "Koshari")
    r = claim(client, t, h, kid, 0)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "locked"
    other = join(client, t, "Bob")
    claim(client, t, other, iid(view(client, t), "Falafel"), 1)
    row = pay_row(client, t)
    assert row["total"] == due and row["pinned"] is True


def test_cannot_move_money_for_someone_who_is_paying(client, pbill):
    t, h = setup_payer(client, pbill)
    b = join(client, t, "Bob")
    claim(client, t, b, iid(view(client, t), "Falafel"), 1)
    ids = {p["name"]: p["id"] for p in view(client, t)["participants"]}
    start(client, t, h)
    r = client.post(f"/api/bills/{pbill['id']}/transfers",
                    json={"payer_id": ids["Bob"], "beneficiary_id": ids["Alice"], "amount": 100}, headers=admin(pbill))
    assert r.status_code == 409


def test_payee_cannot_change_after_someone_started_paying(client, pbill):
    t, h = setup_payer(client, pbill)
    start(client, t, h)
    r = client.put(f"/api/bills/{pbill['id']}/payee", json={"payee_name": "Xavier", "instapay_address": "xavier@instapay"}, headers=admin(pbill))
    assert r.status_code == 409


def test_shared_item_is_frozen_when_a_sharer_has_paid(client, pbill):
    t = pbill["share_token"]
    a, b = join(client, t, "Alice"), join(client, t, "Bob")
    fid = iid(view(client, t), "Falafel")
    client.put(f"/api/s/{t}/claims", json={"item_id": fid, "share": True}, headers=a)
    start(client, t, a)
    r = client.put(f"/api/s/{t}/claims", json={"item_id": fid, "share": True}, headers=b)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "locked"


# ---------- provider webhooks ----------

def sign(body: bytes) -> dict:
    return {"x-signature": hmac.new(SECRET, body, hashlib.sha256).hexdigest(), "content-type": "application/json"}


def hook(client, ref, amount, status="paid", event_id="evt_1", currency="EGP", signed=True):
    body = json.dumps({"event_id": event_id, "reference": ref, "status": status, "amount": amount, "currency": currency}).encode()
    headers = sign(body) if signed else {"x-signature": "0" * 64}
    return client.post("/api/webhooks/fake", content=body, headers=headers)


def awaiting(client, b):
    t, h = setup_payer(client, b)
    p = start(client, t, h, provider="fake").json()["payment"]
    say_paid(client, t, h, p["id"])
    return t, h, p


def test_unsupported_providers_are_not_pretending(client, pbill):
    assert client.post("/api/webhooks/nope", content=b"{}").status_code == 404
    for key in ("kashier", "telda", "manual_instapay"):
        assert client.post(f"/api/webhooks/{key}", content=b"{}").status_code == 401
    methods = {m["key"]: m for m in view(client, pbill["share_token"])["payment_methods"]}
    assert methods["manual_instapay"]["enabled"] and not methods["manual_instapay"]["automated"]
    assert not methods["kashier"]["enabled"] and "merchant" in methods["kashier"]["reason"].lower()
    assert not methods["telda"]["enabled"]


def test_webhook_rejects_bad_signature(client, pbill):
    t, h, p = awaiting(client, pbill)
    assert hook(client, p["reference"], p["amount"], signed=False).status_code == 401
    assert pay_row(client, t)["payment"]["status"] == "awaiting_confirmation"


def test_webhook_verifies_matching_payment_and_is_idempotent(client, pbill):
    t, h, p = awaiting(client, pbill)
    assert hook(client, p["reference"], p["amount"]).json() == {"result": "applied"}
    assert pay_row(client, t)["payment"]["status"] == "verified"
    assert hook(client, p["reference"], p["amount"]).json() == {"result": "duplicate"}
    with SessionLocal() as db:
        verified = db.query(PaymentEvent).filter(PaymentEvent.to_status == "verified").count()
    assert verified == 1


def test_webhook_amount_mismatch_never_verifies(client, pbill):
    t, h, p = awaiting(client, pbill)
    assert hook(client, p["reference"], p["amount"] - 1).json() == {"result": "mismatch"}
    assert hook(client, p["reference"], p["amount"], currency="USD", event_id="evt_2").json() == {"result": "mismatch"}
    assert pay_row(client, t)["payment"]["status"] == "awaiting_confirmation"


def test_webhook_unknown_reference_and_wrong_state_are_ignored(client, pbill):
    t, h, p = awaiting(client, pbill)
    assert hook(client, "TBL-NOPE00", 100).json() == {"result": "ignored"}
    confirm(client, pbill, p["id"])
    assert hook(client, p["reference"], p["amount"], status="failed", event_id="evt_9").json() == {"result": "ignored"}
    assert pay_row(client, t)["payment"]["status"] == "verified"


def test_webhook_can_report_failure(client, pbill):
    t, h, p = awaiting(client, pbill)
    assert hook(client, p["reference"], p["amount"], status="failed").json() == {"result": "applied"}
    assert pay_row(client, t)["payment"]["status"] == "failed"
