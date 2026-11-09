import type { Repo } from '../db/repo.ts';
import type { Logger } from '../util/logger.ts';
import { ApiError, SchemaMismatchError, fetchTransport, parseJson, retryRead, type Transport } from '../util/http.ts';
import { MERGEABLE_ORDERS, ORDERS_BY_NUMBER, ORDERS_BY_PARTNER_ID, ORDER_BY_ID, ORDER_MERGE, SHIPMENTS_FOR_ORDER } from './queries.ts';

export interface ShOrder {
  id: string;
  legacyId: string | null;
  orderNumber: string;
  partnerOrderId: string | null;
  fulfillmentStatus: string;
  onHold: boolean;
  warehouseIds: string[];
  lineItems: { id: string; sku: string; quantity: number; quantityShipped: number; quantityAllocated: number }[];
  mergedOrders: { orderId: string; isMaster: boolean }[];
}

export interface ShShipment {
  id: string;
  orderId: string;
  trackingNumber: string | null;
  carrier: string | null;
  cost: number | null;
  lineItems: { lineItemId: string; sku: string | null; quantity: number }[];
}

export interface ShipHeroClientOptions {
  apiBase: string;
  refreshToken?: string;
  accessToken?: string;
  repo?: Repo;
  logger?: Logger;
  transport?: Transport;
  clock?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

type Gql = Record<string, unknown>;
const edges = (conn: unknown): Gql[] => (((conn as Gql)?.edges as Gql[]) ?? []).map((e) => e.node as Gql);

function toOrder(n: Gql): ShOrder {
  if (!n?.id || !n.order_number) throw new SchemaMismatchError('ShipHero order missing id/order_number', n);
  const holds = (n.holds ?? {}) as Record<string, boolean>;
  return {
    id: String(n.id),
    legacyId: n.legacy_id == null ? null : String(n.legacy_id),
    orderNumber: String(n.order_number),
    partnerOrderId: n.partner_order_id == null ? null : String(n.partner_order_id),
    fulfillmentStatus: String(n.fulfillment_status ?? ''),
    onHold: Object.values(holds).some(Boolean),
    warehouseIds: [...new Set(((n.allocations as Gql[]) ?? []).map((a) => String(a.warehouse_id)).filter((w) => w && w !== 'null'))],
    lineItems: edges(n.line_items).map((l) => ({
      id: String(l.id),
      sku: String(l.sku),
      quantity: Number(l.quantity ?? 0),
      quantityShipped: Number(l.quantity_shipped ?? 0),
      quantityAllocated: Number(l.quantity_allocated ?? 0),
    })),
    mergedOrders: ((n.merged_orders as Gql[]) ?? []).map((m) => ({ orderId: String(m.order_id), isMaster: Boolean(m.is_master) })),
  };
}

export class ShipHeroClient {
  private transport: Transport;
  private clock: () => number;
  constructor(private o: ShipHeroClientOptions) {
    this.transport = o.transport ?? fetchTransport;
    this.clock = o.clock ?? Date.now;
  }

  // ------------------------------------------------------------ auth
  async refreshAccessToken(): Promise<string> {
    const refresh = this.o.repo?.getToken('shiphero')?.refresh_token || this.o.refreshToken;
    if (!refresh) throw new Error('SHIPHERO_REFRESH_TOKEN is missing');
    const res = await this.transport({ method: 'POST', url: `${this.o.apiBase}/auth/refresh`, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: refresh }) });
    const json = parseJson(res.body, 'ShipHero auth') as Gql;
    if (res.status !== 200 || !json.access_token) throw new ApiError('ShipHero token refresh failed', res.status, null, null, json);
    const expiresIn = Number(json.expires_in ?? 0);
    this.o.repo?.saveToken('shiphero', {
      access_token: String(json.access_token),
      refresh_token: refresh,
      access_expires_at: expiresIn ? new Date(this.clock() + expiresIn * 1000).toISOString() : null,
    });
    return String(json.access_token);
  }

  private async token(): Promise<string> {
    const saved = this.o.repo?.getToken('shiphero');
    const access = saved?.access_token || this.o.accessToken;
    const exp = saved?.access_expires_at ? Date.parse(saved.access_expires_at) : null;
    if (access && (exp === null || exp - this.clock() > 3600_000)) return access;
    return this.refreshAccessToken();
  }

  // ------------------------------------------------------------ core
  async gql<T = Gql>(query: string, variables: Record<string, unknown> = {}): Promise<{ data: T; raw: unknown }> {
    const token = await this.token();
    const res = await this.transport({
      method: 'POST',
      url: `${this.o.apiBase}/graphql`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    });
    const json = parseJson(res.body, 'ShipHero GraphQL') as Gql;
    const errors = (json.errors as Gql[] | undefined) ?? [];
    if (res.status === 429 || errors.some((e) => /credits/i.test(String(e.message)))) {
      throw new ApiError('ShipHero rate limit (not enough credits)', 429, null, null, json);
    }
    if (res.status >= 400 || errors.length) {
      throw new ApiError(`ShipHero error: ${errors.map((e) => e.message).join('; ') || res.status}`, res.status, (errors[0]?.code as string) ?? null, null, json);
    }
    return { data: json.data as T, raw: json };
  }

  private read<T>(fn: () => Promise<T>) {
    return retryRead(fn, { sleepFn: this.o.sleepFn });
  }

  // ------------------------------------------------------------ read-only
  async findOrdersByTikTokId(tiktokOrderId: string, field: 'partner_order_id' | 'order_number'): Promise<ShOrder[]> {
    const q = field === 'partner_order_id' ? ORDERS_BY_PARTNER_ID : ORDERS_BY_NUMBER;
    const r = await this.read(() => this.gql<{ orders: Gql }>(q, { [field]: tiktokOrderId }));
    return edges((r.data.orders as Gql)?.data).map(toOrder);
  }

  async getOrder(id: string): Promise<ShOrder | null> {
    const r = await this.read(() => this.gql<{ order: Gql }>(ORDER_BY_ID, { id }));
    const d = (r.data.order as Gql)?.data as Gql | null;
    return d ? toOrder(d) : null;
  }

  /** ShipHero's own view of which orders could merge with the given order number. */
  async mergeableOrders(orderNumber: string): Promise<{ id: string; orderNumber: string; potentialMerges: { id: string; orderNumber: string }[] }[]> {
    const r = await this.read(() => this.gql<{ mergeable_orders: Gql }>(MERGEABLE_ORDERS, { order_number: orderNumber, first: 15 }));
    return edges((r.data.mergeable_orders as Gql)?.data).map((n) => ({
      id: String(n.id),
      orderNumber: String(n.order_number),
      potentialMerges: ((n.potential_merges as Gql[]) ?? []).map((p) => ({ id: String(p.id), orderNumber: String(p.order_number) })),
    }));
  }

  async shipmentsForOrder(orderId: string): Promise<ShShipment[]> {
    const r = await this.read(() => this.gql<{ shipments: Gql }>(SHIPMENTS_FOR_ORDER, { order_id: orderId }));
    return edges((r.data.shipments as Gql)?.data).map((s) => {
      const label = ((s.shipping_labels as Gql[]) ?? [])[0] ?? {};
      return {
        id: String(s.id),
        orderId: String(s.order_id),
        trackingNumber: label.tracking_number ? String(label.tracking_number) : null,
        carrier: label.carrier ? String(label.carrier) : null,
        cost: label.cost == null ? null : Number(label.cost),
        lineItems: edges(s.line_items).map((l) => ({ lineItemId: String(l.line_item_id), sku: (l.line_item as Gql)?.sku ? String((l.line_item as Gql).sku) : null, quantity: Number(l.quantity ?? 0) })),
      };
    });
  }

  // ------------------------------------------------------------ MUTATION (single attempt; engine reconciles)
  async mergeOrders(masterOrderId: string, subOrderIds: string[]): Promise<{ requestId: string | null; orderId: string; orderNumber: string; raw: unknown }> {
    const r = await this.gql<{ order_merge: Gql }>(ORDER_MERGE, { data: { master_order_id: masterOrderId, sub_order_ids: subOrderIds } });
    const m = r.data.order_merge as Gql;
    const order = m?.order as Gql;
    if (!order?.id) throw new SchemaMismatchError('order_merge response missing order.id', r.raw);
    return { requestId: m.request_id ? String(m.request_id) : null, orderId: String(order.id), orderNumber: String(order.order_number), raw: r.raw };
  }
}
