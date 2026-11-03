import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join as pathJoin } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { app } from '../src/app';
import type { Env } from '../src/types';

// Vite does not know the new node:sqlite built-in, so load it at runtime.
const { DatabaseSync: SqliteDb } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * A D1-compatible database on Node's built-in SQLite. The Worker only uses prepare/bind/first/all/run/batch, so the
 * real application code runs unchanged in tests. `batch` is one transaction, like D1's.
 */
class Stmt {
  constructor(private db: DatabaseSync, readonly sql: string, private params: unknown[] = []) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params);
  }
  private get reads() {
    return /^\s*(select|with)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql);
  }
  async first<T = unknown>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.params as never[])) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }
  async all() {
    const results = this.db.prepare(this.sql).all(...(this.params as never[]));
    return { results, success: true, meta: { changes: 0 } };
  }
  async run() {
    return this.exec();
  }
  exec() {
    if (this.reads) {
      const results = this.db.prepare(this.sql).all(...(this.params as never[]));
      return { results, success: true, meta: { changes: 0 } };
    }
    const r = this.db.prepare(this.sql).run(...(this.params as never[]));
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

class TestD1 {
  constructor(readonly sqlite: DatabaseSync) {}
  prepare(sql: string) {
    return new Stmt(this.sqlite, sql);
  }
  async batch(stmts: Stmt[]) {
    this.sqlite.exec('BEGIN');
    try {
      const out = stmts.map((s) => s.exec());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }
}

export function makeEnv(overrides: Partial<Env> = {}): Env & { sqlite: DatabaseSync } {
  const sqlite = new SqliteDb(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = pathJoin(import.meta.dirname, '..', 'migrations');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) sqlite.exec(readFileSync(pathJoin(dir, f), 'utf8'));
  return { DB: new TestD1(sqlite) as unknown as D1Database, ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher, sqlite, ...overrides };
}

export interface Api {
  env: Env & { sqlite: DatabaseSync };
  req: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers: Headers }>;
}

let ipCounter = 0;
/** A fresh app + database per test. Each Api gets its own client address so rate limits do not bleed across tests. */
export function makeApi(overrides: Partial<Env> = {}): Api {
  const env = makeEnv(overrides);
  const ip = `10.0.0.${++ipCounter}`;
  const req: Api['req'] = async (method, path, body, headers = {}) => {
    const res = await app.request(
      path,
      { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) },
      env,
    );
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  return { env, req };
}

export const sampleBill = (over: Record<string, unknown> = {}) => ({
  store: 'Zooba',
  receipt_date: '2026-11-03',
  currency: 'EGP',
  items: [
    { description: 'Falafel', quantity: 1, line_total: 8500 },
    { description: 'Mango juice', quantity: 2, line_total: 12000 },
    { description: 'Koshari', quantity: 1, line_total: 7500 },
  ],
  discounts: 0,
  tax: 3920,
  service: 3360,
  tip: 0,
  tax_included: false,
  printed_total: 35280,
  ...over,
});

export const PAYEE = { payee_name: 'Mazen', instapay_address: 'mazen@instapay' };

export async function createBill(api: Api, over: Record<string, unknown> = {}) {
  const r = await api.req('POST', '/api/bills', sampleBill(over));
  if (r.status !== 201) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; share_token: string; admin_token: string };
}

export const admin = (b: { admin_token: string }) => ({ 'x-admin-token': b.admin_token });

export async function join(api: Api, token: string, name: string) {
  const r = await api.req('POST', `/api/s/${token}/participants`, { name });
  if (r.status !== 201) throw new Error(`join failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { 'x-participant-id': r.body.participant_id, 'x-participant-token': r.body.participant_token } as Record<string, string>;
}

export const claim = (api: Api, token: string, h: Record<string, string>, itemId: string, units: number) =>
  api.req('PUT', `/api/s/${token}/claims`, { item_id: itemId, units }, h);
export const share = (api: Api, token: string, h: Record<string, string>, itemId: string, on = true) =>
  api.req('PUT', `/api/s/${token}/claims`, { item_id: itemId, share: on }, h);

export const view = async (api: Api, token: string) => (await api.req('GET', `/api/s/${token}`)).body;
export const itemId = (d: any, name: string): string => d.items.find((i: any) => i.description === name).id;
