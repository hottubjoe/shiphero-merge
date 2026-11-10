/** In-memory fake of the ShipHero GraphQL operations this app uses. Tests and demo only. */
import { NetworkError, type HttpRequest, type HttpResponse, type Transport } from '../util/http.ts';

export interface FakeShOrder {
  id: string;
  legacy_id: number;
  order_number: string;
  partner_order_id: string;
  fulfillment_status: string;
  email: string;
  warehouse_id: string;
  line_items: { id: string; sku: string; quantity: number; quantity_shipped: number; quantity_allocated: number }[];
  merged_orders: { order_id: string; is_master: boolean }[];
}
export interface FakeShipment {
  id: string;
  order_id: string;
  tracking: string;
  carrier: string;
  cost: number;
  lines: { line_item_id: string; sku: string; quantity: number }[];
}

export class FakeShipHero {
  orders = new Map<string, FakeShOrder>();
  shipments: FakeShipment[] = [];
  calls: { op: string; variables: Record<string, unknown> }[] = [];
  refreshWorks = true;
  fail = { mergeError: false, mergeTimeoutAfterApply: false, mergeTimeoutBeforeApply: false, duplicateLinesOnMerge: false };
  private seq = 100;

  constructor(public accessToken = 'SH-TOKEN') {}

  addOrder(tiktokOrderId: string, email: string, skus: Record<string, number>, warehouse = 'WH-1') {
    const n = ++this.seq;
    const id = `T3JkZXI6${n}`;
    const o: FakeShOrder = {
      id, legacy_id: n, order_number: `TT-${tiktokOrderId}`, partner_order_id: tiktokOrderId, fulfillment_status: 'pending', email, warehouse_id: warehouse,
      line_items: Object.entries(skus).map(([sku, q], i) => ({ id: `LI-${n}-${i}`, sku, quantity: q, quantity_shipped: 0, quantity_allocated: q })),
      merged_orders: [],
    };
    this.orders.set(id, o);
    return o;
  }
  byPartner(pid: string) {
    return [...this.orders.values()].find((o) => o.partner_order_id === pid)!;
  }
  get mutations() {
    return this.calls.filter((c) => c.op === 'OrderMerge');
  }

  /**
   * Warehouse packs & labels a merged order: returns one Shipment Update webhook payload PER ORDER
   * (master + subs), all with the same shipment_id and tracking — exactly as ShipHero documents.
   */
  shipMerged(masterId: string, tracking: string, carrier = 'UPS', cost = 9.4) {
    const master = this.orders.get(masterId)!;
    const groupIds = master.merged_orders.length ? master.merged_orders.map((m) => m.order_id) : [masterId];
    const shipmentId = `SHP-${++this.seq}`;
    return groupIds.map((oid) => {
      const o = this.orders.get(oid)!;
      o.fulfillment_status = 'fulfilled';
      for (const l of o.line_items) l.quantity_shipped = l.quantity;
      this.shipments.push({ id: shipmentId, order_id: oid, tracking, carrier, cost, lines: o.line_items.map((l) => ({ line_item_id: l.id, sku: l.sku, quantity: l.quantity })) });
      return {
        test: false,
        webhook_type: 'Shipment Update',
        fulfillment: {
          shipment_id: shipmentId, shipment_uuid: `U-${shipmentId}`, warehouse: 'Main', warehouse_id: 1, partner_order_id: o.partner_order_id, order_number: o.order_number,
          order_uuid: o.id, tracking_number: tracking, shipping_carrier: carrier, completed: true,
          line_items: o.line_items.map((l) => ({ id: l.id, shiphero_id: l.id, quantity: l.quantity, sku: l.sku })),
        },
        total_packages: 1,
        packages: [{ name: 'Box', line_items: [], shipping_label: { shipping_carrier: carrier, shipping_method: 'Ground', tracking_number: tracking, cost } }],
      };
    });
  }

  private ok(data: unknown): HttpResponse {
    return { status: 200, headers: {}, body: JSON.stringify({ data }) };
  }
  private gqlErr(message: string): HttpResponse {
    return { status: 200, headers: {}, body: JSON.stringify({ data: null, errors: [{ message }] }) };
  }
  private node(o: FakeShOrder, withMerged = false) {
    return {
      id: o.id, legacy_id: o.legacy_id, order_number: o.order_number, partner_order_id: o.partner_order_id, fulfillment_status: o.fulfillment_status, shop_name: 'TikTok',
      holds: { fraud_hold: false, address_hold: false, shipping_method_hold: false, operator_hold: false, payment_hold: false, client_hold: false },
      allocations: [{ warehouse_id: o.warehouse_id }],
      line_items: { edges: o.line_items.map((l) => ({ node: { ...l, fulfillment_status: o.fulfillment_status } })) },
      ...(withMerged ? { merged_orders: o.merged_orders } : {}),
    };
  }

  transport: Transport = async (req: HttpRequest) => {
    const url = new URL(req.url);
    if (url.pathname === '/auth/token') {
      const b = JSON.parse(req.body ?? '{}');
      if (b.username !== 'ops@coldest.com' || b.password !== 'right-pw') return { status: 403, headers: {}, body: JSON.stringify({ error: 'access_denied', error_description: 'Wrong email or password.' }) };
      return { status: 200, headers: {}, body: JSON.stringify({ access_token: this.accessToken, refresh_token: 'NEW-REFRESH', expires_in: 2419200, token_type: 'Bearer' }) };
    }
    if (url.pathname === '/auth/refresh') {
      if (!this.refreshWorks) return { status: 401, headers: {}, body: JSON.stringify({ error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' }) };
      return { status: 200, headers: {}, body: JSON.stringify({ access_token: this.accessToken, expires_in: 2419200 }) };
    }
    if (req.headers.authorization !== `Bearer ${this.accessToken}`) return { status: 401, headers: {}, body: JSON.stringify({ errors: [{ message: 'unauthorized' }] }) };
    const { query, variables } = JSON.parse(req.body!);
    const op = (query.match(/(?:query|mutation)\s+(\w+)/) ?? [])[1];
    this.calls.push({ op, variables });
    const v = variables as Record<string, string & string[] & Record<string, unknown>>;

    switch (op) {
      case 'Account':
        return this.ok({ account: { request_id: 'r', data: { id: 'ACC1', email: 'ops@example.com' } } });
      case 'OrdersByPartnerId':
      case 'OrdersByNumber': {
        const list = [...this.orders.values()].filter((o) => (op === 'OrdersByPartnerId' ? o.partner_order_id === v.partner_order_id : o.order_number === v.order_number));
        return this.ok({ orders: { request_id: 'r', complexity: 1, data: { edges: list.map((o) => ({ node: this.node(o) })) } } });
      }
      case 'OrderById': {
        const o = this.orders.get(v.id);
        return this.ok({ order: { request_id: 'r', complexity: 1, data: o ? this.node(o, true) : null } });
      }
      case 'MergeableOrdersQuery': {
        const base = [...this.orders.values()].find((o) => o.order_number === v.order_number);
        if (!base) return this.ok({ mergeable_orders: { request_id: 'r', complexity: 1, data: { edges: [], pageInfo: {} } } });
        const ok = (o: FakeShOrder) => o.fulfillment_status === 'pending' && !o.merged_orders.length && o.email === base.email && o.warehouse_id === base.warehouse_id;
        const pm = [...this.orders.values()].filter((o) => o.id !== base.id && ok(o)).map((o) => ({ id: o.id, order_number: o.order_number, email: o.email }));
        return this.ok({ mergeable_orders: { request_id: 'r', complexity: 1, data: { edges: ok(base) ? [{ node: { id: base.id, order_number: base.order_number, potential_merges: pm } }] : [], pageInfo: {} } } });
      }
      case 'OrderMerge': {
        const d = v.data as unknown as { master_order_id: string; sub_order_ids: string[] };
        if (this.fail.mergeError) {
          this.fail.mergeError = false;
          return this.gqlErr('Orders cannot be merged: address mismatch');
        }
        if (this.fail.mergeTimeoutBeforeApply) {
          this.fail.mergeTimeoutBeforeApply = false;
          throw new NetworkError('simulated timeout (not applied)');
        }
        const master = this.orders.get(d.master_order_id)!;
        const group = [{ order_id: master.id, is_master: true }, ...d.sub_order_ids.map((s) => ({ order_id: s, is_master: false }))];
        for (const g of group) this.orders.get(g.order_id)!.merged_orders = group;
        if (this.fail.duplicateLinesOnMerge) {
          this.fail.duplicateLinesOnMerge = false;
          const sub = this.orders.get(d.sub_order_ids[0])!;
          master.line_items.push(...sub.line_items.map((l) => ({ ...l }))); // bug: copied, not moved
        }
        if (this.fail.mergeTimeoutAfterApply) {
          this.fail.mergeTimeoutAfterApply = false;
          throw new NetworkError('simulated timeout (applied)');
        }
        return this.ok({ order_merge: { request_id: `SHREQ-${++this.seq}`, complexity: 10, order: { id: master.id, order_number: master.order_number } } });
      }
      case 'ShipmentsForOrder': {
        const list = this.shipments.filter((s) => s.order_id === v.order_id);
        return this.ok({ shipments: { request_id: 'r', complexity: 1, data: { edges: list.map((s) => ({ node: { id: s.id, order_id: s.order_id, shipping_labels: [{ tracking_number: s.tracking, carrier: s.carrier, cost: s.cost }], line_items: { edges: s.lines.map((l) => ({ node: { line_item_id: l.line_item_id, quantity: l.quantity, line_item: { sku: l.sku } } })) } } })) } } });
      }
      default:
        return this.gqlErr(`fake: unknown operation ${op}`);
    }
  };
}
