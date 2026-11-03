import logging
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from tably_api import hardening
from tably_api.db import SessionLocal
from tably_api.main import app
from tably_api.models import Bill, ReceiptImage
from tably_api.purge import purge

from .conftest import sample_bill

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


# ---------- request size ----------

def test_oversized_json_body_is_rejected(client):
    big = sample_bill(store="x" * 400_000)
    assert client.post("/api/bills", json=big).status_code == 413


def test_chunked_body_without_length_is_also_limited(client):
    def chunks():
        for _ in range(100):
            yield b"a" * 8192  # 800 KB, no Content-Length

    r = client.post("/api/bills", content=chunks(), headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_normal_requests_still_pass(client):
    assert client.post("/api/bills", json=sample_bill()).status_code == 201


# ---------- headers ----------

def test_security_headers_present(client, bill):
    r = client.get(f"/api/s/{bill['share_token']}")
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert r.headers["x-frame-options"] == "DENY"
    assert "camera=()" in r.headers["permissions-policy"]


def test_hsts_only_over_https(client, bill):
    plain = TestClient(app, base_url="http://testserver").get("/api/health")
    secure = TestClient(app, base_url="https://testserver").get("/api/health")
    assert "strict-transport-security" not in plain.headers
    assert "max-age" in secure.headers["strict-transport-security"]


def test_api_docs_are_not_exposed(client):
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404


# ---------- guessing links ----------

def test_guessing_share_links_gets_throttled(client, bill):
    codes = [client.get(f"/api/s/guess{i}").status_code for i in range(hardening.BAD_TOKEN_STRIKES + 2)]
    assert codes[0] == 404 and codes[-1] == 429
    assert "retry-after" in client.get("/api/s/another").headers


def test_valid_links_do_not_cause_strikes(client, bill):
    for _ in range(hardening.BAD_TOKEN_STRIKES + 5):
        assert client.get(f"/api/s/{bill['share_token']}").status_code == 200


# ---------- logs ----------

def test_access_log_redacts_share_tokens():
    f = hardening.RedactTokens()
    rec = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                            ("1.2.3.4", "GET", "/api/s/SECRETtoken_123-abc/payments", "1.1", 200), None)
    f.filter(rec)
    out = rec.getMessage()
    assert "SECRETtoken" not in out and "/api/s/[redacted]/payments" in out
    rec2 = logging.LogRecord("x", logging.INFO, "", 0, "GET /s/AnotherSecret1 done", None, None)
    f.filter(rec2)
    assert "AnotherSecret1" not in rec2.getMessage()


# ---------- images live in the database ----------

def test_image_round_trip_and_replace(client, bill):
    h = {"X-Admin-Token": bill["admin_token"]}
    url = f"/api/bills/{bill['id']}/image"
    assert client.post(url, files={"file": ("a.png", PNG, "text/html")}, headers=h).status_code == 204
    got = client.get(url, headers=h)
    assert got.content == PNG and got.headers["content-type"] == "image/png"  # type decided by the server
    assert client.get(f"/api/bills/{bill['id']}", headers=h).json()["has_image"] is True
    jpg = b"\xff\xd8\xff\xe0" + b"1" * 40
    client.post(url, files={"file": ("b.jpg", jpg)}, headers=h)
    again = client.get(url, headers=h)
    assert again.content == jpg and again.headers["content-type"] == "image/jpeg"


def test_oversized_image_rejected(client, bill):
    huge = b"\xff\xd8\xff" + b"0" * (9 * 1024 * 1024)
    r = client.post(f"/api/bills/{bill['id']}/image", files={"file": ("a.jpg", huge)}, headers={"X-Admin-Token": bill["admin_token"]})
    assert r.status_code == 413


# ---------- retention ----------

def age(bill_id: str, days: int):
    with SessionLocal() as db:
        db.get(Bill, bill_id).created_at = datetime.now(timezone.utc) - timedelta(days=days)
        db.commit()


def test_purge_deletes_only_old_bills_and_everything_attached(client, pbill):
    from .test_payments import iid, start, view
    from .conftest import claim, join

    t = pbill["share_token"]
    a = join(client, t, "Alice")
    claim(client, t, a, iid(view(client, t), "Koshari"), 1)
    start(client, t, a)
    client.post(f"/api/bills/{pbill['id']}/image", files={"file": ("a.png", PNG)}, headers={"X-Admin-Token": pbill["admin_token"]})
    fresh = client.post("/api/bills", json=sample_bill()).json()
    age(pbill["id"], 200)

    assert purge(180, dry_run=True) == 1
    with SessionLocal() as db:
        assert db.get(Bill, pbill["id"]) is not None
    assert purge(180) == 1
    with SessionLocal() as db:
        assert db.get(Bill, pbill["id"]) is None and db.get(Bill, fresh["id"]) is not None
        assert db.query(ReceiptImage).count() == 0
        from tably_api.models import Claim, Participant, Payment
        assert db.query(Participant).count() == 0 and db.query(Claim).count() == 0 and db.query(Payment).count() == 0
    assert client.get(f"/api/s/{t}").status_code == 404


def test_database_url_is_normalized_for_hosted_postgres():
    from tably_api.config import Settings

    assert Settings(database_url="postgres://u:p@h/db").database_url == "postgresql+psycopg://u:p@h/db"
    assert Settings(database_url="postgresql://u:p@h/db").database_url == "postgresql+psycopg://u:p@h/db"
    assert Settings(database_url="postgresql+psycopg://u:p@h/db").database_url == "postgresql+psycopg://u:p@h/db"
    assert Settings(database_url="sqlite:///x.db").database_url == "sqlite:///x.db"
