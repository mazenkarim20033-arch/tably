import threading

from .conftest import claim, join, sample_bill


def view(client, token):
    return client.get(f"/api/s/{token}").json()


def item_id(d, name):
    return next(i["id"] for i in d["items"] if i["description"] == name)


def test_join_and_claim(client, bill):
    t = bill["share_token"]
    alice = join(client, t, "Alice")
    d = view(client, t)
    r = claim(client, t, alice, item_id(d, "Falafel"), 1)
    assert r.status_code == 200
    me = r.json()["participants"][0]
    assert me["items_total"] == 8500
    # extras are proportional to the share of the whole receipt's items (8500 / 28000)
    assert me["tax"] == 8500 * 3920 // 28000 and me["total"] > 8500


def test_exclusive_item_cannot_be_double_claimed(client, bill):
    t = bill["share_token"]
    a, b = join(client, t, "Alice"), join(client, t, "Bob")
    fid = item_id(view(client, t), "Falafel")
    assert claim(client, t, a, fid, 1).status_code == 200
    r = claim(client, t, b, fid, 1)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "taken"
    # releasing frees it for someone else
    assert claim(client, t, a, fid, 0).status_code == 200
    assert claim(client, t, b, fid, 1).status_code == 200


def test_quantity_items_can_be_split_by_units(client, bill):
    t = bill["share_token"]
    a, b, c = join(client, t, "A"), join(client, t, "B"), join(client, t, "C")
    jid = item_id(view(client, t), "Mango juice")
    assert claim(client, t, a, jid, 1).status_code == 200
    assert claim(client, t, b, jid, 1).status_code == 200
    r = claim(client, t, c, jid, 1)
    assert r.status_code == 409 and r.json()["detail"]["available"] == 0
    assert claim(client, t, a, jid, 2).status_code == 409  # would exceed with B holding one


def test_everyone_claims_everything_totals_equal_bill(client, bill):
    t = bill["share_token"]
    people = [join(client, t, n) for n in ("A", "B", "C")]
    d = view(client, t)
    claim(client, t, people[0], item_id(d, "Falafel"), 1)
    claim(client, t, people[1], item_id(d, "Mango juice"), 1)
    claim(client, t, people[2], item_id(d, "Mango juice"), 1)
    r = claim(client, t, people[2], item_id(d, "Koshari"), 1)
    d = r.json()
    assert d["totals"]["unassigned"] == 0
    assert sum(p["total"] for p in d["participants"]) == d["totals"]["total"] == 35280


def test_partial_claims_keep_remainder_unassigned(client, bill):
    t = bill["share_token"]
    a = join(client, t, "A")
    d = claim(client, t, a, item_id(view(client, t), "Koshari"), 1).json()
    tot = d["totals"]
    assert tot["assigned"] + tot["unassigned"] == tot["total"]
    assert 0 < tot["assigned"] < tot["total"]


def test_included_tax_not_added_twice(client):
    b = client.post("/api/bills", json=sample_bill(tax_included=True, tax=1000, service=0, printed_total=28000)).json()
    t = b["share_token"]
    a = join(client, t, "A")
    d = view(client, t)
    for i in d["items"]:
        claim(client, t, a, i["id"], i["quantity"])
    final = view(client, t)
    assert final["totals"]["total"] == 28000 and final["participants"][0]["total"] == 28000


def test_requires_valid_participant(client, bill):
    t = bill["share_token"]
    fid = item_id(view(client, t), "Falafel")
    a = join(client, t, "Alice")
    assert client.put(f"/api/s/{t}/claims", json={"item_id": fid, "units": 1}).status_code == 401
    forged = {"X-Participant-Id": a["X-Participant-Id"], "X-Participant-Token": "wrong"}
    assert claim(client, t, forged, fid, 1).status_code == 401
    other = client.post("/api/bills", json=sample_bill()).json()
    assert claim(client, other["share_token"], a, fid, 1).status_code == 401  # token from another bill


def test_unknown_item_and_bad_units(client, bill):
    t = bill["share_token"]
    a = join(client, t, "A")
    assert claim(client, t, a, "nope", 1).status_code == 404
    fid = item_id(view(client, t), "Falafel")
    assert claim(client, t, a, fid, -1).status_code == 422
    assert claim(client, t, a, fid, 2).status_code == 409


def test_duplicate_names_rejected_case_insensitively(client, bill):
    t = bill["share_token"]
    join(client, t, "Sara")
    r = client.post(f"/api/s/{t}/participants", json={"name": " sARA "})
    assert r.status_code == 409


def test_disabled_link_blocks_claims(client, bill):
    t = bill["share_token"]
    a = join(client, t, "A")
    fid = item_id(view(client, t), "Falafel")
    client.post(f"/api/bills/{bill['id']}/link", json={"disabled": True}, headers={"X-Admin-Token": bill["admin_token"]})
    assert claim(client, t, a, fid, 1).status_code == 403


def test_concurrent_claims_on_one_item_have_a_single_winner(client, bill):
    t = bill["share_token"]
    fid = item_id(view(client, t), "Falafel")
    people = [join(client, t, f"P{n}") for n in range(12)]
    results: list[int] = []
    lock = threading.Lock()
    barrier = threading.Barrier(len(people))

    def go(h):
        barrier.wait()
        code = claim(client, t, h, fid, 1).status_code
        with lock:
            results.append(code)

    threads = [threading.Thread(target=go, args=(h,)) for h in people]
    [th.start() for th in threads]
    [th.join() for th in threads]
    assert results.count(200) == 1, results
    assert results.count(409) == len(people) - 1
    holders = [c for i in view(client, t)["items"] if i["id"] == fid for c in i["claims"]]
    assert len(holders) == 1
