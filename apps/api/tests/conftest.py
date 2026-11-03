import os
import tempfile

_tmp = tempfile.mkdtemp(prefix="tably-test-")
# Set TABLY_TEST_DATABASE_URL to a Postgres URL to run the suite (and the race test) against Postgres.
_url = os.environ.get("TABLY_TEST_DATABASE_URL", f"sqlite:///{_tmp}/test.db")
# The suite drops every table. Refuse to point it at anything that is not clearly a throwaway database.
if not _url.startswith("sqlite") and "test" not in _url.rsplit("/", 1)[-1].lower():
    raise RuntimeError("TABLY_TEST_DATABASE_URL must name a database containing the word test")
os.environ["TABLY_DATABASE_URL"] = _url
os.environ["TABLY_UPLOAD_DIR"] = f"{_tmp}/uploads"
os.environ["TABLY_WEB_DIST"] = f"{_tmp}/no-web"
os.environ["TABLY_SSE_MAX_SECONDS"] = "2"
os.environ["TABLY_SSE_POLL_SECONDS"] = "0.2"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from tably_api import ratelimit  # noqa: E402
from tably_api.db import Base, engine  # noqa: E402
from tably_api.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    ratelimit.reset()
    yield


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def sample_bill(**over):
    body = {
        "store": "Zooba",
        "receipt_date": "2026-11-03",
        "currency": "EGP",
        "items": [
            {"description": "Falafel", "quantity": 1, "line_total": 8500},
            {"description": "Mango juice", "quantity": 2, "line_total": 12000},
            {"description": "Koshari", "quantity": 1, "line_total": 7500},
        ],
        "discounts": 0,
        "tax": 3920,
        "service": 3360,
        "tip": 0,
        "tax_included": False,
        "printed_total": 35280,
    }
    body.update(over)
    return body


@pytest.fixture()
def bill(client):
    r = client.post("/api/bills", json=sample_bill())
    assert r.status_code == 201, r.text
    return r.json()


def join(client, token, name):
    r = client.post(f"/api/s/{token}/participants", json={"name": name})
    assert r.status_code == 201, r.text
    d = r.json()
    return {"X-Participant-Id": d["participant_id"], "X-Participant-Token": d["participant_token"]}


def claim(client, token, headers, item_id, units):
    return client.put(f"/api/s/{token}/claims", json={"item_id": item_id, "units": units}, headers=headers)


@pytest.fixture()
def pbill(client):
    """A bill whose creator has added InstaPay details, so friends can start paying."""
    payee = {"payee_name": "Mazen", "instapay_address": "mazen@instapay"}
    r = client.post("/api/bills", json=sample_bill(payee=payee))
    assert r.status_code == 201, r.text
    return r.json()
