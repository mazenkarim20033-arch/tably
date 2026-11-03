# Deploying TABLY and getting it on your iPhone

Two things must exist before the iPhone app works for real:

1. **A hosted backend** (the phone cannot reach a server running on your PC).
2. **An IPA** built by GitHub from this repo, signed on your PC by Sideloadly with your free Apple ID.

Everything here is free or nearly free. None of it has been run on real hosting yet: the Dockerfile has not been built, and the backend has only been exercised on SQLite plus a local rehearsal (see "What is untested").

## 1. Database (free)

Create a free Postgres database at https://neon.tech (any Postgres works). Copy its connection string.
It looks like `postgresql://user:pass@host/dbname`; TABLY rewrites the scheme itself.

## 2. Backend (free tier)

TABLY ships as one Docker image that serves the API and the shared bill page. `render.yaml` describes it for Render;
any Docker host (Fly.io, Koyeb, Railway, a VPS) works the same way.

On Render: New > Blueprint > pick this repo > set `TABLY_DATABASE_URL` to your connection string.
The container runs `alembic upgrade head` on start, so tables are created automatically.

Settings (environment variables, all prefixed `TABLY_`):

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string (required) |
| `PAYMENT_LINK_HOSTS` | allowed hosts for a creator's InstaPay link (default `ipn.eg`, **unverified**) |
| `SHARE_LINK_DAYS` | default link lifetime, 30 |
| `RETENTION_DAYS` | `python -m tably_api.purge` deletes bills older than this, 180 |
| `RATE_LIMIT_ENABLED` | keep `true` |

Free hosts sleep when idle: the first request after a quiet period can take 30-60 seconds, and live updates reconnect afterwards.
That is fine for splitting a bill with friends; use a paid plan or an always-on host if it bothers you.

Check it: `python scripts/smoke.py https://your-app.onrender.com` (should print "All checks passed.").

## 3. Build the iPhone app (GitHub Actions, free)

The build file is saved as `ci/ios-unsigned.workflow.yml` because GitHub refuses to accept workflow files from the
command-line login used so far. Activate it once in the browser:

1. On github.com open the repo, `ci/ios-unsigned.workflow.yml`, click the pencil.
2. Change the path at the top to `.github/workflows/ios-unsigned.yml`, then **Commit changes**.
3. Repo **Settings > Secrets and variables > Actions > Variables > New repository variable**:
   name `API_URL`, value your backend address (for example `https://your-app.onrender.com`, no trailing slash).
4. **Actions** tab > "Build unsigned iOS IPA" > **Run workflow**. When the check is green, download the
   `TABLY-unsigned-ipa` artifact and unzip it.

The same steps work for `ci/tests.workflow.yml` (copy it to `.github/workflows/tests.yml`) to run all tests on every push.

Private repos get 2,000 free Actions minutes a month and macOS minutes count 10x, so expect roughly 8-13 builds a month.

## 4. Install with Sideloadly

Open `TABLY-unsigned.ipa` in Sideloadly, enter your Apple ID, install. A free Apple ID means:
the app stops opening after **7 days** and must be re-installed (your bills live on the server, but the admin keys live
in the phone's keychain, so reinstalling over the top normally keeps them; deleting the app does not), at most 3
sideloaded apps, and no push notifications.

## 5. Housekeeping

- Schedule `python -m tably_api.purge` (for example a Render cron job) so old bills and photos are removed.
- Rotate nothing secret: the only secret is the database string. Payment provider keys do not exist yet.
- Backups: use your database host's backups. Receipt photos live in the database too.

## What is untested

- The Docker image build and the first run on a real host.
- The test suite on Postgres (it passes on SQLite). Run it against a throwaway Postgres to be sure:
  `TABLY_TEST_DATABASE_URL=postgresql+psycopg://.../tably_test python -m pytest` (the database name must contain "test"; the suite refuses anything else because it drops every table).
- The GitHub iOS build and the Swift Apple Vision module (never compiled), and every phone screen.
- Several instances behind a load balancer: rate limits are per process and in memory.
