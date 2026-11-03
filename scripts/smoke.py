"""Post-deploy check: `python scripts/smoke.py https://your-app.example.com`

Creates one small test bill on that server and walks the basics. Needs only the Python standard library.
The test bill is left behind; the retention purge removes it with everything else.
"""

import json
import sys
import urllib.error
import urllib.request


def call(base, method, path, body=None, headers=None):
    req = urllib.request.Request(
        base + path, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, json.loads(e.read() or b"null") if e.headers.get_content_type() == "application/json" else None


def check(ok, label):
    print(("PASS " if ok else "FAIL ") + label)
    if not ok:
        sys.exit(1)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    base = sys.argv[1].rstrip("/")

    status, _, body = call(base, "GET", "/api/health")
    check(status == 200 and body == {"ok": True}, "health endpoint")

    bill = {"store": "Smoke test", "currency": "EGP", "tax": 0, "service": 0,
            "items": [{"description": "Test item", "quantity": 1, "line_total": 1000}],
            "payee": {"payee_name": "Smoke", "instapay_address": "smoke@instapay"}}
    status, _, made = call(base, "POST", "/api/bills", bill)
    check(status == 201 and len(made["share_token"]) >= 32, "create bill with an unguessable link")

    status, headers, view = call(base, "GET", f"/api/s/{made['share_token']}")
    check(status == 200 and view["totals"]["total"] == 1000, "public bill view")
    check(headers.get("referrer-policy") == "no-referrer" and "content-security-policy" in headers, "security headers")
    check(headers.get("strict-transport-security") is not None or base.startswith("http://"), "HSTS over https")

    status, _, who = call(base, "POST", f"/api/s/{made['share_token']}/participants", {"name": "Smoke"})
    check(status == 201, "join")
    auth = {"X-Participant-Id": who["participant_id"], "X-Participant-Token": who["participant_token"]}
    status, _, after = call(base, "PUT", f"/api/s/{made['share_token']}/claims",
                            {"item_id": view["items"][0]["id"], "units": 1}, auth)
    check(status == 200 and after["participants"][0]["total"] == 1000, "claim an item")

    status, _, _ = call(base, "GET", f"/api/bills/{made['id']}")
    check(status == 404, "creator view refuses requests without the admin key")
    status, _, adm = call(base, "GET", f"/api/bills/{made['id']}", headers={"X-Admin-Token": made["admin_token"]})
    check(status == 200 and adm["share_token"] == made["share_token"], "creator view with the admin key")

    status, _, _ = call(base, "GET", "/api/s/definitely-not-a-real-link")
    check(status == 404, "unknown link is a 404")

    status, _, _ = call(base, "POST", "/api/webhooks/kashier", {})
    check(status == 401, "unimplemented provider webhook is rejected")
    print("All checks passed.")


if __name__ == "__main__":
    main()
