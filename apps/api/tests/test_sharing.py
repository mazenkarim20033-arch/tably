from .conftest import claim, join, sample_bill


def view(client, token):
    return client.get(f"/api/s/{token}").json()


def iid(d, name):
    return next(i["id"] for i in d["items"] if i["description"] == name)


def share(client, token, headers, item_id, on=True):
    return client.put(f"/api/s/{token}/claims", json={"item_id": item_id, "share": on}, headers=headers)


def plain_bill(client, items, **extra):
    body = sample_bill(items=items, tax=0, service=0, printed_total=None, **extra)
    return client.post("/api/bills", json=body).json()


def test_three_people_split_one_item_exactly(client):
    b = plain_bill(client, [{"description": "Pizza", "quantity": 1, "line_total": 10000}])
    t = b["share_token"]
    people = [join(client, t, n) for n in ("A", "B", "C")]
    pid = iid(view(client, t), "Pizza")
    for h in people:
        assert share(client, t, h, pid).status_code == 200
    d = view(client, t)
    assert [p["total"] for p in d["participants"]] == [3334, 3333, 3333]
    assert d["totals"]["unassigned"] == 0 and d["items"][0]["remaining"] == 0


def test_sharing_conflicts_with_exclusive_claims(client):
    b = plain_bill(client, [{"description": "Pizza", "quantity": 1, "line_total": 9000}])
    t = b["share_token"]
    a, c = join(client, t, "A"), join(client, t, "B")
    pid = iid(view(client, t), "Pizza")
    assert claim(client, t, a, pid, 1).status_code == 200
    assert share(client, t, c, pid).status_code == 409  # A holds the only unit
    assert claim(client, t, a, pid, 0).status_code == 200
    assert share(client, t, c, pid).status_code == 200
    # a sharer exists, so nobody can take the whole item exclusively
    assert claim(client, t, a, pid, 1).status_code == 409


def test_pool_is_what_exclusive_holders_leave(client):
    b = plain_bill(client, [{"description": "Wings", "quantity": 4, "line_total": 40000}])
    t = b["share_token"]
    a, c, e = (join(client, t, n) for n in ("A", "B", "C"))
    wid = iid(view(client, t), "Wings")
    assert claim(client, t, a, wid, 2).status_code == 200  # A: 2 wings = 200
    assert share(client, t, c, wid).status_code == 200
    assert share(client, t, e, wid).status_code == 200  # B and C split the other 2 wings
    d = view(client, t)
    totals = {p["name"]: p["total"] for p in d["participants"]}
    assert totals == {"A": 20000, "B": 10000, "C": 10000}
    # A may not take a third wing: one unit must stay for the sharers beyond the units they leave
    assert claim(client, t, a, wid, 4).status_code == 409
    assert claim(client, t, a, wid, 3).status_code == 200
    assert {p["name"]: p["total"] for p in view(client, t)["participants"]} == {"A": 30000, "B": 5000, "C": 5000}


def test_leaving_the_pool_releases_it(client):
    b = plain_bill(client, [{"description": "Pizza", "quantity": 1, "line_total": 9000}])
    t = b["share_token"]
    a, c = join(client, t, "A"), join(client, t, "B")
    pid = iid(view(client, t), "Pizza")
    share(client, t, a, pid)
    share(client, t, c, pid)
    share(client, t, a, pid, on=False)
    d = view(client, t)
    assert {p["name"]: p["total"] for p in d["participants"]} == {"A": 0, "B": 9000}
    share(client, t, c, pid, on=False)
    assert view(client, t)["totals"]["unassigned"] == 9000


def test_leaving_share_does_not_drop_an_exclusive_claim(client):
    b = plain_bill(client, [{"description": "Pizza", "quantity": 1, "line_total": 9000}])
    t = b["share_token"]
    a = join(client, t, "A")
    pid = iid(view(client, t), "Pizza")
    claim(client, t, a, pid, 1)
    share(client, t, a, pid, on=False)
    assert view(client, t)["participants"][0]["total"] == 9000


def test_claim_body_needs_exactly_one_mode(client, bill):
    t = bill["share_token"]
    a = join(client, t, "A")
    fid = iid(view(client, t), "Falafel")
    both = client.put(f"/api/s/{t}/claims", json={"item_id": fid, "units": 1, "share": True}, headers=a)
    none = client.put(f"/api/s/{t}/claims", json={"item_id": fid}, headers=a)
    assert both.status_code == 422 and none.status_code == 422


def test_extras_follow_shared_subtotals_and_sum_to_total(client, bill):
    t = bill["share_token"]
    a, c = join(client, t, "A"), join(client, t, "B")
    d = view(client, t)
    share(client, t, a, iid(d, "Falafel"))
    share(client, t, c, iid(d, "Falafel"))
    claim(client, t, c, iid(d, "Koshari"), 1)
    claim(client, t, a, iid(d, "Mango juice"), 2)
    d = view(client, t)
    assert d["totals"]["unassigned"] == 0
    assert sum(p["total"] for p in d["participants"]) == d["totals"]["total"] == 35280


# ---------- creator adjustments ----------

def two_people(client, bill):
    t = bill["share_token"]
    a, b = join(client, t, "A"), join(client, t, "B")
    d = view(client, t)
    claim(client, t, a, iid(d, "Falafel"), 1)
    claim(client, t, b, iid(d, "Koshari"), 1)
    d = view(client, t)
    ids = {p["name"]: p["id"] for p in d["participants"]}
    return t, ids, {p["name"]: p["total"] for p in d["participants"]}


def test_transfer_moves_money_and_keeps_total(client, bill):
    t, ids, before = two_people(client, bill)
    h = {"X-Admin-Token": bill["admin_token"]}
    r = client.post(f"/api/bills/{bill['id']}/transfers",
                    json={"payer_id": ids["A"], "beneficiary_id": ids["B"], "amount": 2000, "note": "my treat"}, headers=h)
    assert r.status_code == 201
    d = r.json()
    after = {p["name"]: p["total"] for p in d["participants"]}
    assert after["A"] == before["A"] + 2000 and after["B"] == before["B"] - 2000
    assert sum(after.values()) == sum(before.values())
    row = {p["name"]: p for p in d["participants"]}
    assert row["A"]["adjustment"] == 2000 and row["B"]["adjustment"] == -2000
    assert d["transfers"][0]["note"] == "my treat"


def test_transfer_is_capped_at_what_beneficiary_owes(client, bill):
    t, ids, before = two_people(client, bill)
    h = {"X-Admin-Token": bill["admin_token"]}
    d = client.post(f"/api/bills/{bill['id']}/transfers",
                    json={"payer_id": ids["A"], "beneficiary_id": ids["B"], "amount": 99_999_999}, headers=h).json()
    after = {p["name"]: p["total"] for p in d["participants"]}
    assert after["B"] == 0 and after["A"] == before["A"] + before["B"]


def test_transfer_needs_admin_and_valid_people(client, bill):
    t, ids, _ = two_people(client, bill)
    body = {"payer_id": ids["A"], "beneficiary_id": ids["B"], "amount": 100}
    url = f"/api/bills/{bill['id']}/transfers"
    assert client.post(url, json=body).status_code == 404
    h = {"X-Admin-Token": bill["admin_token"]}
    assert client.post(url, json={**body, "beneficiary_id": ids["A"]}, headers=h).status_code == 422
    assert client.post(url, json={**body, "beneficiary_id": "nobody"}, headers=h).status_code == 422
    assert client.post(url, json={**body, "amount": 0}, headers=h).status_code == 422


def test_transfer_can_be_removed(client, bill):
    t, ids, before = two_people(client, bill)
    h = {"X-Admin-Token": bill["admin_token"]}
    made = client.post(f"/api/bills/{bill['id']}/transfers",
                       json={"payer_id": ids["A"], "beneficiary_id": ids["B"], "amount": 500}, headers=h).json()
    tid = made["transfers"][0]["id"]
    assert client.delete(f"/api/bills/{bill['id']}/transfers/{tid}").status_code == 404
    d = client.delete(f"/api/bills/{bill['id']}/transfers/{tid}", headers=h).json()
    assert {p["name"]: p["total"] for p in d["participants"]} == before


# ---------- live updates ----------

def test_version_changes_on_every_visible_change(client, bill):
    from tably_api.db import SessionLocal
    from tably_api.models import Bill

    def ver():
        with SessionLocal() as db:
            return db.get(Bill, bill["id"]).version

    v0 = ver()
    a = join(client, bill["share_token"], "A")
    v1 = ver()
    fid = iid(view(client, bill["share_token"]), "Falafel")
    claim(client, bill["share_token"], a, fid, 1)
    v2 = ver()
    assert v0 < v1 < v2


def test_event_stream_announces_ready_then_changes(client, bill):
    t = bill["share_token"]
    with client.stream("GET", f"/api/s/{t}/events") as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        text = "".join(r.iter_text())  # ends by itself after TABLY_SSE_MAX_SECONDS
    assert "event: ready" in text


def test_event_stream_rejects_bad_or_disabled_links(client, bill):
    assert client.get("/api/s/nope/events").status_code == 404
    client.post(f"/api/bills/{bill['id']}/link", json={"disabled": True}, headers={"X-Admin-Token": bill["admin_token"]})
    assert client.get(f"/api/s/{bill['share_token']}/events").status_code == 404
