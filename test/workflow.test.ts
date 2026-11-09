import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from '../src/mocks/harness.ts';
import { ingestShipmentEvent } from '../src/webhooks/shiphero.ts';

const combineCalls = (h: ReturnType<typeof createHarness>) => h.tt.calls.filter((c) => c.path.endsWith('/packages/combine')).length;
const shipCalls = (h: ReturnType<typeof createHarness>) => h.tt.calls.filter((c) => c.path.endsWith('/ship')).length;
const only = (h: ReturnType<typeof createHarness>) => {
  const gs = h.repo.listGroups();
  assert.equal(gs.length, 1, `expected 1 group, got ${gs.length}`);
  return gs[0];
};

/** Drive one group from discovery to warehouse-ready. */
async function toReady(h: ReturnType<typeof createHarness>) {
  await h.engine.tick(); // discover
  h.advance(6); // consolidation window passes
  await h.engine.tick(); // combine + merge
  return only(h);
}
function shipAndDeliverWebhooks(h: ReturnType<typeof createHarness>, tracking = '1Z999AA10123456784', carrier = 'UPS', times = 1) {
  const g = only(h);
  const payloads = h.sh.shipMerged(g.shiphero_master_id!, tracking, carrier);
  const results: string[] = [];
  for (let i = 0; i < times; i++) for (const p of payloads) results.push(ingestShipmentEvent(h.repo, p).result);
  return { payloads, results };
}

test('two eligible orders: combine in TikTok → merge in ShipHero → one label → tracking on combined package', async () => {
  const h = createHarness();
  h.seedOrder('A1', 'alice', { 'COLD-SPF': 1 });
  h.seedOrder('A2', 'alice', { 'COLD-WASH': 2 });
  await h.engine.tick();
  let g = only(h);
  assert.equal(g.state, 'ELIGIBLE');
  assert.equal(combineCalls(h), 0, 'must wait for the consolidation window');

  h.advance(6);
  await h.engine.tick();
  g = only(h);
  assert.equal(g.state, 'READY_TO_FULFILL');
  assert.ok(g.combined_package_id?.startsWith('CPKG-'));
  assert.deepEqual(h.tt.packages.get(g.combined_package_id!)!.orderIds.sort(), ['A1', 'A2']);
  assert.equal(h.sh.mutations.length, 1);
  // ShipHero merge happened AFTER TikTok combine
  const order = h.repo.listAudit(g.id).reverse().map((a) => a.action);
  assert.ok(order.indexOf('tiktok_combined_verified') < order.indexOf('shiphero_merge_sent'));

  shipAndDeliverWebhooks(h);
  await h.engine.tick();
  g = only(h);
  assert.equal(g.state, 'TIKTOK_CONFIRMED');
  assert.equal(g.tracking_number, '1Z999AA10123456784');
  assert.equal(g.shipping_provider_id, 'PRV-UPS');
  assert.equal(g.tracking_source, 'engine');
  const shipReq = h.tt.calls.find((c) => c.path.endsWith('/ship'))!;
  assert.equal(shipReq.path, `/fulfillment/202309/packages/${g.combined_package_id}/ship`);
  assert.deepEqual(shipReq.body, { self_shipment: { tracking_number: '1Z999AA10123456784', shipping_provider_id: 'PRV-UPS' } });
  for (const id of ['A1', 'A2']) assert.equal(h.tt.orders.get(id)!.status, 'AWAITING_COLLECTION');
  assert.equal(h.engine.metrics().labelsAvoided, 1);
});

test('three eligible orders combine into one package', async () => {
  const h = createHarness();
  h.seedOrder('B1', 'bob', { X: 1 });
  h.seedOrder('B2', 'bob', { Y: 1 });
  h.seedOrder('B3', 'bob', { X: 1, Z: 1 });
  let g = await toReady(h);
  assert.equal(g.state, 'READY_TO_FULFILL');
  assert.equal(g.tiktok_order_ids.length, 3);
  assert.deepEqual(g.expected_skus, { X: 2, Y: 1, Z: 1 });
  const merge = h.sh.mutations[0].variables.data as { sub_order_ids: string[] };
  assert.equal(merge.sub_order_ids.length, 2);
  shipAndDeliverWebhooks(h);
  await h.engine.tick();
  g = only(h);
  assert.equal(g.state, 'TIKTOK_CONFIRMED');
  assert.equal(h.engine.metrics().labelsAvoided, 2);
});

test('different addresses: TikTok does not report them combinable → nothing happens', async () => {
  const h = createHarness();
  h.seedOrder('C1', 'carol-home', { X: 1 });
  h.seedOrder('C2', 'carol-work', { X: 1 });
  await h.engine.tick();
  h.advance(10);
  await h.engine.tick();
  assert.equal(h.repo.listGroups().length, 0);
  assert.equal(h.tt.mutations.length + h.sh.mutations.length, 0);
});

test('different warehouses in ShipHero: group dissolved before any change', async () => {
  const h = createHarness();
  h.seedOrder('D1', 'dan', { X: 1 }, {}, 'WH-1');
  h.seedOrder('D2', 'dan', { X: 1 }, {}, 'WH-2');
  const g = await toReady(h);
  assert.equal(g.state, 'DISSOLVED');
  assert.match(g.exception_reason!, /warehouse|mergeable/i);
  assert.equal(combineCalls(h), 0);
  // orders are released back to normal flow
  assert.equal(h.repo.activeGroupForOrder('D1'), null);
});

test('different TikTok warehouses: rejected by safety filter', async () => {
  const h = createHarness();
  h.seedOrder('D3', 'dee', { X: 1 }, { warehouse_id: 'WH-1' });
  h.seedOrder('D4', 'dee', { X: 1 }, { warehouse_id: 'WH-9' });
  await h.engine.tick();
  assert.equal(h.repo.listGroups().length, 0); // fake TikTok also keys on warehouse; no candidate at all
});

test('order already shipped in ShipHero: dissolved, TikTok untouched', async () => {
  const h = createHarness();
  h.seedOrder('E1', 'eve', { X: 1 });
  const e2 = h.seedOrder('E2', 'eve', { X: 1 });
  e2.fulfillment_status = 'fulfilled';
  e2.line_items[0].quantity_shipped = 1;
  const g = await toReady(h);
  assert.equal(g.state, 'DISSOLVED');
  assert.equal(combineCalls(h), 0);
});

test('order shipped between combine-approval and merge → exception, TikTok combination kept', async () => {
  const h = createHarness({ autoCombine: false });
  h.seedOrder('E3', 'erin', { X: 1 });
  const sh4 = h.seedOrder('E4', 'erin', { X: 1 });
  let g = await toReady(h);
  assert.equal(g.state, 'AWAITING_APPROVAL');
  h.engine.approve(g.id, 'combine', 'joe');
  sh4.fulfillment_status = 'fulfilled'; // warehouse shipped it separately in the meantime
  await h.engine.processGroup(g.id);
  g = only(h);
  assert.equal(g.state, 'EXCEPTION');
  assert.equal(g.exception_step, 'merge');
  assert.ok(g.combined_package_id);
  assert.equal(h.sh.mutations.length, 0);
  assert.equal(h.tt.calls.filter((c) => c.path.includes('uncombine')).length, 0);
});

test('cancelled order / after-sale request is never combined', async () => {
  const h = createHarness();
  h.seedOrder('F1', 'fay', { X: 1 });
  h.seedOrder('F2', 'fay', { X: 1 }, { cancel_reason: 'Buyer requested cancellation' });
  h.seedOrder('F3', 'fay', { Y: 1 }, { is_on_hold_order: true });
  await h.engine.tick();
  h.advance(10);
  await h.engine.tick();
  assert.equal(h.repo.listGroups().length, 0);
  assert.equal(h.tt.mutations.length, 0);
});

test('TikTok combine timeout AFTER it applied: re-query shows combined, no second combine call', async () => {
  const h = createHarness();
  h.seedOrder('G1', 'gus', { X: 1 });
  h.seedOrder('G2', 'gus', { X: 1 });
  h.tt.fail.combineTimeoutAfterApply = true;
  let g = await toReady(h);
  assert.equal(g.state, 'ELIGIBLE'); // op is UNKNOWN; waiting to reconcile
  assert.equal(h.repo.getOp(`tt_combine:${g.id}`)!.status, 'UNKNOWN');
  await h.engine.tick();
  g = only(h);
  assert.equal(g.state, 'READY_TO_FULFILL');
  assert.equal(combineCalls(h), 1, 'combine must not be sent twice');
});

test('TikTok combine timeout BEFORE it applied: verified not applied, then retried once', async () => {
  const h = createHarness();
  h.seedOrder('G3', 'gil', { X: 1 });
  h.seedOrder('G4', 'gil', { X: 1 });
  h.tt.fail.combineTimeoutBeforeApply = true;
  await toReady(h);
  await h.engine.tick();
  const g = only(h);
  assert.equal(g.state, 'READY_TO_FULFILL');
  assert.equal(combineCalls(h), 2);
});

test('search API timeouts are retried (read-only)', async () => {
  const h = createHarness();
  h.seedOrder('G5', 'gwen', { X: 1 });
  h.seedOrder('G6', 'gwen', { X: 1 });
  h.tt.fail.searchTimeouts = 2;
  await h.engine.tick();
  assert.equal(only(h).state, 'ELIGIBLE');
});

test('ShipHero merge timeout after apply: reconciled via merged_orders, merge sent once', async () => {
  const h = createHarness();
  h.seedOrder('H1', 'hal', { X: 1 });
  h.seedOrder('H2', 'hal', { X: 1 });
  h.sh.fail.mergeTimeoutAfterApply = true;
  await toReady(h);
  assert.equal(only(h).state, 'TIKTOK_COMBINED');
  await h.engine.tick();
  assert.equal(only(h).state, 'READY_TO_FULFILL');
  assert.equal(h.sh.mutations.length, 1);
});

test('partial TikTok combination → EXCEPTION, ShipHero untouched, not auto-retried', async () => {
  const h = createHarness();
  h.seedOrder('I1', 'ivy', { X: 1 });
  h.seedOrder('I2', 'ivy', { X: 1 });
  h.seedOrder('I3', 'ivy', { X: 1 });
  h.tt.fail.combinePartial = true;
  const g = await toReady(h);
  assert.equal(g.state, 'EXCEPTION');
  assert.match(g.exception_reason!, /Partial TikTok combination/);
  assert.ok(g.combined_package_id, 'partial package id is recorded');
  assert.equal(h.sh.mutations.length, 0);
  assert.throws(() => h.engine.retry(g.id, 'joe'), /already \(partly\) combined/);
  await h.engine.tick();
  assert.equal(combineCalls(h), 1);
});

test('ShipHero merge failure → EXCEPTION, TikTok combination NOT reversed, retry succeeds', async () => {
  const h = createHarness();
  h.seedOrder('J1', 'jay', { X: 1 });
  h.seedOrder('J2', 'jay', { X: 1 });
  h.sh.fail.mergeError = true;
  let g = await toReady(h);
  assert.equal(g.state, 'EXCEPTION');
  assert.equal(g.exception_step, 'merge');
  assert.equal(h.tt.packages.get(g.combined_package_id!)!.orderIds.length, 2, 'TikTok package stays combined');
  assert.equal(h.tt.calls.filter((c) => c.path.includes('uncombine')).length, 0);
  h.engine.retry(g.id, 'joe');
  await h.engine.tick();
  g = only(h);
  assert.equal(g.state, 'READY_TO_FULFILL');
  assert.equal(combineCalls(h), 1);
});

test('missing SKU quantities: ShipHero order differs from TikTok → dissolved before combine', async () => {
  const h = createHarness();
  h.seedOrder('K1', 'kim', { X: 2 });
  const k2 = h.seedOrder('K2', 'kim', { Y: 1 });
  k2.line_items[0].quantity = 0; // ShipHero imported the wrong quantity
  const g = await toReady(h);
  assert.equal(g.state, 'DISSOLVED');
  assert.match(g.exception_reason!, /SKU\/quantity mismatch/);
  assert.equal(combineCalls(h), 0);
});

test('duplicate fulfillment lines after merge → post-merge verification fails', async () => {
  const h = createHarness();
  h.seedOrder('K3', 'kit', { X: 1 });
  h.seedOrder('K4', 'kit', { Y: 1 });
  h.sh.fail.duplicateLinesOnMerge = true;
  const g = await toReady(h);
  assert.equal(g.state, 'EXCEPTION');
  assert.match(g.exception_reason!, /duplicate fulfillment line|SKU totals/);
});

test('duplicate ShipHero shipment webhooks: deduplicated, ONE tracking submission', async () => {
  const h = createHarness();
  h.seedOrder('L1', 'lee', { X: 1 });
  h.seedOrder('L2', 'lee', { Y: 1 });
  await toReady(h);
  const { results } = shipAndDeliverWebhooks(h, '1ZDUP', 'UPS', 3); // every webhook delivered 3 times
  assert.deepEqual(results.filter((r) => r === 'new').length, 2, 'one row per order in the merge');
  assert.equal(results.filter((r) => r === 'duplicate').length, 4);
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(only(h).state, 'TIKTOK_CONFIRMED');
  assert.equal(shipCalls(h), 1);
});

test('duplicate tracking submission is impossible: timeout after apply is reconciled, extra ticks do nothing', async () => {
  const h = createHarness();
  h.seedOrder('M1', 'mo', { X: 1 });
  h.seedOrder('M2', 'mo', { X: 1 });
  await toReady(h);
  shipAndDeliverWebhooks(h, '1ZTIMEOUT');
  h.tt.fail.shipTimeoutAfterApply = true;
  await h.engine.tick();
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(only(h).state, 'TIKTOK_CONFIRMED');
  assert.equal(shipCalls(h), 1);
});

test('missing per-order webhook: waits, then EXCEPTION after grace period', async () => {
  const h = createHarness();
  h.seedOrder('N1', 'nia', { X: 1 });
  h.seedOrder('N2', 'nia', { Y: 1 });
  await toReady(h);
  const g = only(h);
  const payloads = h.sh.shipMerged(g.shiphero_master_id!, '1ZPART');
  ingestShipmentEvent(h.repo, payloads[0]); // only the master's webhook arrives
  h.sh.shipments = []; // and polling can't see it either
  await h.engine.tick();
  assert.equal(only(h).state, 'READY_TO_FULFILL');
  h.advance(45);
  await h.engine.tick();
  assert.equal(only(h).state, 'EXCEPTION');
  assert.equal(shipCalls(h), 0);
});

test('unexpected native/manual tracking BEFORE our shipment → EXCEPTION, nothing submitted', async () => {
  const h = createHarness();
  h.seedOrder('O1', 'oz', { X: 1 });
  h.seedOrder('O2', 'oz', { X: 1 });
  const g = await toReady(h);
  h.tt.externalTrackingUpdate(g.combined_package_id!, '9400NATIVE');
  await h.engine.tick();
  assert.equal(only(h).state, 'EXCEPTION');
  assert.equal(shipCalls(h), 0);
});

test('native update with DIFFERENT tracking than ShipHero shipped → EXCEPTION', async () => {
  const h = createHarness({ trackingMode: 'native_verify' });
  h.seedOrder('O3', 'ola', { X: 1 });
  h.seedOrder('O4', 'ola', { X: 1 });
  await toReady(h);
  shipAndDeliverWebhooks(h, '1ZREAL');
  await h.engine.tick();
  assert.equal(only(h).state, 'SHIPPED');
  h.tt.externalTrackingUpdate(only(h).combined_package_id!, '1ZOTHER');
  await h.engine.tick();
  const g = only(h);
  assert.equal(g.state, 'EXCEPTION');
  assert.match(g.exception_reason!, /unexpected update/);
});

test('native_verify mode: native integration posts the SAME tracking → confirmed, engine never submits', async () => {
  const h = createHarness({ trackingMode: 'native_verify' });
  h.seedOrder('O5', 'oli', { X: 1 });
  h.seedOrder('O6', 'oli', { X: 1 });
  await toReady(h);
  shipAndDeliverWebhooks(h, '1ZNATIVE');
  await h.engine.tick();
  h.tt.externalTrackingUpdate(only(h).combined_package_id!, '1ZNATIVE');
  await h.engine.tick();
  const g = only(h);
  assert.equal(g.state, 'TIKTOK_CONFIRMED');
  assert.equal(g.tracking_source, 'native');
  assert.equal(shipCalls(h), 0);
});

test('native_verify mode: native never posts → EXCEPTION after grace, engine still does not submit', async () => {
  const h = createHarness({ trackingMode: 'native_verify' });
  h.seedOrder('O7', 'oma', { X: 1 });
  h.seedOrder('O8', 'oma', { X: 1 });
  await toReady(h);
  shipAndDeliverWebhooks(h, '1ZWAIT');
  await h.engine.tick();
  h.advance(120);
  await h.engine.tick();
  assert.equal(only(h).state, 'EXCEPTION');
  assert.equal(shipCalls(h), 0);
});

test('USPS shipment in engine mode is blocked for manual review', async () => {
  const h = createHarness();
  h.seedOrder('P1', 'pat', { X: 1 });
  h.seedOrder('P2', 'pat', { X: 1 });
  await toReady(h);
  shipAndDeliverWebhooks(h, '9400111899223', 'USPS');
  await h.engine.tick();
  const g = only(h);
  assert.equal(g.state, 'EXCEPTION');
  assert.match(g.exception_reason!, /BLOCKED_CARRIERS/);
  assert.equal(shipCalls(h), 0);
});

test('restart during an unfinished transaction: new process takes over expired lock and reconciles', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cme-'));
  const dbFile = path.join(dir, 'db.sqlite');
  const h1 = createHarness({ dbFile, workerId: 'old-process' });
  h1.seedOrder('Q1', 'quinn', { X: 1 });
  h1.seedOrder('Q2', 'quinn', { X: 1 });
  await h1.engine.tick();
  h1.advance(6);
  // Simulate: old process locked the group, wrote IN_FLIGHT, sent combine (TikTok applied it), then crashed.
  const g0 = only(h1);
  h1.repo.updateGroup(g0.id, { candidate_package_id: 'PKG-Q1', shiphero_orders: [
    { tiktokOrderId: 'Q1', id: h1.sh.byPartner('Q1').id, orderNumber: 'TT-Q1', warehouseId: 'WH-1' },
    { tiktokOrderId: 'Q2', id: h1.sh.byPartner('Q2').id, orderNumber: 'TT-Q2', warehouseId: 'WH-1' },
  ], shiphero_master_id: h1.sh.byPartner('Q1').id, state: 'AWAITING_APPROVAL', pending_step: 'combine', approvals: { combine: { at: 'x', by: 'joe' } } });
  assert.ok(h1.repo.acquireLock(g0.id, 'old-process', 60_000));
  h1.repo.beginOp(g0.id, 'TT_COMBINE', `tt_combine:${g0.id}`, {}, false);
  await h1.tiktok.combinePackages([{ packageId: 'PKG-Q1', orderIds: ['Q1', 'Q2'] }]);
  h1.repo.close(); // crash

  // New process, same database file, 2 minutes later
  const repo2 = new (await import('../src/db/repo.ts')).Repo(dbFile, () => h1.clock.now);
  const h2 = createHarness({ shared: { repo: repo2, tt: h1.tt, sh: h1.sh, clock: h1.clock }, workerId: 'new-process' });
  await h2.engine.tick();
  assert.equal(only(h2).state, 'AWAITING_APPROVAL', 'lock still held by old process — must not touch');
  h2.advance(2);
  await h2.engine.tick();
  const g = only(h2);
  assert.equal(g.state, 'READY_TO_FULFILL');
  assert.equal(combineCalls(h2), 1, 'no second combine after restart');
  repo2.close();
});

test('two workers at once: only one sends the combine', async () => {
  const a = createHarness({ workerId: 'w1' });
  a.seedOrder('R1', 'ray', { X: 1 });
  a.seedOrder('R2', 'ray', { X: 1 });
  const b = createHarness({ shared: { repo: a.repo, tt: a.tt, sh: a.sh, clock: a.clock }, workerId: 'w2' });
  await Promise.all([a.engine.tick(), b.engine.tick()]);
  assert.equal(a.repo.listGroups().length, 1, 'one group even with two discoverers');
  a.advance(6);
  await Promise.all([a.engine.tick(), b.engine.tick()]);
  await Promise.all([a.engine.tick(), b.engine.tick()]);
  assert.equal(combineCalls(a), 1);
  assert.equal(a.sh.mutations.length, 1);
});

test('DRY RUN: whole flow simulated, ZERO mutations reach TikTok or ShipHero', async () => {
  const h = createHarness({ dryRun: true });
  h.seedOrder('S1', 'sam', { X: 1 });
  h.seedOrder('S2', 'sam', { Y: 1 });
  const g = await toReady(h);
  assert.equal(g.state, 'READY_TO_FULFILL');
  assert.equal(g.simulated, true);
  assert.equal(h.tt.mutations.length, 0);
  assert.equal(h.sh.mutations.length, 0);
  assert.equal(h.repo.listOps(g.id).every((o) => o.status === 'SIMULATED'), true);
  assert.equal(h.tt.packages.get('PKG-S1')!.orderIds.length, 1, 'TikTok data untouched');
  assert.equal(h.engine.metrics().labelsAvoided, 0, 'simulations do not count as savings');
});

test('PILOT: approval required before EVERY mutation; only listed orders; groups of 2 only', async () => {
  const h = createHarness({ pilotMode: true, pilotOrderIds: ['T1', 'T2'], trackingMode: 'engine' });
  h.seedOrder('T1', 'tia', { X: 1 });
  h.seedOrder('T2', 'tia', { Y: 1 });
  h.seedOrder('U1', 'uma', { X: 1 });
  h.seedOrder('U2', 'uma', { X: 1 }); // not on the pilot list
  await h.engine.tick();
  h.advance(6);
  await h.engine.tick();
  let g = only(h);
  assert.deepEqual(g.tiktok_order_ids.sort(), ['T1', 'T2']);
  assert.equal(g.state, 'AWAITING_APPROVAL');
  assert.equal(g.pending_step, 'combine');
  assert.equal(combineCalls(h), 0);
  assert.throws(() => h.engine.approve(g.id, 'merge', 'joe'));

  h.engine.approve(g.id, 'combine', 'joe');
  await h.engine.tick();
  g = only(h);
  assert.equal(g.pending_step, 'merge');
  assert.equal(combineCalls(h), 1);
  assert.equal(h.sh.mutations.length, 0);

  h.engine.approve(g.id, 'merge', 'joe');
  await h.engine.tick();
  assert.equal(only(h).state, 'READY_TO_FULFILL');

  shipAndDeliverWebhooks(h, '1ZPILOT');
  await h.engine.tick();
  g = only(h);
  assert.equal(g.pending_step, 'ship');
  assert.equal(shipCalls(h), 0);
  h.engine.approve(g.id, 'ship', 'joe');
  await h.engine.tick();
  assert.equal(only(h).state, 'TIKTOK_CONFIRMED');
  assert.throws(() => h.engine.updateSettings({ autoCombine: true }, 'joe'), /PILOT_MODE/);
});

test('pause stops new mutations but keeps reading', async () => {
  const h = createHarness();
  h.seedOrder('V1', 'val', { X: 1 });
  h.seedOrder('V2', 'val', { X: 1 });
  await h.engine.tick();
  h.engine.updateSettings({ paused: true }, 'joe');
  h.advance(6);
  await h.engine.tick();
  assert.equal(combineCalls(h), 0);
  h.engine.updateSettings({ paused: false }, 'joe');
  await h.engine.tick();
  assert.equal(only(h).state, 'READY_TO_FULFILL');
});

test('consolidation window never pushes past the ship-by deadline safety margin', async () => {
  const h = createHarness({ windowMinutes: 600 });
  const soon = Math.floor(h.clock.now / 1000) + 13 * 3600; // ship-by in 13h, safety margin 12h
  h.seedOrder('W1', 'wes', { X: 1 }, { rts_sla_time: soon });
  h.seedOrder('W2', 'wes', { X: 1 }, { rts_sla_time: soon });
  await h.engine.tick();
  const g = only(h);
  assert.ok(Date.parse(g.window_ends_at) <= h.clock.now + 3600_000 + 1000, 'window capped at deadline minus 12h');
});

test('live mode cannot be switched on from the dashboard while .env says DRY_RUN=true', () => {
  const h = createHarness({ dryRun: true });
  assert.throws(() => h.engine.updateSettings({ dryRun: false }, 'joe'), /locked/);
});
