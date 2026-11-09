/**
 * COLDEST order-merge state machine.
 *
 *   DETECTED → ELIGIBLE → (wait consolidation window) → AWAITING_APPROVAL[combine]
 *     → TIKTOK_COMBINED → (AWAITING_APPROVAL[merge] in pilot) → SHIPHERO_MERGED → READY_TO_FULFILL
 *     → SHIPPED → (AWAITING_APPROVAL[ship] in pilot, engine tracking mode) → TIKTOK_CONFIRMED
 *   Any step can go to EXCEPTION. Before anything is changed remotely, a group can be DISSOLVED
 *   (orders simply continue through the normal fulfillment workflow).
 *
 * Rules that are enforced here:
 *   - ShipHero is never merged before TikTok confirms the combined package (verified by re-reading it).
 *   - Every mutation is written to the `operations` ledger with a unique key BEFORE it is sent.
 *   - A network timeout marks the operation UNKNOWN; the next pass RE-QUERIES the remote system
 *     before anything is retried.
 *   - A successful TikTok combination is never reversed automatically.
 *   - DRY_RUN simulates every mutation; nothing is sent.
 */
import type { Config } from '../config.ts';
import type { Group, Repo, ShipHeroOrderRef, Step } from '../db/repo.ts';
import type { ShipHeroClient, ShOrder } from '../shiphero/client.ts';
import type { TikTokClient } from '../tiktok/client.ts';
import { COMBINABLE_ORDER_STATUSES, SHIPPED_ORDER_STATUSES, type CombinablePackage, type CombineResult, type TikTokOrder } from '../tiktok/types.ts';
import { ApiError, NetworkError, SchemaMismatchError } from '../util/http.ts';
import type { Logger } from '../util/logger.ts';
import { ingestShipmentEvent } from '../webhooks/shiphero.ts';
import { carrierFamily, resolveProvider } from './carriers.ts';

export interface RuntimeSettings {
  dryRun: boolean; // dashboard toggle; effective dry-run = config.dryRun || settings.dryRun
  paused: boolean;
  autoEligibility: boolean;
  autoCombine: boolean;
  windowMinutes: number;
  providerOverrides: Record<string, string>; // carrier family → TikTok provider id (must exist in TikTok's list)
}

export interface EngineDeps {
  repo: Repo;
  tiktok: TikTokClient;
  shiphero: ShipHeroClient;
  config: Config;
  logger: Logger;
  workerId?: string;
  clock?: () => number;
  /** Minutes to wait for all merged-order shipment webhooks before flagging. */
  shipmentGraceMinutes?: number;
  /** Minutes to wait for the native ShipHero→TikTok tracking update before flagging. */
  nativeTrackingGraceMinutes?: number;
  /** Poll ShipHero for shipments in addition to webhooks (useful when webhooks can't reach this PC). */
  pollShipments?: boolean;
}

const MAX_AUTO_ATTEMPTS = 3;
const DISSOLVE_COOLDOWN_MS = 60 * 60_000;
const ACTIVE_STATES = ['DETECTED', 'ELIGIBLE', 'AWAITING_APPROVAL', 'TIKTOK_COMBINED', 'SHIPHERO_MERGED', 'READY_TO_FULFILL', 'SHIPPED'] as const;
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
const SH_DONE_STATUSES = ['fulfilled', 'canceled', 'cancelled', 'shipped'];

export class Engine {
  readonly repo: Repo;
  readonly tt: TikTokClient;
  readonly sh: ShipHeroClient;
  readonly cfg: Config;
  readonly log: Logger;
  readonly workerId: string;
  readonly clock: () => number;
  private running = false;
  private searchCache: { at: number; packages: CombinablePackage[] } | null = null;
  private shipmentGraceMs: number;
  private nativeGraceMs: number;
  private pollShipments: boolean;

  constructor(d: EngineDeps) {
    this.repo = d.repo;
    this.tt = d.tiktok;
    this.sh = d.shiphero;
    this.cfg = d.config;
    this.log = d.logger;
    this.workerId = d.workerId ?? `worker-${process.pid}`;
    this.clock = d.clock ?? Date.now;
    this.shipmentGraceMs = (d.shipmentGraceMinutes ?? 30) * 60_000;
    this.nativeGraceMs = (d.nativeTrackingGraceMinutes ?? 90) * 60_000;
    this.pollShipments = d.pollShipments ?? true;
  }

  // ================================================================ settings
  settings(): RuntimeSettings {
    return this.repo.getSetting<RuntimeSettings>('runtime', {
      dryRun: true,
      paused: false,
      autoEligibility: true,
      autoCombine: false,
      windowMinutes: this.cfg.consolidationWindowMinutes,
      providerOverrides: {},
    });
  }
  updateSettings(patch: Partial<RuntimeSettings>, actor: string): RuntimeSettings {
    const cur = this.settings();
    if (patch.dryRun === false && this.cfg.dryRun) throw new Error('Live mode is locked: set DRY_RUN=false in .env and restart first.');
    if (patch.autoCombine === true && this.cfg.pilotMode) throw new Error('Automatic combination is disabled while PILOT_MODE=true.');
    if (patch.windowMinutes !== undefined && (patch.windowMinutes < 0 || patch.windowMinutes > 24 * 60)) throw new Error('Window must be 0–1440 minutes.');
    const next = { ...cur, ...patch };
    this.repo.setSetting('runtime', next);
    this.repo.audit(null, actor, 'settings_changed', this.isDryRun(), { from: cur, to: next });
    return next;
  }
  isDryRun() {
    return this.cfg.dryRun || this.settings().dryRun;
  }

  // ================================================================ main loop
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.searchCache = null;
    try {
      // 1. Advance existing groups first (so re-confirmation sees fresh search results)
      for (const g of this.repo.listGroups([...ACTIVE_STATES])) await this.processGroup(g.id);
      // 2. Discover new combinations
      const s = this.settings();
      if (s.autoEligibility && !s.paused) await this.discover();
    } catch (e) {
      this.log.error('tick failed', { error: String(e) });
    } finally {
      this.running = false;
    }
  }

  private async combinableNow(): Promise<CombinablePackage[]> {
    if (this.searchCache && this.clock() - this.searchCache.at < 30_000) return this.searchCache.packages;
    const r = await this.tt.searchCombinablePackages();
    this.searchCache = { at: this.clock(), packages: r.packages };
    return r.packages;
  }

  // ================================================================ discovery
  async discover(): Promise<Group[]> {
    const created: Group[] = [];
    let candidates: CombinablePackage[];
    try {
      candidates = await this.combinableNow();
    } catch (e) {
      this.log.error('Search Combinable Packages failed', { error: String(e) });
      this.repo.audit(null, this.workerId, 'discovery_failed', this.isDryRun(), { error: String(e) });
      return created;
    }
    for (const c of candidates) {
      const orderIds = [...new Set(c.orderIds)];
      if (orderIds.length < 2) continue; // nothing to combine
      if (orderIds.some((o) => this.repo.activeGroupForOrder(o))) continue; // already handled
      if (this.recentlyDissolved(orderIds)) continue; // rejected recently — don't re-check every pass
      const verdict = await this.evaluateCandidate(orderIds);
      if (!verdict.ok) {
        this.repo.audit(null, this.workerId, 'candidate_rejected', this.isDryRun(), { orderIds, reason: verdict.reason });
        continue;
      }
      const g = this.repo.createGroup({
        shopId: this.cfg.tiktok.shopId || this.cfg.tiktok.shopCipher,
        tiktokOrderIds: orderIds,
        packageIds: verdict.packageIds,
        candidatePackageId: c.packageId,
        windowEndsAt: verdict.windowEndsAt,
        deadlineAt: verdict.deadlineAt,
        dryRun: this.isDryRun(),
      });
      if (!g) continue; // another worker created it first
      const eligible = this.repo.updateGroup(g.id, { state: 'ELIGIBLE', expected_skus: verdict.expectedSkus });
      this.repo.audit(g.id, this.workerId, 'group_eligible', this.isDryRun(), { orderIds, candidatePackageId: c.packageId, windowEndsAt: verdict.windowEndsAt, deadlineAt: verdict.deadlineAt });
      this.log.info('Eligible combination found', { group: g.id, orderIds });
      created.push(eligible);
    }
    return created;
  }

  /** Same order set was dissolved within the cool-down period (default 60 min). */
  private recentlyDissolved(orderIds: string[]): boolean {
    const cutoff = this.clock() - DISSOLVE_COOLDOWN_MS;
    return this.repo.listGroups(['DISSOLVED']).some((g) => sameSet(g.tiktok_order_ids, orderIds) && Date.parse(g.updated_at) > cutoff);
  }

  /**
   * Extra safety filter ON TOP of TikTok's authoritative eligibility. It can only reject, never add.
   * Same customer/address is NOT judged here — only TikTok's search result decides that.
   */
  async evaluateCandidate(orderIds: string[]): Promise<
    | { ok: true; packageIds: string[]; expectedSkus: Record<string, number>; windowEndsAt: string; deadlineAt: string | null; orders: TikTokOrder[] }
    | { ok: false; reason: string }
  > {
    if (orderIds.length > this.cfg.maxOrdersPerGroup) return { ok: false, reason: `More than ${this.cfg.maxOrdersPerGroup} orders (TikTok limit per tracking number)` };
    if (this.cfg.pilotMode) {
      if (orderIds.length !== 2) return { ok: false, reason: 'Pilot mode only allows groups of exactly 2 orders' };
      if (!orderIds.every((o) => this.cfg.pilotOrderIds.includes(o))) return { ok: false, reason: 'Pilot mode: orders are not in PILOT_ORDER_IDS' };
    }
    let orders: TikTokOrder[];
    try {
      orders = await this.tt.getOrders(orderIds);
    } catch (e) {
      return { ok: false, reason: `Could not read order details: ${String(e)}` };
    }
    if (orders.length !== orderIds.length) return { ok: false, reason: 'TikTok did not return every order' };
    for (const o of orders) {
      if (!COMBINABLE_ORDER_STATUSES.includes(o.status)) return { ok: false, reason: `Order ${o.id} status is ${o.status}` };
      if (o.isOnHold) return { ok: false, reason: `Order ${o.id} is on hold` };
      if (o.cancelRequested) return { ok: false, reason: `Order ${o.id} has a cancellation/after-sale request` };
      if (o.shippingType !== 'SELLER') return { ok: false, reason: `Order ${o.id} shipping type is ${o.shippingType ?? 'unknown'} (Seller Shipping required)` };
      if (!o.lineItems.length) return { ok: false, reason: `Order ${o.id} has no line items` };
    }
    const warehouses = new Set(orders.map((o) => o.warehouseId).filter(Boolean));
    if (warehouses.size > 1) return { ok: false, reason: 'Orders are assigned to different TikTok warehouses' };
    const delivery = new Set(orders.map((o) => o.deliveryOptionId).filter(Boolean));
    if (delivery.size > 1) return { ok: false, reason: 'Orders use different Seller Shipping delivery options' };

    const expectedSkus: Record<string, number> = {};
    for (const o of orders) for (const l of o.lineItems) expectedSkus[l.sellerSku] = (expectedSkus[l.sellerSku] ?? 0) + 1; // 202309: one line item per unit

    const s = this.settings();
    const now = this.clock();
    const latestCreate = Math.max(...orders.map((o) => (o.createTime ?? now / 1000) * 1000));
    let windowEnds = latestCreate + s.windowMinutes * 60_000;
    const deadlines = orders.map((o) => o.shipByTime).filter((t): t is number => t != null).map((t) => t * 1000);
    const deadline = deadlines.length ? Math.min(...deadlines) : null;
    if (deadline !== null) windowEnds = Math.min(windowEnds, deadline - this.cfg.deadlineSafetyHours * 3600_000); // never wait past the safety margin
    windowEnds = Math.max(windowEnds, Math.min(now, windowEnds));
    return {
      ok: true,
      orders,
      packageIds: [...new Set(orders.flatMap((o) => o.packageIds))],
      expectedSkus,
      windowEndsAt: new Date(windowEnds).toISOString(),
      deadlineAt: deadline === null ? null : new Date(deadline).toISOString(),
    };
  }

  // ================================================================ per-group processing
  async processGroup(groupId: string): Promise<Group | null> {
    if (!this.repo.acquireLock(groupId, this.workerId)) return this.repo.getGroup(groupId); // another worker owns it
    try {
      // Loop so a group can move through several states in one pass (bounded).
      for (let i = 0; i < 8; i++) {
        const g = this.repo.getGroup(groupId)!;
        const before = `${g.state}:${g.pending_step}`;
        await this.step(g);
        const after = this.repo.getGroup(groupId)!;
        if (`${after.state}:${after.pending_step}` === before) break;
      }
    } catch (e) {
      this.toException(groupId, 'internal', `Unexpected error: ${String(e)}`);
    } finally {
      this.repo.releaseLock(groupId, this.workerId);
    }
    return this.repo.getGroup(groupId);
  }

  private async step(g: Group): Promise<void> {
    switch (g.state) {
      case 'DETECTED':
        return void this.repo.updateGroup(g.id, { state: 'ELIGIBLE' });
      case 'ELIGIBLE':
        return this.onEligible(g);
      case 'AWAITING_APPROVAL':
        return this.onAwaitingApproval(g);
      case 'TIKTOK_COMBINED':
        return this.gate(g, 'merge', () => this.doMerge(g));
      case 'SHIPHERO_MERGED':
        return this.onMerged(g);
      case 'READY_TO_FULFILL':
        return this.onReadyToFulfill(g);
      case 'SHIPPED':
        return this.onShipped(g);
      default:
        return;
    }
  }

  /** In pilot mode every mutation needs an explicit approval for that step. */
  private needsApproval(g: Group, step: Step): boolean {
    if (g.approvals[step]) return false;
    if (this.cfg.pilotMode) return true;
    if (step === 'combine') return !this.settings().autoCombine;
    return false;
  }

  private async gate(g: Group, step: Step, run: () => Promise<void>) {
    if (this.settings().paused) return; // paused: no new mutations
    if (this.needsApproval(g, step)) {
      this.repo.updateGroup(g.id, { state: 'AWAITING_APPROVAL', pending_step: step });
      this.repo.audit(g.id, this.workerId, `awaiting_approval_${step}`, this.isDryRun());
      return;
    }
    await run();
  }

  private async onAwaitingApproval(g: Group) {
    const step = g.pending_step;
    if (!step || !g.approvals[step] || this.settings().paused) return;
    if (step === 'combine') return this.doCombine(g);
    if (step === 'merge') return this.doMerge(g);
    if (step === 'ship') return this.doSubmitTracking(g);
  }

  approve(groupId: string, step: Step, actor: string): Group {
    const g = this.repo.getGroup(groupId);
    if (!g) throw new Error('Group not found');
    if (g.state !== 'AWAITING_APPROVAL' || g.pending_step !== step) throw new Error(`Group is not waiting for "${step}" approval (state ${g.state}/${g.pending_step})`);
    const approvals = { ...g.approvals, [step]: { at: this.repo.now(), by: actor } };
    this.repo.audit(groupId, actor, `approved_${step}`, this.isDryRun());
    return this.repo.updateGroup(groupId, { approvals });
  }

  // ---------------------------------------------------------------- ELIGIBLE
  private async onEligible(g: Group) {
    // A combine was already sent (e.g. it timed out): reconcile it — never re-evaluate from scratch.
    if (this.repo.getOp(`tt_combine:${g.id}`)) return this.doCombine(g);
    if (this.clock() < Date.parse(g.window_ends_at)) return; // still inside the consolidation window
    // Re-confirm with TikTok (authoritative) right before we act.
    let current: CombinablePackage[];
    try {
      current = await this.combinableNow();
    } catch (e) {
      return this.softFail(g, 'preflight', `Search Combinable Packages failed: ${String(e)}`);
    }
    const exact = current.find((c) => sameSet([...new Set(c.orderIds)], g.tiktok_order_ids));
    if (!exact) {
      const bigger = current.find((c) => g.tiktok_order_ids.every((o) => c.orderIds.includes(o)));
      return this.dissolve(g, bigger ? 'A larger combination is now available; a new group will be created' : 'TikTok no longer reports these orders as combinable');
    }
    const verdict = await this.evaluateCandidate(g.tiktok_order_ids);
    if (!verdict.ok) return this.dissolve(g, verdict.reason);
    // ShipHero pre-flight BEFORE touching TikTok: every order must exist and be mergeable.
    const pre = await this.shipheroPreflight(g, verdict.orders);
    if (pre.kind === 'wait') return; // not imported yet — try again next pass
    if (pre.kind === 'reject') return this.dissolve(g, pre.reason);
    this.repo.updateGroup(g.id, { candidate_package_id: exact.packageId, expected_skus: verdict.expectedSkus, shiphero_orders: pre.refs, shiphero_master_id: pre.refs[0].id });
    await this.gate(this.repo.getGroup(g.id)!, 'combine', () => this.doCombine(this.repo.getGroup(g.id)!));
  }

  /** Map TikTok orders → ShipHero orders and check they can be merged. Read-only. */
  private async shipheroPreflight(g: Group, ttOrders: TikTokOrder[]): Promise<{ kind: 'ok'; refs: ShipHeroOrderRef[] } | { kind: 'wait' } | { kind: 'reject'; reason: string }> {
    const sorted = [...ttOrders].sort((a, b) => (a.createTime ?? 0) - (b.createTime ?? 0)); // earliest order = master
    const refs: ShipHeroOrderRef[] = [];
    const shOrders: ShOrder[] = [];
    for (const t of sorted) {
      let found: ShOrder[];
      try {
        found = await this.sh.findOrdersByTikTokId(t.id, this.cfg.shiphero.tiktokIdField);
      } catch (e) {
        return { kind: 'reject', reason: `ShipHero lookup failed for ${t.id}: ${String(e)}` };
      }
      const live = found.filter((o) => !['canceled', 'cancelled'].includes(o.fulfillmentStatus.toLowerCase()));
      if (live.length === 0) return { kind: 'wait' };
      if (live.length > 1) return { kind: 'reject', reason: `TikTok order ${t.id} matches ${live.length} ShipHero orders` };
      const o = live[0];
      if (SH_DONE_STATUSES.includes(o.fulfillmentStatus.toLowerCase())) return { kind: 'reject', reason: `ShipHero order ${o.orderNumber} is already ${o.fulfillmentStatus}` };
      if (o.lineItems.some((l) => l.quantityShipped > 0)) return { kind: 'reject', reason: `ShipHero order ${o.orderNumber} has items already shipped` };
      if (o.mergedOrders.length) return { kind: 'reject', reason: `ShipHero order ${o.orderNumber} is already part of a merge` };
      // Per-order SKU check: what TikTok sold must equal what ShipHero will pick.
      const ttSkus: Record<string, number> = {};
      for (const l of t.lineItems) ttSkus[l.sellerSku] = (ttSkus[l.sellerSku] ?? 0) + 1;
      const shSkus: Record<string, number> = {};
      for (const l of o.lineItems) shSkus[l.sku] = (shSkus[l.sku] ?? 0) + l.quantity;
      if (JSON.stringify(sortObj(ttSkus)) !== JSON.stringify(sortObj(shSkus))) {
        return { kind: 'reject', reason: `SKU/quantity mismatch for order ${t.id}: TikTok ${JSON.stringify(ttSkus)} vs ShipHero ${JSON.stringify(shSkus)}` };
      }
      shOrders.push(o);
      refs.push({ tiktokOrderId: t.id, id: o.id, orderNumber: o.orderNumber, warehouseId: o.warehouseIds[0] ?? null });
    }
    const wh = new Set(shOrders.flatMap((o) => o.warehouseIds));
    if (wh.size > 1) return { kind: 'reject', reason: 'ShipHero orders are allocated to different warehouses' };
    // ShipHero's own mergeability check (documented mergeable_orders query).
    try {
      const m = await this.sh.mergeableOrders(refs[0].orderNumber);
      const node = m.find((n) => n.id === refs[0].id || n.orderNumber === refs[0].orderNumber);
      const ok = node && refs.slice(1).every((r) => node.potentialMerges.some((p) => p.id === r.id || p.orderNumber === r.orderNumber));
      if (!ok) return { kind: 'reject', reason: 'ShipHero mergeable_orders does not list these orders as mergeable' };
    } catch (e) {
      return { kind: 'reject', reason: `ShipHero mergeable_orders failed: ${String(e)}` };
    }
    void g;
    return { kind: 'ok', refs };
  }

  // ---------------------------------------------------------------- TikTok combine
  private async doCombine(g: Group) {
    const key = `tt_combine:${g.id}`;
    const items = [{ packageId: g.candidate_package_id!, orderIds: g.tiktok_order_ids }];
    const dry = this.isDryRun();
    let op = this.repo.getOp(key);

    if (op && (op.status === 'UNKNOWN' || op.status === 'IN_FLIGHT')) {
      // We may or may not have combined. Ask TikTok before doing anything else.
      const rec = await this.reconcileCombine(g);
      if (rec.kind === 'combined') {
        this.repo.finishOp(key, 'SUCCEEDED', { reconciled: true, packageId: rec.packageId }, op.request_id);
        return this.afterCombined(g, rec.packageId, op.request_id, 'reconciled');
      }
      if (rec.kind === 'partial') return this.toException(g.id, 'combine', `Partial TikTok combination found while reconciling: ${rec.detail}`);
      // Definitely not combined → safe to try again (bounded).
      this.repo.finishOp(key, 'FAILED', { reconciled: true, combined: false }, op.request_id, 'not applied (verified)');
      this.repo.resetFailedOp(key);
      if (g.attempts + 1 >= MAX_AUTO_ATTEMPTS) return this.toException(g.id, 'combine', 'Combine timed out repeatedly; verified not applied');
      this.repo.updateGroup(g.id, { attempts: g.attempts + 1 });
      op = null;
    }
    if (op?.status === 'SUCCEEDED') {
      const resp = op.response as (CombineResult & { requestId: string }) | { reconciled: true; packageId: string };
      if ('packageId' in resp) return this.afterCombined(g, resp.packageId, op.request_id, 'ledger');
      return this.evaluateCombineResult(g, resp, op.request_id);
    }
    if (op?.status === 'SIMULATED') return this.simulateCombined(g);
    if (op?.status === 'FAILED') return this.toException(g.id, 'combine', `Combine failed earlier: ${op.error}`);

    if (!this.repo.beginOp(g.id, 'TT_COMBINE', key, { combinable_packages: items }, dry)) return; // someone else is sending it
    this.repo.audit(g.id, this.workerId, dry ? 'tiktok_combine_simulated' : 'tiktok_combine_sent', dry, { items });
    if (dry) {
      this.repo.finishOp(key, 'SIMULATED', { simulated: true }, null);
      return this.simulateCombined(g);
    }
    try {
      const res = await this.tt.combinePackages(items);
      this.repo.finishOp(key, 'SUCCEEDED', res, res.requestId);
      return this.evaluateCombineResult(g, res, res.requestId);
    } catch (e) {
      if (e instanceof NetworkError) {
        this.repo.finishOp(key, 'UNKNOWN', null, null, String(e));
        this.repo.audit(g.id, this.workerId, 'tiktok_combine_unknown', dry, { error: String(e) });
        return; // reconcile next pass
      }
      const reqId = e instanceof ApiError ? e.requestId : null;
      this.repo.finishOp(key, 'FAILED', e instanceof ApiError ? e.body : null, reqId, String(e));
      return this.toException(g.id, 'combine', `TikTok rejected the combination: ${(e as Error).message}`);
    }
  }

  private async evaluateCombineResult(g: Group, res: CombineResult, requestId: string | null) {
    const full = res.packages.find((p) => g.tiktok_order_ids.every((o) => p.orderIds.includes(o)));
    if (full && res.errors.length === 0) return this.afterCombined(g, full.packageId, requestId, 'response');
    const partial = res.packages.find((p) => p.orderIds.some((o) => g.tiktok_order_ids.includes(o)) && p.orderIds.length > 1);
    if (partial) {
      // Never auto-reverse. Record what happened and escalate.
      this.repo.updateGroup(g.id, { combined_package_id: partial.packageId, combine_request_id: requestId, combined_at: this.repo.now() });
      return this.toException(g.id, 'combine', `Partial TikTok combination: package ${partial.packageId} has ${partial.orderIds.join(', ')}; errors: ${JSON.stringify(res.errors)}`);
    }
    return this.toException(g.id, 'combine', `TikTok did not combine the orders: ${JSON.stringify(res.errors)}`);
  }

  /** Read TikTok to learn whether the orders now share exactly one package. */
  private async reconcileCombine(g: Group): Promise<{ kind: 'combined'; packageId: string } | { kind: 'not_combined' } | { kind: 'partial'; detail: string }> {
    const orders = await this.tt.getOrders(g.tiktok_order_ids);
    const pkgIds = new Set(orders.flatMap((o) => o.packageIds));
    if (pkgIds.size === 1) {
      const id = [...pkgIds][0];
      const pkg = await this.tt.getPackageDetail(id);
      if (sameSet(pkg.orderIds, g.tiktok_order_ids)) return { kind: 'combined', packageId: id };
      return { kind: 'partial', detail: `package ${id} holds ${pkg.orderIds.join(', ')}` };
    }
    if (pkgIds.size < g.tiktok_order_ids.length) return { kind: 'partial', detail: `orders now span ${pkgIds.size} packages` };
    return { kind: 'not_combined' };
  }

  /** Verify the final package state, then record everything. */
  private async afterCombined(g: Group, packageId: string, requestId: string | null, via: string) {
    let pkg;
    try {
      pkg = await this.tt.getPackageDetail(packageId);
    } catch (e) {
      // Combined but cannot verify yet: store the id so we never combine again; retry verification next pass.
      this.repo.updateGroup(g.id, { combined_package_id: packageId, combine_request_id: requestId });
      return this.softFail(g, 'combine_verify', `Could not read combined package: ${String(e)}`);
    }
    if (!sameSet(pkg.orderIds, g.tiktok_order_ids)) {
      this.repo.updateGroup(g.id, { combined_package_id: packageId, combine_request_id: requestId });
      return this.toException(g.id, 'combine', `Combined package ${packageId} holds ${pkg.orderIds.join(', ')}, expected ${g.tiktok_order_ids.join(', ')}`);
    }
    this.repo.updateGroup(g.id, { state: 'TIKTOK_COMBINED', pending_step: null, combined_package_id: packageId, combine_request_id: requestId, combined_at: this.repo.now(), attempts: 0 });
    this.repo.audit(g.id, this.workerId, 'tiktok_combined_verified', false, { packageId, requestId, via, originalPackages: g.original_package_ids, orders: pkg.orderIds, packageStatus: pkg.status });
    this.log.info('TikTok combination verified', { group: g.id, packageId });
  }

  private simulateCombined(g: Group) {
    this.repo.updateGroup(g.id, { state: 'TIKTOK_COMBINED', pending_step: null, simulated: true, combined_package_id: `SIMULATED-${g.candidate_package_id}`, combined_at: this.repo.now() });
    this.repo.audit(g.id, this.workerId, 'tiktok_combined_simulated', true);
  }

  // ---------------------------------------------------------------- ShipHero merge
  private async doMerge(g: Group) {
    if (!g.combined_package_id) return this.toException(g.id, 'merge', 'Refusing to merge in ShipHero: no confirmed TikTok combined package');
    const refs = g.shiphero_orders ?? [];
    if (refs.length !== g.tiktok_order_ids.length) return this.toException(g.id, 'merge', 'ShipHero order mapping incomplete');
    const master = refs[0];
    const subs = refs.slice(1).map((r) => r.id);
    const key = `sh_merge:${g.id}`;
    const dry = this.isDryRun() || g.simulated;
    let op = this.repo.getOp(key);

    if (op && (op.status === 'UNKNOWN' || op.status === 'IN_FLIGHT')) {
      const merged = await this.isMergedInShipHero(master.id, subs);
      if (merged) {
        this.repo.finishOp(key, 'SUCCEEDED', { reconciled: true }, op.request_id);
        return this.verifyMerge(g);
      }
      this.repo.finishOp(key, 'FAILED', { reconciled: true, merged: false }, op.request_id, 'not applied (verified)');
      this.repo.resetFailedOp(key);
      if (g.attempts + 1 >= MAX_AUTO_ATTEMPTS) return this.toException(g.id, 'merge', 'ShipHero merge timed out repeatedly; verified not applied');
      this.repo.updateGroup(g.id, { attempts: g.attempts + 1 });
      op = null;
    }
    if (op?.status === 'SUCCEEDED') return this.verifyMerge(g);
    if (op?.status === 'SIMULATED') return this.simulateMerged(g);
    if (op?.status === 'FAILED') return this.toException(g.id, 'merge', `ShipHero merge failed earlier: ${op.error}`);

    // Final re-check right before the mutation (orders may have shipped/cancelled meanwhile).
    if (!dry) {
      for (const r of refs) {
        const o = await this.sh.getOrder(r.id);
        if (!o) return this.toException(g.id, 'merge', `ShipHero order ${r.orderNumber} not found`);
        if (SH_DONE_STATUSES.includes(o.fulfillmentStatus.toLowerCase()) || o.lineItems.some((l) => l.quantityShipped > 0)) {
          return this.toException(g.id, 'merge', `ShipHero order ${r.orderNumber} shipped or cancelled before merge (TikTok package ${g.combined_package_id} stays combined — review)`);
        }
      }
    }
    const request = { master_order_id: master.id, sub_order_ids: subs };
    if (!this.repo.beginOp(g.id, 'SH_MERGE', key, request, dry)) return;
    this.repo.audit(g.id, this.workerId, dry ? 'shiphero_merge_simulated' : 'shiphero_merge_sent', dry, request);
    if (dry) {
      this.repo.finishOp(key, 'SIMULATED', { simulated: true }, null);
      return this.simulateMerged(g);
    }
    try {
      const res = await this.sh.mergeOrders(master.id, subs);
      this.repo.finishOp(key, 'SUCCEEDED', res, res.requestId);
      return this.verifyMerge(g);
    } catch (e) {
      if (e instanceof NetworkError) {
        this.repo.finishOp(key, 'UNKNOWN', null, null, String(e));
        this.repo.audit(g.id, this.workerId, 'shiphero_merge_unknown', dry, { error: String(e) });
        return;
      }
      this.repo.finishOp(key, 'FAILED', e instanceof ApiError ? e.body : null, null, String(e));
      // TikTok combination is NOT reversed.
      return this.toException(g.id, 'merge', `ShipHero merge failed (TikTok package ${g.combined_package_id} remains combined): ${(e as Error).message}`);
    }
  }

  private async isMergedInShipHero(masterId: string, subIds: string[]): Promise<boolean> {
    const m = await this.sh.getOrder(masterId);
    if (!m) return false;
    return subIds.every((s) => m.mergedOrders.some((x) => x.orderId === s));
  }

  /** Post-merge checks: all SKUs, all quantities, no duplicates, one warehouse, nothing shipped, one fulfillment group. */
  private async verifyMerge(g: Group) {
    const refs = g.shiphero_orders!;
    const master = await this.sh.getOrder(refs[0].id);
    if (!master) return this.softFail(g, 'merge_verify', 'Master order not readable');
    const problems: string[] = [];
    const subIds = refs.slice(1).map((r) => r.id);
    const missing = subIds.filter((s) => !master.mergedOrders.some((m) => m.orderId === s));
    if (missing.length) problems.push(`not in merge group: ${missing.join(', ')}`);
    const masterFlag = master.mergedOrders.find((m) => m.isMaster);
    if (master.mergedOrders.length && masterFlag && masterFlag.orderId !== master.id) problems.push('unexpected master order');
    const all: ShOrder[] = [master];
    for (const s of subIds) {
      const o = await this.sh.getOrder(s);
      if (!o) problems.push(`sub-order ${s} not readable`);
      else all.push(o);
    }
    const totals: Record<string, number> = {};
    const seenLines = new Set<string>();
    for (const o of all) {
      for (const l of o.lineItems) {
        if (seenLines.has(l.id)) problems.push(`duplicate fulfillment line ${l.id}`);
        seenLines.add(l.id);
        if (l.quantityShipped > 0) problems.push(`line ${l.sku} on ${o.orderNumber} already shipped`);
        totals[l.sku] = (totals[l.sku] ?? 0) + l.quantity;
      }
    }
    if (JSON.stringify(sortObj(totals)) !== JSON.stringify(sortObj(g.expected_skus ?? {}))) {
      problems.push(`SKU totals ${JSON.stringify(sortObj(totals))} ≠ expected ${JSON.stringify(sortObj(g.expected_skus ?? {}))}`);
    }
    const wh = new Set(all.flatMap((o) => o.warehouseIds));
    if (wh.size > 1) problems.push(`allocated to ${wh.size} warehouses`);
    if (problems.length) return this.toException(g.id, 'merge', `Post-merge verification failed: ${problems.join('; ')}`);
    this.repo.updateGroup(g.id, { state: 'SHIPHERO_MERGED', pending_step: null, merged_at: this.repo.now(), attempts: 0 });
    this.repo.audit(g.id, this.workerId, 'shiphero_merge_verified', false, { master: master.orderNumber, totals });
  }

  private simulateMerged(g: Group) {
    this.repo.updateGroup(g.id, { state: 'SHIPHERO_MERGED', pending_step: null, simulated: true, merged_at: this.repo.now() });
    this.repo.audit(g.id, this.workerId, 'shiphero_merged_simulated', true);
  }

  private async onMerged(g: Group) {
    this.repo.updateGroup(g.id, { state: 'READY_TO_FULFILL' });
    this.repo.audit(g.id, this.workerId, g.simulated ? 'ready_to_fulfill_simulated' : 'released_to_warehouse', g.simulated);
  }

  // ---------------------------------------------------------------- shipment (from ShipHero webhooks)
  private async onReadyToFulfill(g: Group) {
    if (g.simulated) return; // dry run stops here: nothing was really merged, so no real shipment will come
    const refs = g.shiphero_orders!;
    // Guard: if TikTok already shows tracking before ShipHero told us about a shipment, something else updated it.
    try {
      const pkg = await this.tt.getPackageDetail(g.combined_package_id!);
      if (pkg.trackingNumber && !this.eventsFor(g).length) {
        return this.toException(g.id, 'shipment', `TikTok package already has tracking ${pkg.trackingNumber} but no ShipHero shipment was received (native integration or manual update?)`);
      }
    } catch {
      /* read failure: just continue waiting */
    }
    let events = this.eventsFor(g);
    if (!events.length && this.pollShipments) {
      await this.pollShipHeroShipments(g);
      events = this.eventsFor(g);
    }
    if (!events.length) return;

    const shipments = new Map<string, typeof events>();
    for (const e of events) shipments.set(e.shipment_id, [...(shipments.get(e.shipment_id) ?? []), e]);
    const trackings = new Set(events.map((e) => e.tracking_number));
    if (shipments.size > 1 || trackings.size > 1) {
      return this.toException(g.id, 'shipment', `Orders shipped in ${shipments.size} shipments / ${trackings.size} tracking numbers — expected one`);
    }
    const [shipmentId, evs] = [...shipments.entries()][0];
    const covered = new Set(evs.map((e) => e.order_number));
    const missingOrders = refs.filter((r) => !covered.has(r.orderNumber));
    const totals: Record<string, number> = {};
    for (const e of evs) for (const li of e.line_items) totals[li.sku] = (totals[li.sku] ?? 0) + li.quantity;
    const firstSeen = Math.min(...evs.map((e) => Date.parse(e.received_at)));
    if (missingOrders.length) {
      if (this.clock() - firstSeen > this.shipmentGraceMs) {
        return this.toException(g.id, 'shipment', `Shipment ${shipmentId}: no webhook for ${missingOrders.map((m) => m.orderNumber).join(', ')}`);
      }
      return; // other per-order webhooks are probably on their way
    }
    if (JSON.stringify(sortObj(totals)) !== JSON.stringify(sortObj(g.expected_skus ?? {}))) {
      return this.toException(g.id, 'shipment', `Shipped quantities ${JSON.stringify(sortObj(totals))} ≠ expected ${JSON.stringify(sortObj(g.expected_skus ?? {}))}`);
    }
    const ev = evs[0];
    const labelCost = Math.max(...evs.map((e) => e.label_cost ?? 0)) || null; // same physical label repeated per order: count once
    this.repo.updateGroup(g.id, { state: 'SHIPPED', shipment_id: shipmentId, tracking_number: ev.tracking_number, carrier: ev.carrier, label_cost: labelCost, shipped_at: this.repo.now() });
    this.repo.audit(g.id, this.workerId, 'shipment_complete', false, { shipmentId, tracking: ev.tracking_number, carrier: ev.carrier, webhookCalls: evs.length, totals });
  }

  private eventsFor(g: Group) {
    const refs = g.shiphero_orders ?? [];
    return this.repo.shipmentEventsFor({
      orderNumbers: refs.map((r) => r.orderNumber),
      partnerOrderIds: refs.map((r) => r.tiktokOrderId),
      uuids: refs.map((r) => r.id),
    });
  }

  private async pollShipHeroShipments(g: Group) {
    for (const r of g.shiphero_orders ?? []) {
      try {
        const ships = await this.sh.shipmentsForOrder(r.id);
        for (const s of ships) {
          if (!s.trackingNumber) continue;
          ingestShipmentEvent(
            this.repo,
            {
              test: false,
              fulfillment: { shipment_id: s.id, order_number: r.orderNumber, partner_order_id: r.tiktokOrderId, order_uuid: r.id, tracking_number: s.trackingNumber, shipping_carrier: s.carrier, line_items: s.lineItems.map((l) => ({ id: l.lineItemId, sku: l.sku, quantity: l.quantity })) },
              packages: [{ shipping_label: { tracking_number: s.trackingNumber, shipping_carrier: s.carrier, cost: s.cost } }],
            },
            'poll',
          );
        }
      } catch (e) {
        this.log.warn('Shipment poll failed', { group: g.id, error: String(e) });
      }
    }
  }

  // ---------------------------------------------------------------- tracking → TikTok
  private async onShipped(g: Group) {
    let pkg;
    try {
      pkg = await this.tt.getPackageDetail(g.combined_package_id!);
    } catch (e) {
      return this.softFail(g, 'tracking', `Could not read TikTok package: ${String(e)}`);
    }
    if (pkg.trackingNumber) {
      if (pkg.trackingNumber !== g.tracking_number) {
        return this.toException(g.id, 'tracking', `TikTok package shows tracking ${pkg.trackingNumber}, ShipHero shipped ${g.tracking_number} — unexpected update (native integration?)`);
      }
      const source = this.repo.getOp(this.shipKey(g))?.status === 'SUCCEEDED' ? 'engine' : 'native';
      return this.verifyFinal(g, source);
    }
    // No tracking on TikTok yet.
    if (this.cfg.trackingMode === 'native_verify') {
      if (this.clock() - Date.parse(g.shipped_at ?? g.updated_at) > this.nativeGraceMs) {
        return this.toException(g.id, 'tracking', 'ShipHero native integration has not posted tracking to the combined TikTok package. Review before submitting manually.');
      }
      return; // keep waiting for the native integration
    }
    const fam = carrierFamily(g.carrier ?? '');
    if (fam && this.cfg.blockedCarriers.map((c) => c.toLowerCase()).includes(fam)) {
      return this.toException(g.id, 'tracking', `Carrier ${g.carrier} is on BLOCKED_CARRIERS (TikTok requires USPS labels from TikTok Shipping). Manual review required.`);
    }
    return this.gate(g, 'ship', () => this.doSubmitTracking(g));
  }

  private shipKey(g: Group) {
    return `tt_ship:${g.combined_package_id}:${g.tracking_number}`;
  }

  private async doSubmitTracking(g: Group) {
    const key = this.shipKey(g);
    const dry = this.isDryRun() || g.simulated;
    let op = this.repo.getOp(key);
    if (op && (op.status === 'UNKNOWN' || op.status === 'IN_FLIGHT')) {
      const pkg = await this.tt.getPackageDetail(g.combined_package_id!);
      if (pkg.trackingNumber === g.tracking_number) {
        this.repo.finishOp(key, 'SUCCEEDED', { reconciled: true }, op.request_id);
        return this.verifyFinal(g, 'engine');
      }
      if (pkg.trackingNumber) return this.toException(g.id, 'tracking', `Package has different tracking ${pkg.trackingNumber}`);
      this.repo.finishOp(key, 'FAILED', { reconciled: true }, op.request_id, 'not applied (verified)');
      this.repo.resetFailedOp(key);
      if (g.attempts + 1 >= MAX_AUTO_ATTEMPTS) return this.toException(g.id, 'tracking', 'Tracking submission timed out repeatedly; verified not applied');
      this.repo.updateGroup(g.id, { attempts: g.attempts + 1 });
      op = null;
    }
    if (op?.status === 'SUCCEEDED') return this.verifyFinal(g, 'engine');
    if (op?.status === 'SIMULATED') return;
    if (op?.status === 'FAILED') return this.toException(g.id, 'tracking', `Tracking submission failed earlier: ${op.error}`);

    // Resolve provider strictly from TikTok's own list.
    const orders = await this.tt.getOrders(g.tiktok_order_ids);
    const options = [...new Set(orders.map((o) => o.deliveryOptionId).filter(Boolean))] as string[];
    if (options.length !== 1) return this.toException(g.id, 'tracking', `Expected one delivery option, found ${options.length}`);
    const providers = await this.tt.getShippingProviders(options[0]);
    const override = this.settings().providerOverrides[carrierFamily(g.carrier ?? '') ?? ''] ?? null;
    const match = resolveProvider(g.carrier ?? '', providers, override);
    if (!match.ok) return this.toException(g.id, 'tracking', `Shipping provider: ${match.reason}`);

    const request = { package_id: g.combined_package_id, self_shipment: { tracking_number: g.tracking_number, shipping_provider_id: match.provider.id } };
    if (!this.repo.beginOp(g.id, 'TT_SHIP', key, request, dry)) return;
    this.repo.updateGroup(g.id, { shipping_provider_id: match.provider.id });
    this.repo.audit(g.id, this.workerId, dry ? 'tiktok_tracking_simulated' : 'tiktok_tracking_sent', dry, { ...request, provider: match.provider.name });
    if (dry) {
      this.repo.finishOp(key, 'SIMULATED', { simulated: true }, null);
      return;
    }
    try {
      const res = await this.tt.shipPackageSelfShipment(g.combined_package_id!, g.tracking_number!, match.provider.id);
      this.repo.finishOp(key, 'SUCCEEDED', res.raw, res.requestId);
      return this.verifyFinal(g, 'engine');
    } catch (e) {
      if (e instanceof NetworkError) {
        this.repo.finishOp(key, 'UNKNOWN', null, null, String(e));
        return;
      }
      // TikTok may reject because the tracking is already there (e.g. native update raced us). Re-read.
      const pkg = await this.tt.getPackageDetail(g.combined_package_id!).catch(() => null);
      if (pkg?.trackingNumber === g.tracking_number) {
        this.repo.finishOp(key, 'SUCCEEDED', { alreadyPresent: true, error: String(e) }, null);
        return this.verifyFinal(g, 'native');
      }
      this.repo.finishOp(key, 'FAILED', e instanceof ApiError ? e.body : null, e instanceof ApiError ? e.requestId : null, String(e));
      return this.toException(g.id, 'tracking', `TikTok rejected tracking: ${(e as Error).message}`);
    }
  }

  /** Every original order must point at the combined package and show a shipped status. */
  private async verifyFinal(g: Group, source: string) {
    const orders = await this.tt.getOrders(g.tiktok_order_ids);
    const problems: string[] = [];
    for (const o of orders) {
      if (!o.packageIds.includes(g.combined_package_id!)) problems.push(`order ${o.id} not linked to package ${g.combined_package_id}`);
      if (!SHIPPED_ORDER_STATUSES.includes(o.status)) problems.push(`order ${o.id} status ${o.status}`);
    }
    if (problems.length) {
      if (this.clock() - Date.parse(g.shipped_at ?? g.updated_at) > this.nativeGraceMs) return this.toException(g.id, 'tracking', `Final verification failed: ${problems.join('; ')}`);
      return; // statuses can lag a little — check again next pass
    }
    this.repo.updateGroup(g.id, { state: 'TIKTOK_CONFIRMED', pending_step: null, tracking_source: source, confirmed_at: this.repo.now() });
    this.repo.audit(g.id, this.workerId, 'tiktok_confirmed', false, { source, tracking: g.tracking_number, package: g.combined_package_id, statuses: orders.map((o) => [o.id, o.status]) });
    this.log.info('Group complete', { group: g.id, tracking: g.tracking_number });
  }

  // ---------------------------------------------------------------- failure handling
  private dissolve(g: Group, reason: string) {
    const op = this.repo.getOp(`tt_combine:${g.id}`);
    if (g.combined_package_id || (op && op.status !== 'FAILED')) return this.toException(g.id, 'internal', `Cannot dissolve after a TikTok combine was sent: ${reason}`);
    this.repo.updateGroup(g.id, { state: 'DISSOLVED', exception_reason: reason });
    this.repo.audit(g.id, this.workerId, 'group_dissolved', this.isDryRun(), { reason });
  }

  /** Transient problem: count attempts, escalate after a few. */
  private softFail(g: Group, step: string, reason: string) {
    const attempts = g.attempts + 1;
    this.repo.audit(g.id, this.workerId, 'soft_failure', this.isDryRun(), { step, reason, attempts });
    if (attempts >= MAX_AUTO_ATTEMPTS * 2) return this.toException(g.id, step, reason);
    this.repo.updateGroup(g.id, { attempts });
  }

  toException(groupId: string, step: string, reason: string) {
    this.repo.updateGroup(groupId, { state: 'EXCEPTION', exception_step: step, exception_reason: reason });
    this.repo.audit(groupId, this.workerId, 'exception', this.isDryRun(), { step, reason });
    this.log.warn('Group moved to EXCEPTION', { group: groupId, step, reason });
  }

  /** Operator retry from the dashboard. Resumes at the failed step; never reverses anything. */
  retry(groupId: string, actor: string): Group {
    const g = this.repo.getGroup(groupId);
    if (!g || g.state !== 'EXCEPTION') throw new Error('Only EXCEPTION groups can be retried');
    let state: Group['state'];
    if (g.exception_step === 'merge' || g.exception_step === 'merge_verify') {
      this.repo.resetFailedOp(`sh_merge:${g.id}`);
      state = 'TIKTOK_COMBINED';
    } else if (g.exception_step === 'shipment') state = 'READY_TO_FULFILL';
    else if (g.exception_step === 'tracking') {
      this.repo.resetFailedOp(this.shipKey(g));
      state = 'SHIPPED';
    } else if (g.combined_package_id) {
      // combine reported partial/unverified — re-verify rather than re-send
      return this.toExceptionNoop(g, actor);
    } else {
      this.repo.resetFailedOp(`tt_combine:${g.id}`);
      state = 'ELIGIBLE';
    }
    const approvals = { ...g.approvals };
    if (state === 'ELIGIBLE') delete approvals.combine;
    if (state === 'TIKTOK_COMBINED') delete approvals.merge;
    if (state === 'SHIPPED') delete approvals.ship;
    this.repo.audit(groupId, actor, 'retry', this.isDryRun(), { from: g.exception_step, to: state });
    return this.repo.updateGroup(groupId, { state, pending_step: null, exception_reason: null, exception_step: null, attempts: 0, approvals });
  }
  private toExceptionNoop(g: Group, actor: string): Group {
    this.repo.audit(g.id, actor, 'retry_refused', this.isDryRun(), { reason: 'TikTok package already (partly) combined — resolve manually in Seller Center, then mark resolved' });
    throw new Error('This group was already (partly) combined in TikTok. It cannot be retried automatically — review it in TikTok Seller Center.');
  }

  // ================================================================ metrics for the dashboard
  metrics() {
    const groups = this.repo.listGroups();
    const byState: Record<string, number> = {};
    for (const g of groups) byState[g.state] = (byState[g.state] ?? 0) + 1;
    const done = groups.filter((g) => g.state === 'TIKTOK_CONFIRMED' && !g.simulated);
    const labelsAvoided = done.reduce((s, g) => s + g.tiktok_order_ids.length - 1, 0);
    const simulatedAvoided = groups.filter((g) => g.simulated).reduce((s, g) => s + g.tiktok_order_ids.length - 1, 0);
    const avg = this.cfg.avgSingleLabelCost;
    const combinedCost = done.reduce((s, g) => s + (g.label_cost ?? 0), 0);
    const costKnown = done.filter((g) => g.label_cost != null);
    const estSavings = avg != null && costKnown.length ? costKnown.reduce((s, g) => s + g.tiktok_order_ids.length * avg - (g.label_cost ?? 0), 0) : null;
    return { byState, labelsAvoided, simulatedAvoided, combinedLabelCost: combinedCost, estimatedSavings: estSavings, events: this.repo.countShipmentEvents() };
  }
}

function sortObj(o: Record<string, number>) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== 0).sort(([a], [b]) => a.localeCompare(b)));
}

export { SchemaMismatchError };
