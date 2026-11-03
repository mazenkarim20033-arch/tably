from datetime import datetime, timedelta, timezone

from tably_api.db import SessionLocal
from tably_api.models import Bill
from tably_api.money import allocate

from .conftest import sample_bill


def test_allocate_sums_exactly():
    assert allocate(10000, [1, 1, 1]) == [3334, 3333, 3333]
    assert sum(allocate(-101, [3, 5, 7])) == -101


def test_create_returns_unguessable_tokens(client):
    d = client.post("/api/bills", json=sample_bill()).json()
    assert len(d["share_token"]) >= 32 and len(d["admin_token"]) >= 43
    assert d["share_token"] != d["admin_token"]


def test_mismatch_is_rejected_unless_accepted(client):
    r = client.post("/api/bills", json=sample_bill(printed_total=40000))
    assert r.status_code == 422
    assert r.json()["detail"]["computed_total"] == 35280
    assert client.post("/api/bills", json=sample_bill(printed_total=40000, accept_mismatch=True)).status_code == 201


def test_rejects_bad_input(client):
    assert client.post("/api/bills", json=sample_bill(currency="egp")).status_code == 422
    assert client.post("/api/bills", json=sample_bill(items=[])).status_code == 422
    assert client.post("/api/bills", json=sample_bill(tax=-5)).status_code == 422
    bad = sample_bill()
    bad["items"][0]["quantity"] = 0
    assert client.post("/api/bills", json=bad).status_code == 422
    assert client.post("/api/bills", json={**sample_bill(), "evil": 1}).status_code == 422


def test_admin_view_requires_admin_token(client, bill):
    url = f"/api/bills/{bill['id']}"
    assert client.get(url).status_code == 404
    assert client.get(url, headers={"X-Admin-Token": bill["share_token"]}).status_code == 404
    ok = client.get(url, headers={"X-Admin-Token": bill["admin_token"]})
    assert ok.status_code == 200 and ok.json()["share_token"] == bill["share_token"]


def test_public_view_leaks_no_admin_data(client, bill):
    d = client.get(f"/api/s/{bill['share_token']}").json()
    assert d["store"] == "Zooba" and d["totals"]["total"] == 35280
    text = str(d)
    assert bill["admin_token"] not in text and bill["id"] not in text
    assert "share_token" not in d


def test_unknown_token_404(client, bill):
    assert client.get("/api/s/not-a-real-token").status_code == 404


def test_disable_rotate_and_expiry(client, bill):
    h = {"X-Admin-Token": bill["admin_token"]}
    url = f"/api/bills/{bill['id']}/link"
    assert client.post(url, json={"disabled": True}, headers=h).status_code == 200
    assert client.get(f"/api/s/{bill['share_token']}").status_code == 403
    assert client.post(url, json={"disabled": False}, headers=h).status_code == 200
    assert client.get(f"/api/s/{bill['share_token']}").status_code == 200

    new = client.post(url, json={"rotate": True}, headers=h).json()["share_token"]
    assert client.get(f"/api/s/{bill['share_token']}").status_code == 404
    assert client.get(f"/api/s/{new}").status_code == 200

    with SessionLocal() as db:
        b = db.get(Bill, bill["id"])
        b.share_expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.commit()
    assert client.get(f"/api/s/{new}").status_code == 410
    assert client.post(url, json={"extend_days": 7}, headers=h).status_code == 200
    assert client.get(f"/api/s/{new}").status_code == 200


def test_link_update_needs_admin(client, bill):
    r = client.post(f"/api/bills/{bill['id']}/link", json={"disabled": True})
    assert r.status_code == 404


def test_image_upload_validates_type(client, bill):
    h = {"X-Admin-Token": bill["admin_token"]}
    url = f"/api/bills/{bill['id']}/image"
    assert client.post(url, files={"file": ("x.jpg", b"not an image")}, headers=h).status_code == 415
    jpeg = b"\xff\xd8\xff\xe0" + b"0" * 100
    assert client.post(url, files={"file": ("../../evil.jpg", jpeg)}, headers=h).status_code == 204
    got = client.get(url, headers=h)
    assert got.status_code == 200 and got.content == jpeg
    assert client.get(url).status_code == 404  # no token, no image


def test_security_headers(client, bill):
    r = client.get(f"/api/s/{bill['share_token']}")
    assert r.headers["referrer-policy"] == "no-referrer"
    assert r.headers["cache-control"] == "no-store"
