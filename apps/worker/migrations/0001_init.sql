-- TABLY schema for Cloudflare D1 (SQLite). Mirrors the FastAPI/SQLAlchemy model, constraint for constraint.
-- Money is always integer minor units (piastres). Booleans are 0/1. Timestamps are ISO-8601 UTC text.

CREATE TABLE bills (
  id                TEXT PRIMARY KEY,
  store             TEXT NOT NULL,
  receipt_date      TEXT,
  currency          TEXT NOT NULL CHECK (length(currency) = 3),
  discounts         INTEGER NOT NULL DEFAULT 0 CHECK (discounts <= 0),
  tax               INTEGER NOT NULL DEFAULT 0 CHECK (tax >= 0),
  service           INTEGER NOT NULL DEFAULT 0 CHECK (service >= 0),
  tip               INTEGER NOT NULL DEFAULT 0 CHECK (tip >= 0),
  tax_included      INTEGER NOT NULL DEFAULT 0 CHECK (tax_included IN (0, 1)),
  printed_total     INTEGER,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  payee_name        TEXT,
  instapay_address  TEXT,
  instapay_phone    TEXT,
  instapay_link     TEXT,
  -- Bumped on every change a viewer could see; pages poll it to know when to refetch.
  version           INTEGER NOT NULL DEFAULT 0,
  share_token       TEXT NOT NULL UNIQUE,
  share_disabled    INTEGER NOT NULL DEFAULT 0 CHECK (share_disabled IN (0, 1)),
  share_expires_at  TEXT,
  admin_token_hash  TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE items (
  id          TEXT PRIMARY KEY,
  bill_id     TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  line_total  INTEGER NOT NULL CHECK (line_total >= 0)
);
CREATE INDEX ix_items_bill_id ON items(bill_id);

CREATE TABLE participants (
  id               TEXT PRIMARY KEY,
  bill_id          TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  name_key         TEXT NOT NULL,
  secret_hash      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  last_reminded_at TEXT,
  reminder_count   INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT uq_participant_name UNIQUE (bill_id, name_key)
);
CREATE INDEX ix_participants_bill_id ON participants(bill_id);

-- units whole units, or a seat in the item's shared pool (shared = 1, units = 0).
CREATE TABLE claims (
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  item_id        TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  units          INTEGER NOT NULL DEFAULT 0,
  shared         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (participant_id, item_id),
  CONSTRAINT ck_claim_mode CHECK ((shared = 1 AND units = 0) OR (shared = 0 AND units >= 1))
);
CREATE INDEX ix_claims_item_id ON claims(item_id);

CREATE TABLE transfers (
  id             TEXT PRIMARY KEY,
  bill_id        TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  payer_id       TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  beneficiary_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  amount         INTEGER NOT NULL CHECK (amount > 0),
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE INDEX ix_transfers_bill_id ON transfers(bill_id);

CREATE TABLE payments (
  id              TEXT PRIMARY KEY,
  bill_id         TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  participant_id  TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount > 0),
  currency        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'initiated',
  reference       TEXT NOT NULL,
  external_id     TEXT,
  payer_note      TEXT,
  idempotency_key TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT,
  CONSTRAINT uq_payment_reference UNIQUE (bill_id, reference),
  CONSTRAINT uq_payment_idempotency UNIQUE (participant_id, idempotency_key)
);
CREATE INDEX ix_payments_bill_id ON payments(bill_id);
CREATE INDEX ix_payments_participant_id ON payments(participant_id);
-- At most one live or settled payment per participant: blocks duplicate payment records.
CREATE UNIQUE INDEX uq_payment_one_live ON payments(participant_id)
  WHERE status IN ('initiated', 'awaiting_confirmation', 'verified');

CREATE TABLE payment_events (
  id                TEXT PRIMARY KEY,
  payment_id        TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  at                TEXT NOT NULL,
  actor             TEXT NOT NULL,
  from_status       TEXT,
  to_status         TEXT NOT NULL,
  note              TEXT NOT NULL DEFAULT '',
  provider_event_id TEXT UNIQUE
);
CREATE INDEX ix_payment_events_payment_id ON payment_events(payment_id);

-- Best-effort abuse counters (creating bills, joining, guessing share links). Old rows are pruned as they are read.
CREATE TABLE rate_hits (
  bucket TEXT NOT NULL,
  key    TEXT NOT NULL,
  window INTEGER NOT NULL,
  hits   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, key, window)
);
