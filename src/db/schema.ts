/**
 * Database schema. Written in portable SQL (SQLite now, PostgreSQL later):
 * - TEXT ids, ISO-8601 timestamps stored as TEXT, JSON stored as TEXT
 * - partial unique index (supported by both SQLite and PostgreSQL)
 * See docs/POSTGRES.md for the migration path.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  state TEXT NOT NULL,
  pending_step TEXT,
  tiktok_order_ids TEXT NOT NULL,
  original_package_ids TEXT NOT NULL,
  candidate_package_id TEXT,
  combined_package_id TEXT,
  combine_request_id TEXT,
  combined_at TEXT,
  expected_skus TEXT,
  shiphero_orders TEXT,
  shiphero_master_id TEXT,
  merged_at TEXT,
  shipment_id TEXT,
  tracking_number TEXT,
  carrier TEXT,
  label_cost REAL,
  shipped_at TEXT,
  shipping_provider_id TEXT,
  tracking_source TEXT,
  confirmed_at TEXT,
  window_ends_at TEXT NOT NULL,
  deadline_at TEXT,
  approvals TEXT NOT NULL DEFAULT '{}',
  dry_run INTEGER NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0,
  exception_reason TEXT,
  exception_step TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  locked_by TEXT,
  lock_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_state ON groups(state);

-- One TikTok order can only be in ONE active group at a time.
CREATE TABLE IF NOT EXISTS group_orders (
  tiktok_order_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_group_orders_active ON group_orders(tiktok_order_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_group_orders_group ON group_orders(group_id);

-- Every remote change ("mutation") is recorded here BEFORE it is sent.
-- The unique idempotency_key stops the same change from being sent twice.
CREATE TABLE IF NOT EXISTS operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  dry_run INTEGER NOT NULL,
  request TEXT,
  response TEXT,
  request_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  group_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  dry_run INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_group ON audit(group_id);

-- ShipHero Shipment Update webhooks. Merged orders produce one call per order,
-- all sharing shipment_id + tracking_number. Exact repeats are dropped by dedupe_key.
CREATE TABLE IF NOT EXISTS shipment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  shipment_id TEXT NOT NULL,
  tracking_number TEXT,
  carrier TEXT,
  label_cost REAL,
  order_number TEXT,
  order_uuid TEXT,
  partner_order_id TEXT,
  line_items TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0,
  raw TEXT NOT NULL,
  received_at TEXT NOT NULL,
  duplicates INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ship_events_shipment ON shipment_events(shipment_id);
CREATE INDEX IF NOT EXISTS idx_ship_events_order ON shipment_events(order_uuid);

CREATE TABLE IF NOT EXISTS tokens (
  provider TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  access_expires_at TEXT,
  refresh_expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
