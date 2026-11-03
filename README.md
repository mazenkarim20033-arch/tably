# TABLY

Scan a receipt, share a link, friends pick what they ordered.

```
apps/mobile   Expo iPhone app (scan, review, create bill, share link)
apps/web      Shared bill page, opened from the link (no install needed)
apps/api      FastAPI backend (bills, share tokens, atomic claims, totals)
packages/core Shared TypeScript: money math, receipt parser, reconciliation
```

## Run locally

Backend (SQLite by default, no Docker needed):

```bash
cd apps/api
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements-dev.txt
.venv/Scripts/python -m uvicorn tably_api.main:app --port 8000
.venv/Scripts/python -m pytest
```

Web page (proxies `/api` to the backend):

```bash
npm install
npm run dev -w @tably/web
```

Core tests and typechecks: `npm test` and `npm run typecheck`.

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `TABLY_DATABASE_URL` | api | `sqlite:///./tably.db` (default) or `postgresql+psycopg://...` |
| `TABLY_TRUST_PROXY` | api | `true` only behind your own reverse proxy |
| `TABLY_WEB_DIST` | api | built web app to serve (default `../web/dist`) |
| `EXPO_PUBLIC_API_URL` | mobile build | Backend URL. A phone cannot use `localhost`. |

Set `TABLY_TEST_DATABASE_URL` to a Postgres URL to run the API tests against Postgres.
