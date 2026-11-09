import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';

export const STATES = [
  'DETECTED',
  'ELIGIBLE',
  'AWAITING_APPROVAL',
  'TIKTOK_COMBINED',
  'SHIPHERO_MERGED',
  'READY_TO_FULFILL',
  'SHIPPED',
  'TIKTOK_CONFIRMED',
  'EXCEPTION',
  'DISSOLVED', // no longer combinable BEFORE anything was changed — orders go back to normal flow
] as const;
export type GroupState = (typeof STATES)[number];
export type Step = 'combine' | 'merge' | 'ship';

export interface ShipHeroOrderRef {
  tiktokOrderId: string;
  id: string; // ShipHero internal order id
  orderNumber: string;
  warehouseId: string | null;
  uuid?: string | null;
}

export interface Group {
  id: string;
  shop_id: string;
  state: GroupState;
  pending_step: Step | null;
  tiktok_order_ids: string[];
  original_package_ids: string[];
  candidate_package_id: string | null;
  combined_package_id: string | null;
  combine_request_id: string | null;
  combined_at: string | null;
  expected_skus: Record<string, number> | null;
  shiphero_orders: ShipHeroOrderRef[] | null;
  shiphero_master_id: string | null;
  merged_at: string | null;
  shipment_id: string | null;
  tracking_number: string | null;
  carrier: string | null;
  label_cost: number | null;
  shipped_at: string | null;
  shipping_provider_id: string | null;
  tracking_source: string | null;
  confirmed_at: string | null;
  window_ends_at: string;
  deadline_at: string | null;
  approvals: Partial<Record<Step, { at: string; by: string }>>;
  dry_run: boolean;
  simulated: boolean;
  exception_reason: string | null;
  exception_step: string | null;
  attempts: number;
  next_attempt_at: string | null;
  locked_by: string | null;
  lock_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export type OpStatus = 'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'SIMULATED';
export interface Operation {
  id: number;
  group_id: string;
  kind: string;
  idempotency_key: string;
  status: OpStatus;
  dry_run: boolean;
  request: unknown;
  response: unknown;
  request_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShipmentEvent {
  id: number;
  dedupe_key: string;
  shipment_id: string;
  tracking_number: string | null;
  carrier: string | null;
  label_cost: number | null;
  order_number: string | null;
  order_uuid: string | null;
  partner_order_id: string | null;
  line_items: { sku: string; quantity: number; line_item_id?: string }[];
  is_test: boolean;
  received_at: string;
  duplicates: number;
}

const JSON_COLS = ['tiktok_order_ids', 'original_package_ids', 'expected_skus', 'shiphero_orders', 'approvals'] as const;
const BOOL_COLS = ['dry_run', 'simulated'] as const;

export const nowIso = (clock: () => number = Date.now) => new Date(clock()).toISOString();

export class Repo {
  readonly db: DatabaseSync;
  constructor(file: string, public clock: () => number = Date.now) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA_SQL);
    this.db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  }

  now() { return nowIso(this.clock); }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------------- groups ----------------
  private rowToGroup(r: Record<string, unknown>): Group {
    const g: Record<string, unknown> = { ...r };
    for (const c of JSON_COLS) g[c] = r[c] == null ? null : JSON.parse(String(r[c]));
    for (const c of BOOL_COLS) g[c] = Boolean(r[c]);
    if (!g.approvals) g.approvals = {};
    return g as unknown as Group;
  }

  /**
   * Create a group. Fails (returns null) if any order already belongs to an active group.
   */
  createGroup(input: {
    shopId: string;
    tiktokOrderIds: string[];
    packageIds: string[];
    candidatePackageId: string;
    windowEndsAt: string;
    deadlineAt: string | null;
    dryRun: boolean;
  }): Group | null {
    const id = crypto.randomUUID();
    const ts = this.now();
    try {
      return this.tx(() => {
        this.db
          .prepare(
            `INSERT INTO groups (id, shop_id, state, tiktok_order_ids, original_package_ids, candidate_package_id, window_ends_at, deadline_at, dry_run, created_at, updated_at)
             VALUES (?, ?, 'DETECTED', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, input.shopId, JSON.stringify(input.tiktokOrderIds), JSON.stringify(input.packageIds), input.candidatePackageId, input.windowEndsAt, input.deadlineAt, input.dryRun ? 1 : 0, ts, ts);
        const ins = this.db.prepare('INSERT INTO group_orders (tiktok_order_id, group_id, active) VALUES (?, ?, 1)');
        for (const o of input.tiktokOrderIds) ins.run(o, id);
        return this.getGroup(id)!;
      });
    } catch (e) {
      if (String(e).includes('UNIQUE')) return null;
      throw e;
    }
  }

  getGroup(id: string): Group | null {
    const r = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToGroup(r) : null;
  }

  listGroups(states?: GroupState[]): Group[] {
    const rows = states?.length
      ? this.db.prepare(`SELECT * FROM groups WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY created_at`).all(...states)
      : this.db.prepare('SELECT * FROM groups ORDER BY created_at DESC').all();
    return (rows as Record<string, unknown>[]).map((r) => this.rowToGroup(r));
  }

  activeGroupForOrder(tiktokOrderId: string): Group | null {
    const r = this.db.prepare('SELECT group_id FROM group_orders WHERE tiktok_order_id = ? AND active = 1').get(tiktokOrderId) as { group_id: string } | undefined;
    return r ? this.getGroup(r.group_id) : null;
  }

  groupForShipHeroOrder(shipheroOrderId: string | null, orderNumber: string | null, partnerOrderId: string | null): Group | null {
    for (const g of this.listGroups(['SHIPHERO_MERGED', 'READY_TO_FULFILL', 'SHIPPED', 'EXCEPTION'])) {
      for (const o of g.shiphero_orders ?? []) {
        if ((shipheroOrderId && (o.id === shipheroOrderId || o.uuid === shipheroOrderId)) || (orderNumber && o.orderNumber === orderNumber) || (partnerOrderId && o.tiktokOrderId === partnerOrderId)) return g;
      }
    }
    return null;
  }

  updateGroup(id: string, patch: Partial<Omit<Group, 'id'>>): Group {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      if ((JSON_COLS as readonly string[]).includes(k)) vals.push(v == null ? null : JSON.stringify(v));
      else if ((BOOL_COLS as readonly string[]).includes(k)) vals.push(v ? 1 : 0);
      else vals.push(v as string | number | null);
    }
    sets.push('updated_at = ?');
    vals.push(this.now());
    this.db.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    // Release order membership when a group ends without having changed anything remotely.
    if (patch.state === 'DISSOLVED') this.db.prepare('UPDATE group_orders SET active = 0 WHERE group_id = ?').run(id);
    return this.getGroup(id)!;
  }

  /** Atomic lock: only one worker can hold a group at a time. Expired locks can be taken over (crash recovery). */
  acquireLock(groupId: string, workerId: string, ttlMs = 120_000): boolean {
    const now = this.now();
    const exp = nowIso(() => this.clock() + ttlMs);
    const r = this.db
      .prepare(`UPDATE groups SET locked_by = ?, lock_expires_at = ? WHERE id = ? AND (locked_by IS NULL OR locked_by = ? OR lock_expires_at < ?)`)
      .run(workerId, exp, groupId, workerId, now);
    return Number(r.changes) === 1;
  }
  releaseLock(groupId: string, workerId: string) {
    this.db.prepare('UPDATE groups SET locked_by = NULL, lock_expires_at = NULL WHERE id = ? AND locked_by = ?').run(groupId, workerId);
  }

  // ---------------- operations (idempotency ledger) ----------------
  private rowToOp(r: Record<string, unknown>): Operation {
    return {
      ...(r as unknown as Operation),
      dry_run: Boolean(r.dry_run),
      request: r.request ? JSON.parse(String(r.request)) : null,
      response: r.response ? JSON.parse(String(r.response)) : null,
    };
  }
  getOp(key: string): Operation | null {
    const r = this.db.prepare('SELECT * FROM operations WHERE idempotency_key = ?').get(key) as Record<string, unknown> | undefined;
    return r ? this.rowToOp(r) : null;
  }
  listOps(groupId?: string): Operation[] {
    const rows = groupId
      ? this.db.prepare('SELECT * FROM operations WHERE group_id = ? ORDER BY id').all(groupId)
      : this.db.prepare('SELECT * FROM operations ORDER BY id DESC LIMIT 500').all();
    return (rows as Record<string, unknown>[]).map((r) => this.rowToOp(r));
  }
  /** Returns false if an operation with this key already exists (never send twice). */
  beginOp(groupId: string, kind: string, key: string, request: unknown, dryRun: boolean): boolean {
    const ts = this.now();
    try {
      this.db
        .prepare(`INSERT INTO operations (group_id, kind, idempotency_key, status, dry_run, request, created_at, updated_at) VALUES (?, ?, ?, 'IN_FLIGHT', ?, ?, ?, ?)`)
        .run(groupId, kind, key, dryRun ? 1 : 0, JSON.stringify(request), ts, ts);
      return true;
    } catch (e) {
      if (String(e).includes('UNIQUE')) return false;
      throw e;
    }
  }
  finishOp(key: string, status: OpStatus, response: unknown, requestId: string | null, error: string | null = null) {
    this.db
      .prepare('UPDATE operations SET status = ?, response = ?, request_id = ?, error = ?, updated_at = ? WHERE idempotency_key = ?')
      .run(status, JSON.stringify(response ?? null), requestId, error, this.now(), key);
  }
  /** Allow a FAILED (definitely-not-applied) operation to be retried by an operator. */
  resetFailedOp(key: string) {
    this.db.prepare(`DELETE FROM operations WHERE idempotency_key = ? AND status = 'FAILED'`).run(key);
  }

  // ---------------- audit ----------------
  audit(groupId: string | null, actor: string, action: string, dryRun: boolean, detail?: unknown) {
    this.db
      .prepare('INSERT INTO audit (ts, group_id, actor, action, dry_run, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.now(), groupId, actor, action, dryRun ? 1 : 0, detail === undefined ? null : JSON.stringify(detail));
  }
  listAudit(groupId?: string, limit = 300): { id: number; ts: string; group_id: string | null; actor: string; action: string; dry_run: number; detail: unknown }[] {
    const rows = groupId
      ? this.db.prepare('SELECT * FROM audit WHERE group_id = ? ORDER BY id DESC LIMIT ?').all(groupId, limit)
      : this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit);
    return (rows as Record<string, unknown>[]).map((r) => ({ ...r, detail: r.detail ? JSON.parse(String(r.detail)) : null })) as ReturnType<Repo['listAudit']>;
  }

  // ---------------- shipment events ----------------
  /** Returns 'new' or 'duplicate'. */
  insertShipmentEvent(e: Omit<ShipmentEvent, 'id' | 'received_at' | 'duplicates'> & { raw: unknown }): 'new' | 'duplicate' {
    try {
      this.db
        .prepare(
          `INSERT INTO shipment_events (dedupe_key, shipment_id, tracking_number, carrier, label_cost, order_number, order_uuid, partner_order_id, line_items, is_test, raw, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(e.dedupe_key, e.shipment_id, e.tracking_number, e.carrier, e.label_cost, e.order_number, e.order_uuid, e.partner_order_id, JSON.stringify(e.line_items), e.is_test ? 1 : 0, JSON.stringify(e.raw), this.now());
      return 'new';
    } catch (err) {
      if (String(err).includes('UNIQUE')) {
        this.db.prepare('UPDATE shipment_events SET duplicates = duplicates + 1 WHERE dedupe_key = ?').run(e.dedupe_key);
        return 'duplicate';
      }
      throw err;
    }
  }
  shipmentEventsFor(filter: { orderNumbers: string[]; partnerOrderIds: string[]; uuids: string[] }): ShipmentEvent[] {
    const rows = this.db.prepare('SELECT * FROM shipment_events WHERE is_test = 0 ORDER BY id').all() as Record<string, unknown>[];
    return rows
      .map((r) => ({ ...(r as unknown as ShipmentEvent), is_test: Boolean(r.is_test), line_items: JSON.parse(String(r.line_items)) }))
      .filter((e) => (e.order_number && filter.orderNumbers.includes(e.order_number)) || (e.partner_order_id && filter.partnerOrderIds.includes(e.partner_order_id)) || (e.order_uuid && filter.uuids.includes(e.order_uuid)));
  }
  countShipmentEvents() {
    return this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(duplicates),0) AS d FROM shipment_events').get() as { n: number; d: number };
  }

  // ---------------- tokens & settings ----------------
  getToken(provider: string) {
    return (this.db.prepare('SELECT * FROM tokens WHERE provider = ?').get(provider) as
      | { access_token: string | null; refresh_token: string | null; access_expires_at: string | null; refresh_expires_at: string | null }
      | undefined) ?? null;
  }
  saveToken(provider: string, t: { access_token: string; refresh_token?: string | null; access_expires_at?: string | null; refresh_expires_at?: string | null }) {
    this.db
      .prepare(
        `INSERT INTO tokens (provider, access_token, refresh_token, access_expires_at, refresh_expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET access_token = excluded.access_token,
           refresh_token = COALESCE(excluded.refresh_token, tokens.refresh_token),
           access_expires_at = excluded.access_expires_at,
           refresh_expires_at = COALESCE(excluded.refresh_expires_at, tokens.refresh_expires_at),
           updated_at = excluded.updated_at`,
      )
      .run(provider, t.access_token, t.refresh_token ?? null, t.access_expires_at ?? null, t.refresh_expires_at ?? null, this.now());
  }
  getSetting<T>(key: string, def: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : def;
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  close() { this.db.close(); }
}
