/**
 * Full dry-run demonstration against FAKE TikTok + ShipHero servers. No credentials, no internet.
 * Usage: npm run demo
 *
 * Part 1 — DRY RUN: the real engine walks a 2-order group; we prove zero mutations were sent.
 * Part 2 — PILOT FLOW (simulated servers, live code paths): approvals → TikTok combine →
 *          ShipHero merge → 2 duplicate-prone webhooks → one tracking submission → verification.
 */
import { createHarness } from '../mocks/harness.ts';
import { ingestShipmentEvent } from '../webhooks/shiphero.ts';

const say = (s = '') => console.log(s);
const show = (h: ReturnType<typeof createHarness>, label: string) => {
  const g = h.repo.listGroups()[0];
  say(`   ${label.padEnd(44)} state=${g?.state}${g?.pending_step ? ` (waiting for: ${g.pending_step})` : ''}${g?.simulated ? ' [simulated]' : ''}`);
  return g;
};

say('\n=== PART 1: DRY RUN (DRY_RUN=true) ===');
{
  const h = createHarness({ dryRun: true, pilotMode: false, autoCombine: true });
  h.seedOrder('576000000000000001', 'buyer-a', { 'COLD-SHAMPOO': 1 });
  h.seedOrder('576000000000000002', 'buyer-a', { 'COLD-CONDITIONER': 1, 'COLD-COMB': 1 });
  h.seedOrder('576000000000000003', 'buyer-b', { 'COLD-SHAMPOO': 1 }); // different customer → never grouped
  await h.engine.tick();
  show(h, 'TikTok says 2 orders can combine:');
  h.advance(6);
  await h.engine.tick();
  const g = show(h, 'After the 5-minute window:');
  say(`   Mutations sent to TikTok:   ${h.tt.mutations.length}`);
  say(`   Mutations sent to ShipHero: ${h.sh.mutations.length}`);
  say(`   Simulated operations:       ${h.repo.listOps(g.id).map((o) => `${o.kind}=${o.status}`).join(', ')}`);
  say(`   Read-only calls made:       ${h.tt.calls.length - h.tt.mutations.length} TikTok, ${h.sh.calls.length - h.sh.mutations.length} ShipHero`);
}

say('\n=== PART 2: TWO-ORDER PILOT (fake servers, real engine, approvals required) ===');
{
  const A = '576000000000000011';
  const B = '576000000000000012';
  const h = createHarness({ dryRun: false, pilotMode: true, pilotOrderIds: [A, B], trackingMode: 'engine' });
  h.seedOrder(A, 'buyer-c', { 'COLD-DEO': 1 });
  h.seedOrder(B, 'buyer-c', { 'COLD-DEO': 1, 'COLD-BODYWASH': 1 });
  await h.engine.tick();
  h.advance(6);
  await h.engine.tick();
  let g = show(h, '1. Eligible, window passed:');
  h.engine.approve(g.id, 'combine', 'joe');
  await h.engine.tick();
  g = show(h, '2. You approved "combine in TikTok":');
  say(`      TikTok combined package: ${g.combined_package_id} (orders ${h.tt.packages.get(g.combined_package_id!)!.orderIds.join(', ')})`);
  h.engine.approve(g.id, 'merge', 'joe');
  await h.engine.tick();
  g = show(h, '3. You approved "merge in ShipHero":');
  say(`      ShipHero master ${g.shiphero_orders![0].orderNumber} + sub ${g.shiphero_orders![1].orderNumber}`);
  const hooks = h.sh.shipMerged(g.shiphero_master_id!, '1Z84A1W40312345678', 'UPS', 8.95);
  const results = [...hooks, ...hooks].map((p) => ingestShipmentEvent(h.repo, p).result); // every webhook delivered twice
  say(`   4. Warehouse labels ONE box. Webhooks received: ${results.length} → kept ${results.filter((r) => r === 'new').length} (one per order), dropped ${results.filter((r) => r === 'duplicate').length} duplicates`);
  await h.engine.tick();
  g = show(h, '5. Shipment verified (all SKUs/quantities):');
  h.engine.approve(g.id, 'ship', 'joe');
  await h.engine.tick();
  g = show(h, '6. You approved "send tracking to TikTok":');
  const ship = h.tt.calls.filter((c) => c.path.endsWith('/ship'));
  say(`      Tracking submissions to TikTok: ${ship.length} → ${ship[0]?.path}`);
  say(`      Body: ${JSON.stringify(ship[0]?.body)}`);
  say(`      TikTok order statuses: ${[A, B].map((id) => `${id}=${h.tt.orders.get(id)!.status}`).join(', ')}`);
  const m = h.engine.metrics();
  say(`      Labels avoided: ${m.labelsAvoided}`);
  say('\n   Audit trail:');
  for (const a of h.repo.listAudit(g.id).reverse()) say(`     ${a.ts}  ${String(a.action).padEnd(30)} by ${a.actor}`);
}
say('\nDemo finished. Nothing real was contacted.\n');
