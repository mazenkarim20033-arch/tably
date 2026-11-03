"""End-to-end: the whole product journey through the public HTTP interface, plus serving the web page."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from tably_api.main import mount_web

from .conftest import claim, join, sample_bill
from .test_payments import admin, iid, say_paid, start, view


def test_full_journey_from_scan_to_closed_bill(client):
    # 1. Creator makes a bill with payment details.
    b = client.post("/api/bills", json=sample_bill(payee={"payee_name": "Mazen", "instapay_address": "mazen@instapay"})).json()
    t = b["share_token"]

    # 2. Two friends open the link, pick items (one item is split), and the totals add up.
    sara, omar = join(client, t, "Sara"), join(client, t, "Omar")
    d = view(client, t)
    claim(client, t, sara, iid(d, "Falafel"), 1)
    claim(client, t, omar, iid(d, "Koshari"), 1)
    claim(client, t, sara, iid(d, "Mango juice"), 1)
    client.put(f"/api/s/{t}/claims", json={"item_id": iid(d, "Mango juice"), "share": True}, headers=omar)  # Omar joins the juice split
    d = view(client, t)
    # Sara holds one juice exclusively and Omar shares the other, so everything is claimed.
    assert d["totals"]["unassigned"] == 0
    people = {p["name"]: p for p in d["participants"]}
    assert people["Sara"]["total"] > 0 and people["Omar"]["total"] > 0

    # 3. Everyone starts paying; "I've paid" is not payment.
    pays = {}
    for name, h in (("Sara", sara), ("Omar", omar)):
        pays[name] = start(client, t, h).json()["payment"]
        say_paid(client, t, h, pays[name]["id"], note=f"bank-{name}")
    d = view(client, t)
    assert d["totals"]["collected"] == 0 and d["totals"]["awaiting"] == pays["Sara"]["amount"] + pays["Omar"]["amount"]
    assert client.post(f"/api/bills/{b['id']}/close", json={}, headers=admin(b)).status_code == 409

    # 4. Creator confirms each payment after checking their bank.
    for p in pays.values():
        assert client.post(f"/api/bills/{b['id']}/payments/{p['id']}/confirm", json={}, headers=admin(b)).status_code == 200
    d = view(client, t)
    assert d["totals"]["collected"] == pays["Sara"]["amount"] + pays["Omar"]["amount"]

    # 5. Everything claimed and confirmed, so the bill can close without force.
    assert d["totals"]["unassigned"] == 0
    r = client.post(f"/api/bills/{b['id']}/close", json={}, headers=admin(b))
    assert r.status_code == 200 and r.json()["status"] == "closed"
    assert client.post(f"/api/s/{t}/participants", json={"name": "TooLate"}).status_code == 409

    # 6. Creator turns the link off; the public page is gone.
    client.post(f"/api/bills/{b['id']}/link", json={"disabled": True}, headers=admin(b))
    assert client.get(f"/api/s/{t}").status_code == 403


def test_web_page_is_served_with_client_side_routes(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "index.html").write_text("<!doctype html><title>TABLY</title>")
    dist = tmp_path / "dist"
    (tmp_path / "assets").rename(tmp_path / "x_assets")  # build lives in dist/, a sibling file must stay unreachable
    dist.mkdir()
    (tmp_path / "x_assets").rename(dist / "assets")
    (tmp_path / "index.html").rename(dist / "index.html")
    (tmp_path / "secret.txt").write_text("outside the build folder")
    app = FastAPI()
    mount_web(app, dist)
    c = TestClient(app)
    assert "TABLY" in c.get("/s/some-share-token").text  # deep link falls back to the app shell
    assert c.get("/assets/app.js").text == "console.log(1)"
    assert c.get("/api/nope").status_code == 404
    for sneaky in ("/..%2fsecret.txt", "/%2e%2e/secret.txt", "/../secret.txt"):
        assert "outside the build folder" not in c.get(sneaky).text  # traversal never escapes dist/
