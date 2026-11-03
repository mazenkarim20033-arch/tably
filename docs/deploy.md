# Deploying TABLY and getting it on your iPhone

> **No credit card? Run the server on your own PC.** Use `scripts/start-server.ps1` (needs `winget install Cloudflare.cloudflared`).
> It uses your Neon database and prints a free public address that you paste into the app under Home > Server settings.
> The address changes on every start and the PC must stay on. Sections 2 and 3 below describe hosting on a cloud host instead.

Two things must exist before the iPhone app works for real:

1. **A hosted backend** (the phone cannot reach a server running on your PC).
2. **An IPA** built by GitHub from this repo, signed on your PC by Sideloadly with your free Apple ID.

Everything here is free or nearly free. None of it has been run on real hosting yet: the Dockerfile has not been built, and the backend has only been exercised on SQLite plus a local rehearsal (see "What is untested").

## 1. Database (Neon, already linked)

This repo is linked to a Neon project (`neon.ts`, `.neon` is git-ignored). Neon gives two connection strings;
`neon env pull` writes both to `.env.local` (git-ignored, never commit it):

| Variable | Use it for |
|---|---|
| `DATABASE_URL` (pooled, host has `-pooler`) | the running app. The server reads it directly (or `TABLY_DATABASE_URL`) |
| `DATABASE_URL_UNPOOLED` (direct) | schema migrations (`alembic upgrade head`). The migration tool prefers it automatically |

Why two: the pooled endpoint is PgBouncer in transaction mode, which breaks session-level work such as migrations.
The app disables server-side prepared statements so it works on the pooled endpoint.

Branches: `production` is the real data. `neon checkout <name> --create` makes a throwaway copy (expires after 7 days per `neon.ts`).
Never run the test suite against `production`: it drops every table. It refuses any database whose name lacks "test".

## 2. Backend (free tier)

TABLY ships as one Docker image that serves the API and the shared bill page. `render.yaml` describes it for Render;
any Docker host (Fly.io, Koyeb, Railway, a VPS) works the same way.

On Render: New > Blueprint > pick this repo > set `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct) from `.env.local`.
The container runs `alembic upgrade head` on start, so tables are created automatically.

Settings (environment variables, all prefixed `TABLY_`):

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string: the pooled Neon one (required). `TABLY_DATABASE_URL` also works |
| `DATABASE_URL_UNPOOLED` | direct Neon string used only for migrations at start-up (recommended) |
| `PAYMENT_LINK_HOSTS` | allowed hosts for a creator's InstaPay link (default `ipn.eg`, **unverified**) |
| `SHARE_LINK_DAYS` | default link lifetime, 30 |
| `RETENTION_DAYS` | `python -m tably_api.purge` deletes bills older than this, 180 |
| `RATE_LIMIT_ENABLED` | keep `true` |

Free hosts sleep when idle: the first request after a quiet period can take 30-60 seconds, and live updates reconnect afterwards.
That is fine for splitting a bill with friends; use a paid plan or an always-on host if it bothers you.

Check it: `python scripts/smoke.py https://your-app.onrender.com` (should print "All checks passed.").

## 3. Build the iPhone app (GitHub Actions, free)

The workflow `.github/workflows/ios-unsigned.yml` builds an unsigned IPA on a GitHub macOS machine (it calls
`scripts/ci-ios-build.sh`). JavaScript packages, CocoaPods and compiled iOS code are cached, so repeat builds are much faster than the first.

1. **Actions** tab > "Build unsigned iOS IPA" > **Run workflow**. When the check is green, download the `TABLY-unsigned-ipa` artifact and unzip it.
2. Optional: set a repository variable `API_URL` (Settings > Secrets and variables > Actions > Variables) as a fallback server address.
   The app normally takes the address from Home > Server settings.

`.github/workflows/tests.yml` runs all tests on every push.

Editing workflow files needs a GitHub login with the `workflow` permission. Private repos get 2,000 free Actions minutes a month and macOS minutes count 10x.

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
