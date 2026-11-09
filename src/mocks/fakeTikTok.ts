/**
 * In-memory fake of the TikTok Shop endpoints this app uses. It CHECKS request signatures,
 * so the signing code is exercised in every test. Used by tests and the demo only.
 */
import { signTikTokRequest } from '../tiktok/sign.ts';
import { NetworkError, type HttpRequest, type HttpResponse, type Transport } from '../util/http.ts';

export interface FakeOrder {
  id: string;
  status: string;
  buyerKey: string; // stands in for "same customer + same address" — TikTok's decision, not ours
  warehouse_id: string;
  delivery_option_id: string;
  shipping_type: 'SELLER' | 'TIKTOK';
  is_on_hold_order: boolean;
  cancel_reason?: string;
  create_time: number;
  rts_sla_time: number;
  skus: string[]; // one entry per unit
  packageId: string;
}
export interface FakePackage {
  id: string;
  orderIds: string[];
  status: string;
  tracking: string | null;
  providerId: string | null;
}

export interface FakeTikTokOptions {
  appKey: string;
  appSecret: string;
  accessToken: string;
}

export class FakeTikTok {
  orders = new Map<string, FakeOrder>();
  packages = new Map<string, FakePackage>();
  calls: { method: string; path: string; body?: unknown }[] = [];
  /** One-shot failure switches for tests */
  fail = {
    combineTimeoutAfterApply: false,
    combineTimeoutBeforeApply: false,
    combinePartial: false,
    combineReject: false,
    shipTimeoutAfterApply: false,
    searchTimeouts: 0,
  };
  providers = [
    { id: 'PRV-UPS', name: 'UPS' },
    { id: 'PRV-USPS', name: 'USPS' },
    { id: 'PRV-FEDEX', name: 'FedEx' },
    { id: 'PRV-DHLE', name: 'DHL eCommerce' },
  ];
  private seq = 9000;

  constructor(public o: FakeTikTokOptions) {}

  addOrder(o: Partial<FakeOrder> & { id: string; buyerKey: string; skus: string[] }) {
    const pkgId = o.packageId ?? `PKG-${o.id}`;
    const order: FakeOrder = {
      status: 'AWAITING_SHIPMENT',
      warehouse_id: 'WH-1',
      delivery_option_id: 'DO-STD',
      shipping_type: 'SELLER',
      is_on_hold_order: false,
      create_time: Math.floor(Date.now() / 1000) - 3600,
      rts_sla_time: Math.floor(Date.now() / 1000) + 2 * 86400,
      packageId: pkgId,
      ...o,
    };
    this.orders.set(order.id, order);
    this.packages.set(pkgId, { id: pkgId, orderIds: [order.id], status: 'TO_FULFILL', tracking: null, providerId: null });
    return order;
  }

  /** Simulates the ShipHero native integration (or a person) writing tracking straight into TikTok. */
  externalTrackingUpdate(packageId: string, tracking: string) {
    const p = this.packages.get(packageId)!;
    p.tracking = tracking;
    p.status = 'PROCESSING';
    for (const id of p.orderIds) this.orders.get(id)!.status = 'AWAITING_COLLECTION';
  }

  get mutations() {
    return this.calls.filter((c) => c.method === 'POST' && !c.path.includes('/orders/search'));
  }

  private ok(data: unknown): HttpResponse {
    return { status: 200, headers: {}, body: JSON.stringify({ code: 0, message: 'Success', request_id: `REQ-${++this.seq}`, data }) };
  }
  private err(code: number, message: string, status = 200): HttpResponse {
    return { status, headers: {}, body: JSON.stringify({ code, message, request_id: `REQ-${++this.seq}`, data: null }) };
  }

  private combinableGroups() {
    const byKey = new Map<string, FakeOrder[]>();
    for (const o of this.orders.values()) {
      if (o.status !== 'AWAITING_SHIPMENT' || o.is_on_hold_order || o.cancel_reason) continue;
      const pkg = this.packages.get(o.packageId)!;
      if (pkg.orderIds.length > 1) continue; // already combined
      const k = `${o.buyerKey}|${o.warehouse_id}|${o.delivery_option_id}`;
      byKey.set(k, [...(byKey.get(k) ?? []), o]);
    }
    return [...byKey.values()].filter((g) => g.length > 1).map((g) => ({ id: g[0].packageId, order_ids: g.map((o) => o.id) }));
  }

  transport: Transport = async (req: HttpRequest) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const body = req.body ? JSON.parse(req.body) : undefined;
    this.calls.push({ method: req.method, path, body });

    if (path.startsWith('/api/v2/token/')) {
      return this.ok({ access_token: this.o.accessToken, access_token_expire_in: Math.floor(Date.now() / 1000) + 7 * 86400, refresh_token: 'RT', refresh_token_expire_in: Math.floor(Date.now() / 1000) + 60 * 86400, seller_name: 'COLDEST' });
    }
    // --- signature + auth checks (same rules as the real API)
    const q: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (q[k] = v));
    const expected = signTikTokRequest({ path, query: q, body: req.body, appSecret: this.o.appSecret, contentType: req.headers['content-type'] });
    if (q.sign !== expected) return this.err(106001, 'Invalid sign', 401);
    if (q.app_key !== this.o.appKey) return this.err(106002, 'Invalid app_key', 401);
    if (req.headers['x-tts-access-token'] !== this.o.accessToken) return this.err(105002, 'Invalid access token', 401);

    if (path === '/authorization/202309/shops') return this.ok({ shops: [{ id: 'SHOP-1', name: 'COLDEST', region: 'US', cipher: 'CIPHER-1', code: 'USCOLD' }] });

    if (path === '/fulfillment/202309/combinable_packages/search') {
      if (this.fail.searchTimeouts > 0) {
        this.fail.searchTimeouts--;
        throw new NetworkError('simulated timeout');
      }
      return this.ok({ combinable_packages: this.combinableGroups(), next_page_token: '', total_count: this.combinableGroups().length });
    }
    if (path === '/order/202309/orders' && req.method === 'GET') {
      const ids = (q.ids ?? '').split(',');
      return this.ok({
        orders: ids.filter((id) => this.orders.has(id)).map((id) => {
          const o = this.orders.get(id)!;
          return {
            id: o.id, status: o.status, shipping_type: o.shipping_type, is_on_hold_order: o.is_on_hold_order, cancel_reason: o.cancel_reason ?? '',
            delivery_option_id: o.delivery_option_id, warehouse_id: o.warehouse_id, create_time: o.create_time, rts_sla_time: o.rts_sla_time,
            packages: [{ id: o.packageId }],
            line_items: o.skus.map((s, i) => ({ id: `${o.id}-L${i}`, seller_sku: s, display_status: o.status })),
          };
        }),
      });
    }
    if (path === '/order/202309/orders/search') return this.ok({ orders: [...this.orders.values()].filter((o) => o.status === 'AWAITING_SHIPMENT').map((o) => ({ id: o.id })), next_page_token: '' });

    if (path === '/fulfillment/202309/packages/combine') {
      const item = body.combinable_packages[0] as { id: string; order_ids: string[] };
      if (this.fail.combineReject) {
        this.fail.combineReject = false;
        return this.err(21011028, 'fulfillment not allow combine package');
      }
      if (this.fail.combineTimeoutBeforeApply) {
        this.fail.combineTimeoutBeforeApply = false;
        throw new NetworkError('simulated timeout (not applied)');
      }
      const eligible = new Set(this.combinableGroups().flatMap((g) => g.order_ids));
      let ids = item.order_ids.filter((o) => eligible.has(o));
      const errors: unknown[] = item.order_ids.filter((o) => !eligible.has(o)).map((o) => ({ code: 21011029, message: 'order not combinable', detail: { order_id: o, package_id: item.id } }));
      if (this.fail.combinePartial) {
        this.fail.combinePartial = false;
        const dropped = ids.slice(2);
        ids = ids.slice(0, 2);
        for (const o of dropped) errors.push({ code: 21011030, message: 'combine failed for order', detail: { order_id: o, package_id: item.id } });
      }
      const newId = `CPKG-${++this.seq}`;
      if (ids.length >= 2) {
        for (const oid of ids) {
          const o = this.orders.get(oid)!;
          this.packages.delete(o.packageId);
          o.packageId = newId;
        }
        this.packages.set(newId, { id: newId, orderIds: ids, status: 'TO_FULFILL', tracking: null, providerId: null });
      }
      if (this.fail.combineTimeoutAfterApply) {
        this.fail.combineTimeoutAfterApply = false;
        throw new NetworkError('simulated timeout (applied)');
      }
      return this.ok({ packages: ids.length >= 2 ? [{ id: newId, order_ids: ids }] : [], errors });
    }

    const pkgMatch = path.match(/^\/fulfillment\/202309\/packages\/([^/]+)(\/ship)?$/);
    if (pkgMatch) {
      const p = this.packages.get(decodeURIComponent(pkgMatch[1]));
      if (!p) return this.err(21001001, 'package not found');
      if (!pkgMatch[2]) {
        return this.ok({ package_id: p.id, orders: p.orderIds.map((id) => ({ id })), package_status: p.status, tracking_number: p.tracking ?? '', shipping_provider_id: p.providerId ?? '', shipping_provider_name: '' });
      }
      const s = body.self_shipment;
      if (!s?.tracking_number || !s?.shipping_provider_id) return this.err(21001010, 'self_shipment required');
      if (!this.providers.some((x) => x.id === s.shipping_provider_id)) return this.err(21001011, 'invalid shipping_provider_id');
      if (p.tracking) return this.err(21001012, 'package already shipped');
      p.tracking = s.tracking_number;
      p.providerId = s.shipping_provider_id;
      p.status = 'PROCESSING';
      for (const id of p.orderIds) this.orders.get(id)!.status = 'AWAITING_COLLECTION';
      if (this.fail.shipTimeoutAfterApply) {
        this.fail.shipTimeoutAfterApply = false;
        throw new NetworkError('simulated timeout (applied)');
      }
      return this.ok({});
    }
    if (/^\/logistics\/202309\/delivery_options\/[^/]+\/shipping_providers$/.test(path)) return this.ok({ shipping_providers: this.providers });

    return this.err(404, `fake: no route ${req.method} ${path}`, 404);
  };
}
