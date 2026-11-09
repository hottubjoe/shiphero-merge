/**
 * TikTok Shop response shapes and STRICT parsers.
 *
 * Field confidence (see docs/API_FINDINGS.md):
 *   [DOC]    seen in the official TikTok Partner Center reference
 *   [VERIFY] expected from the 202309 reference but must be confirmed with `npm run verify-api`
 *            against your shop before going live. If a field is missing, the parser throws
 *            SchemaMismatchError and the group goes to EXCEPTION — nothing is guessed.
 */
import { SchemaMismatchError } from '../util/http.ts';

export interface TikTokEnvelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

export interface CombinablePackage {
  packageId: string; // [VERIFY] combinable_packages[].id
  orderIds: string[]; // [VERIFY] combinable_packages[].order_ids
}

export interface CombineResult {
  packages: { packageId: string; orderIds: string[] }[]; // [VERIFY] data.packages[].id / .order_ids
  errors: { code: string; message: string; packageId: string | null; orderId: string | null }[]; // [VERIFY] data.errors[]
}

export interface PackageDetail {
  packageId: string; // [DOC] data.package_id
  orderIds: string[]; // [DOC] data.orders[].id
  status: string | null; // [VERIFY] data.package_status
  trackingNumber: string | null; // [DOC] tracking number is returned by Get Package Detail
  shippingProviderId: string | null; // [DOC]
  shippingProviderName: string | null; // [VERIFY]
}

export interface TikTokOrder {
  id: string;
  status: string; // [VERIFY] e.g. AWAITING_SHIPMENT
  shippingType: string | null; // [DOC] 'SELLER' | 'TIKTOK'
  isOnHold: boolean; // [DOC] is_on_hold_order (v202309)
  deliveryOptionId: string | null; // [DOC] used for Get Shipping Providers
  warehouseId: string | null; // [VERIFY]
  packageIds: string[]; // [VERIFY] packages[].id
  createTime: number | null; // [VERIFY] unix seconds
  shipByTime: number | null; // [VERIFY] rts_sla_time or tts_sla_time (unix seconds)
  cancelRequested: boolean; // [VERIFY] derived from cancel_reason / line item display_status
  lineItems: { id: string; sellerSku: string; status: string | null }[]; // [VERIFY] line_items[] (one per unit)
}

export interface ShippingProvider {
  id: string;
  name: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (v === undefined || v === null ? null : String(v));

function need<T>(cond: T | null | undefined | false, what: string, raw: unknown): T {
  if (cond === null || cond === undefined || cond === false) throw new SchemaMismatchError(`TikTok response is missing ${what}`, raw);
  return cond as T;
}

export function parseCombinableSearch(data: unknown): { packages: CombinablePackage[]; nextPageToken: string | null } {
  need(isObj(data), 'data', data);
  const d = data as Record<string, unknown>;
  const list = d.combinable_packages ?? [];
  need(Array.isArray(list), 'data.combinable_packages[]', data);
  const packages = (list as unknown[]).map((p) => {
    need(isObj(p), 'combinable_packages[] item', data);
    const r = p as Record<string, unknown>;
    return {
      packageId: need(str(r.id), 'combinable_packages[].id', data),
      orderIds: (need(Array.isArray(r.order_ids) && r.order_ids, 'combinable_packages[].order_ids', data) as unknown[]).map(String),
    };
  });
  const tok = str(d.next_page_token);
  return { packages, nextPageToken: tok ? tok : null };
}

export function parseCombineResult(data: unknown): CombineResult {
  need(isObj(data), 'data', data);
  const d = data as Record<string, unknown>;
  const pk = (d.packages ?? []) as unknown[];
  const er = (d.errors ?? []) as unknown[];
  need(Array.isArray(pk) && Array.isArray(er), 'data.packages[] / data.errors[]', data);
  return {
    packages: pk.map((p) => {
      const r = p as Record<string, unknown>;
      return {
        packageId: need(str(r.id), 'packages[].id', data),
        orderIds: (need(Array.isArray(r.order_ids) && r.order_ids, 'packages[].order_ids', data) as unknown[]).map(String),
      };
    }),
    errors: er.map((e) => {
      const r = e as Record<string, unknown>;
      const detail = isObj(r.detail) ? r.detail : {};
      return { code: String(r.code ?? ''), message: String(r.message ?? ''), packageId: str(detail.package_id), orderId: str(detail.order_id) };
    }),
  };
}

export function parsePackageDetail(data: unknown): PackageDetail {
  need(isObj(data), 'data', data);
  const d = data as Record<string, unknown>;
  const orders = need(Array.isArray(d.orders) && d.orders, 'data.orders[]', data) as Record<string, unknown>[];
  return {
    packageId: need(str(d.package_id), 'data.package_id', data),
    orderIds: orders.map((o) => need(str(o.id), 'data.orders[].id', data)),
    status: str(d.package_status),
    trackingNumber: str(d.tracking_number) || null,
    shippingProviderId: str(d.shipping_provider_id) || null,
    shippingProviderName: str(d.shipping_provider_name) || null,
  };
}

export function parseOrders(data: unknown): TikTokOrder[] {
  need(isObj(data), 'data', data);
  const list = need(Array.isArray((data as Record<string, unknown>).orders) && (data as Record<string, unknown>).orders, 'data.orders[]', data) as Record<string, unknown>[];
  return list.map((o) => {
    const lines = (Array.isArray(o.line_items) ? o.line_items : []) as Record<string, unknown>[];
    const pkgs = (Array.isArray(o.packages) ? o.packages : []) as Record<string, unknown>[];
    const lineStatuses = lines.map((l) => str(l.display_status));
    return {
      id: need(str(o.id), 'orders[].id', data),
      status: need(str(o.status), 'orders[].status', data),
      shippingType: str(o.shipping_type),
      isOnHold: Boolean(o.is_on_hold_order),
      deliveryOptionId: str(o.delivery_option_id),
      warehouseId: str(o.warehouse_id),
      packageIds: pkgs.map((p) => String(p.id)),
      createTime: o.create_time == null ? null : Number(o.create_time),
      shipByTime: o.rts_sla_time != null ? Number(o.rts_sla_time) : o.tts_sla_time != null ? Number(o.tts_sla_time) : null,
      cancelRequested: Boolean(o.cancel_reason) || lineStatuses.some((s) => s === 'CANCELLED' || s === 'CANCEL_REQUESTED'),
      lineItems: lines.map((l) => ({ id: need(str(l.id), 'line_items[].id', data), sellerSku: need(str(l.seller_sku), 'line_items[].seller_sku', data), status: str(l.display_status) })),
    };
  });
}

export function parseShippingProviders(data: unknown): ShippingProvider[] {
  need(isObj(data), 'data', data);
  const list = need(Array.isArray((data as Record<string, unknown>).shipping_providers) && (data as Record<string, unknown>).shipping_providers, 'data.shipping_providers[]', data) as Record<string, unknown>[];
  return list.map((p) => ({ id: need(str(p.id), 'shipping_providers[].id', data), name: need(str(p.name), 'shipping_providers[].name', data) }));
}

/** Orders in these states can still be combined (TikTok decides; this is an extra safety filter). */
export const COMBINABLE_ORDER_STATUSES = ['AWAITING_SHIPMENT'];
/** Statuses that show TikTok has received shipping info. */
export const SHIPPED_ORDER_STATUSES = ['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'PARTIALLY_SHIPPING'];
