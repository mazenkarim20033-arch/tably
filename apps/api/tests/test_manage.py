from .conftest import claim, join, sample_bill
from .test_payments import PAYEE, admin, confirm, iid, say_paid, start, view


def edit_body(**over):
    body = {
        "store": "Zooba",
        "receipt_date": "2026-11-03",
        "items": [
            {"description": "Falafel", "quantity": 1, "line_total": 8500},
            {"description": "Mango juice", "quantity": 2, "line_total": 12000},
            {"description": "Koshari", "quantity": 1, "line_total": 7500},
        ],
        "tax": 3920, "service": 3360, "printed_total": 35280,
    }
    body.update(over)
    return body


def patch(client, b, body):
    return client.patch(f"/api/bills/{b['id']}/receipt", json=body, headers=admin(b))


def full(client, b):
    return client.get(f"/api/bills/{b['id']}", headers=admin(b)).json()


def with_ids(client, b, **over):
    d = full(client, b)
    body = edit_body(**over)
    ids = {i["description"]: i["id"] for i in d["items"]}
    for it in body["items"]:
        if it["description"] in ids:
            it["id"] = ids[it["description"]]
    return body


# ---------- receipt edits ----------

def test_edit_receipt_updates_totals_and_keeps_claims(client, pbill):
    t = pbill["share_token"]
    a = join(client, t, "Alice")
    claim(client, t, a, iid(view(client, t), "Koshari"), 1)
    body = with_ids(client, pbill, store="Zooba Zamalek")
    body["items"][2]["line_total"] = 8000  # Koshari price corrected
    body["printed_total"] = 35280 + 500
    body["tax"], body["service"] = 3920, 3360
    r = patch(client, pbill, body)
    assert r.status_code == 200, r.text
    d = view(client, t)
    assert d["store"] == "Zooba Zamalek"
    assert d["participants"][0]["items_total"] == 8000


def test_edit_can_add_and_remove_items_and_releases_removed_claims(client, pbill):
    t = pbill["share_token"]
    a = join(client, t, "Alice")
    claim(client, t, a, iid(view(client, t), "Falafel"), 1)
    body = with_ids(client, pbill)
    body["items"] = [i for i in body["items"] if i["description"] != "Falafel"]
    body["items"].append({"description": "Tea", "quantity": 1, "line_total": 2000})
    body["printed_total"] = None
    assert patch(client, pbill, body).status_code == 200
    d = view(client, t)
    assert {i["description"] for i in d["items"]} == {"Mango juice", "Koshari", "Tea"}
    assert d["participants"][0]["total"] == 0


def test_edit_rejects_mismatch_unless_accepted(client, pbill):
    body = with_ids(client, pbill, printed_total=99999)
    assert patch(client, pbill, body).status_code == 422
    body["accept_mismatch"] = True
    assert patch(client, pbill, body).status_code == 200


def test_edit_cannot_shrink_below_what_is_claimed(client, pbill):
    t = pbill["share_token"]
    a = join(client, t, "Alice")
    claim(client, t, a, iid(view(client, t), "Mango juice"), 2)
    body = with_ids(client, pbill)
    body["items"][1]["quantity"] = 1
    body["printed_total"] = None
    r = patch(client, pbill, body)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "claims_conflict"
    assert view(client, t)["items"][1]["quantity"] == 2  # unchanged


def test_edit_rejects_foreign_item_ids_and_needs_admin(client, pbill):
    body = with_ids(client, pbill)
    body["items"][0]["id"] = "f" * 32
    assert patch(client, pbill, body).status_code == 422
    assert client.patch(f"/api/bills/{pbill['id']}/receipt", json=edit_body()).status_code == 404


def test_receipt_is_locked_once_payment_starts(client, pbill):
    t = pbill["share_token"]
    a = join(client, t, "Alice")
    claim(client, t, a, iid(view(client, t), "Koshari"), 1)
    start(client, t, a)
    r = patch(client, pbill, with_ids(client, pbill, store="Changed"))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "locked"
    assert view(client, t)["store"] == "Zooba"


# ---------- people ----------

def test_creator_adds_person_and_assigns_for_them(client, pbill):
    h = admin(pbill)
    d = client.post(f"/api/bills/{pbill['id']}/participants", json={"name": "Grandma"}, headers=h).json()
    pid = d["participants"][0]["id"]
    kid = iid(d, "Koshari")
    r = client.put(f"/api/bills/{pbill['id']}/participants/{pid}/claims", json={"item_id": kid, "units": 1}, headers=h)
    assert r.status_code == 200 and r.json()["participants"][0]["items_total"] == 7500
    assert client.post(f"/api/bills/{pbill['id']}/participants", json={"name": "grandma"}, headers=h).status_code == 409


def test_added_person_cannot_be_impersonated(client, pbill):
    h = admin(pbill)
    d = client.post(f"/api/bills/{pbill['id']}/participants", json={"name": "Grandma"}, headers=h).json()
    pid = d["participants"][0]["id"]
    fid = iid(d, "Falafel")
    bad = {"X-Participant-Id": pid, "X-Participant-Token": "guess"}
    assert claim(client, pbill["share_token"], bad, fid, 1).status_code == 401


def test_removing_a_person_frees_their_items(client, pbill):
    t = pbill["share_token"]
    a = join(client, t, "Alice")
    claim(client, t, a, iid(view(client, t), "Falafel"), 1)
    pid = view(client, t)["participants"][0]["id"]
    r = client.delete(f"/api/bills/{pbill['id']}/participants/{pid}", headers=admin(pbill))
    assert r.status_code == 200
    d = view(client, t)
    assert d["participants"] == [] and d["totals"]["unassigned"] == d["totals"]["total"]
    assert client.delete(f"/api/bills/{pbill['id']}/participants/{pid}", headers=admin(pbill)).status_code == 404


def test_cannot_remove_someone_who_is_paying(client, pbill):
    t = pbill["share_token"]
    a = join(client, t, "Alice")
    claim(client, t, a, iid(view(client, t), "Koshari"), 1)
    pid = view(client, t)["participants"][0]["id"]
    start(client, t, a)
    r = client.delete(f"/api/bills/{pbill['id']}/participants/{pid}", headers=admin(pbill))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "locked"


def test_creator_cannot_reassign_a_locked_person(client, pbill):
    t = pbill["share_token"]
    a = join(client, t, "Alice")
    kid = iid(view(client, t), "Koshari")
    claim(client, t, a, kid, 1)
    pid = view(client, t)["participants"][0]["id"]
    start(client, t, a)
    r = client.put(f"/api/bills/{pbill['id']}/participants/{pid}/claims", json={"item_id": kid, "units": 0}, headers=admin(pbill))
    assert r.status_code == 409


# ---------- closing ----------

def settle_everything(client, b):
    t = b["share_token"]
    a = join(client, t, "Alice")
    for i in view(client, t)["items"]:
        claim(client, t, a, i["id"], i["quantity"])
    pid = start(client, t, a).json()["payment"]["id"]
    say_paid(client, t, a, pid)
    return t, a, pid


def test_cannot_close_an_unsettled_bill_without_force(client, pbill):
    t, a, pid = settle_everything(client, pbill)
    r = client.post(f"/api/bills/{pbill['id']}/close", json={}, headers=admin(pbill))
    assert r.status_code == 409 and "Alice" in r.json()["detail"]["message"]
    assert view(client, t)["status"] == "open"


def test_close_settled_bill_then_everything_stops(client, pbill):
    t, a, pid = settle_everything(client, pbill)
    confirm(client, pbill, pid)
    r = client.post(f"/api/bills/{pbill['id']}/close", json={}, headers=admin(pbill))
    assert r.status_code == 200 and r.json()["status"] == "closed"
    assert client.post(f"/api/s/{t}/participants", json={"name": "Late"}).status_code == 409
    kid = iid(view(client, t), "Koshari")
    assert claim(client, t, a, kid, 0).status_code == 409
    assert patch(client, pbill, with_ids(client, pbill)).status_code == 409
    again = client.post(f"/api/bills/{pbill['id']}/reopen", headers=admin(pbill)).json()
    assert again["status"] == "open"


def test_force_close_works_for_unpaid_bill(client, pbill):
    r = client.post(f"/api/bills/{pbill['id']}/close", json={"force": True}, headers=admin(pbill))
    assert r.status_code == 200 and r.json()["status"] == "closed"


def test_close_and_reopen_need_admin(client, pbill):
    assert client.post(f"/api/bills/{pbill['id']}/close", json={"force": True}).status_code == 404
    assert client.post(f"/api/bills/{pbill['id']}/reopen").status_code == 404


# ---------- reminders ----------

def test_reminders_are_logged_not_sent(client, pbill):
    t = pbill["share_token"]
    join(client, t, "Alice")
    pid = view(client, t)["participants"][0]["id"]
    r = client.post(f"/api/bills/{pbill['id']}/reminders", json={"participant_ids": [pid]}, headers=admin(pbill))
    row = r.json()["participants"][0]
    assert row["reminder_count"] == 1 and row["last_reminded_at"]
    r = client.post(f"/api/bills/{pbill['id']}/reminders", json={"participant_ids": [pid, "nobody"]}, headers=admin(pbill))
    assert r.json()["participants"][0]["reminder_count"] == 2
    assert client.post(f"/api/bills/{pbill['id']}/reminders", json={"participant_ids": [pid]}).status_code == 404


# ---------- history summaries ----------

def test_summaries_only_return_bills_you_hold_the_key_for(client, pbill):
    other = client.post("/api/bills", json=sample_bill()).json()
    body = {"bills": [
        {"id": pbill["id"], "admin_token": pbill["admin_token"]},
        {"id": other["id"], "admin_token": pbill["admin_token"]},  # wrong key
        {"id": "nope", "admin_token": "x"},
    ]}
    out = client.post("/api/bills/summaries", json=body).json()["bills"]
    assert out[0]["store"] == "Zooba" and out[0]["total"] == 35280 and out[0]["status"] == "open"
    assert out[1] == {"id": other["id"], "missing": True}
    assert out[2]["missing"] is True
    assert "share_token" not in out[0] and "admin_token" not in str(out)
