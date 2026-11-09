# Moving to PostgreSQL (multiple machines)

SQLite is right for one PC. To run several workers on different machines, move to PostgreSQL:

1. The schema in `src/db/schema.ts` is portable. Change `INTEGER PRIMARY KEY AUTOINCREMENT` to
   `BIGSERIAL PRIMARY KEY`. Everything else (TEXT ids, ISO timestamps, JSON-as-TEXT, the partial unique
   index `WHERE active = 1`) works unchanged. Optionally switch JSON columns to `JSONB`.
2. Replace `Repo`'s `node:sqlite` calls with a `pg` pool (same method names; `?` placeholders become `$1, $2…`).
   `BEGIN IMMEDIATE` becomes `BEGIN`.
3. The group lock (`UPDATE … WHERE locked_by IS NULL OR lock_expires_at < now`) is a single atomic
   statement and works the same in PostgreSQL. For extra safety, add `SELECT … FOR UPDATE SKIP LOCKED`
   when listing groups.
4. The idempotency guarantees come from the `UNIQUE` constraints on `operations.idempotency_key`,
   `shipment_events.dedupe_key` and the active `group_orders` index, so they carry over automatically.
5. Copy data with a one-off script (read every table from SQLite and insert into PostgreSQL), or start fresh
   once all groups are TIKTOK_CONFIRMED or DISSOLVED.
