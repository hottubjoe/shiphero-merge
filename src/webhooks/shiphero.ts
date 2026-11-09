/**
 * ShipHero "Shipment Update" webhook handling.
 * Docs: https://developer.shiphero.com/webhooks/shipment-update-webhook/
 *
 * Merged orders: ShipHero fires ONE webhook per order in the merge group (master + every sub-order).
 * All of them share the same shipment_id and tracking_number; order_number / partner_order_id /
 * order_uuid / line_items are specific to each call. We store one row per (shipment_id, order) —
 * that keeps every order's line items for completeness checks, while exact repeats are dropped.
 */
import crypto from 'node:crypto';
import type { Repo } from '../db/repo.ts';

export interface ParsedShipmentEvent {
  shipmentId: string;
  trackingNumber: string | null;
  carrier: string | null;
  labelCost: number | null;
  orderNumber: string | null;
  orderUuid: string | null;
  partnerOrderId: string | null;
  lineItems: { sku: string; quantity: number; line_item_id?: string }[];
  isTest: boolean;
}

type O = Record<string, unknown>;

export function parseShipmentUpdate(payload: unknown): ParsedShipmentEvent {
  const p = payload as O;
  const f = (p?.fulfillment ?? null) as O | null;
  if (!f || f.shipment_id == null) throw new Error('Not a Shipment Update payload (missing fulfillment.shipment_id)');
  const packages = (Array.isArray(p.packages) ? p.packages : []) as O[];
  // The docs say the packages[] copies of carrier/tracking are the most accurate.
  const label = (packages[0]?.shipping_label ?? {}) as O;
  const labelCost = packages.reduce((s, pk) => s + Number(((pk.shipping_label ?? {}) as O).cost ?? 0), 0);
  const lineItems = ((Array.isArray(f.line_items) ? f.line_items : []) as O[]).map((li) => ({
    sku: String(li.sku),
    quantity: Number(li.quantity ?? 0),
    line_item_id: li.id == null ? undefined : String(li.id),
  }));
  return {
    shipmentId: String(f.shipment_id),
    trackingNumber: String(label.tracking_number ?? f.tracking_number ?? '') || null,
    carrier: String(label.shipping_carrier ?? f.shipping_carrier ?? '') || null,
    labelCost: packages.length ? labelCost : null,
    orderNumber: f.order_number == null ? null : String(f.order_number),
    orderUuid: f.order_uuid == null ? null : String(f.order_uuid),
    partnerOrderId: f.partner_order_id == null ? null : String(f.partner_order_id),
    lineItems,
    isTest: p.test === true || p.test === 1 || p.test === '1',
  };
}

/** Physical-shipment identity + order identity. Same shipment for two orders = two rows, same row twice = duplicate. */
export const shipmentDedupeKey = (shipmentId: string, orderNumber: string | null, orderUuid: string | null) => `${shipmentId}:${orderNumber ?? orderUuid ?? 'unknown'}`;

export function ingestShipmentEvent(repo: Repo, payload: unknown, source: 'webhook' | 'poll' = 'webhook'): { result: 'new' | 'duplicate'; event: ParsedShipmentEvent } {
  const e = parseShipmentUpdate(payload);
  const result = repo.insertShipmentEvent({
    dedupe_key: shipmentDedupeKey(e.shipmentId, e.orderNumber, e.orderUuid),
    shipment_id: e.shipmentId,
    tracking_number: e.trackingNumber,
    carrier: e.carrier,
    label_cost: e.labelCost,
    order_number: e.orderNumber,
    order_uuid: e.orderUuid,
    partner_order_id: e.partnerOrderId,
    line_items: e.lineItems,
    is_test: e.isTest,
    raw: payload,
  });
  repo.audit(null, source, `shipment_event_${result}`, false, { shipment_id: e.shipmentId, order_number: e.orderNumber, tracking: e.trackingNumber });
  return { result, event: e };
}

/**
 * Webhook authenticity. ShipHero signs webhooks with an HMAC-SHA256 of the raw body using your
 * API secret, base64-encoded, in the `x-shiphero-hmac-sha256` header. [VERIFY with ShipHero support —
 * the Shipment Update page itself does not describe it.] As a second option, a secret token can be
 * placed in the webhook URL (?token=...). At least one must match, otherwise the request is rejected.
 */
export function verifyShipHeroWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, urlToken: string | null, secret: string): boolean {
  if (!secret) return false;
  const sig = headers['x-shiphero-hmac-sha256'];
  const sigStr = Array.isArray(sig) ? sig[0] : sig;
  if (sigStr) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(sigStr);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  if (urlToken) {
    const a = Buffer.from(urlToken);
    const b = Buffer.from(secret);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** Body ShipHero expects back (from the docs). */
export const SHIPHERO_WEBHOOK_OK = JSON.stringify({ code: '200', Message: 'Success' });
