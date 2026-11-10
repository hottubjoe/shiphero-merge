/**
 * READ-ONLY API verification, shared by `npm run verify-api` and the dashboard's "Run API check" button.
 * Changes nothing in TikTok or ShipHero. It answers, for YOUR shop:
 *   1. Do the credentials work, and which US shop should be used? (saved to the database)
 *   2. Is TikTok's Search Combinable Packages API available to this US shop? (the key question)
 *   3. Do TikTok's real responses contain the exact fields this app expects?
 *   4. How are TikTok orders stored in ShipHero (partner_order_id vs order_number)?
 *   5. Do ShipHero's mergeable_orders / order / shipments queries work with this account?
 */
import type { Config } from './config.ts';
import type { Repo } from './db/repo.ts';
import type { ShipHeroClient } from './shiphero/client.ts';
import type { TikTokClient } from './tiktok/client.ts';
import { describeError } from './app.ts';
import { redact } from './util/logger.ts';

export interface VerifyLine {
  ok: boolean | null;
  text: string;
  section: string;
}
export interface VerifyResult {
  at: string;
  lines: VerifyLine[];
  problems: number;
  combineApiAvailable: boolean | null;
  verdict: string;
  markdown: string;
  raw: Record<string, unknown>;
}

export async function runVerification(app: { config: Config; repo: Repo; tiktok: TikTokClient; shiphero: ShipHeroClient }, onLine?: (l: VerifyLine) => void): Promise<VerifyResult> {
  const { config, repo, tiktok, shiphero } = app;
  const lines: VerifyLine[] = [];
  const raw: Record<string, unknown> = {};
  let section = '';
  let combineApiAvailable: boolean | null = null;
  const line = (ok: boolean | null, text: string) => {
    const l = { ok, text, section };
    lines.push(l);
    onLine?.(l);
  };
  const save = (name: string, data: unknown) => (raw[name] = redact(data));

  // ---------------------------------------------------------------- TikTok
  section = 'TikTok Shop';
  let sampleOrderIds: string[] = [];
  const hasToken = !!(config.tiktok.accessToken || config.tiktok.refreshToken || tiktok.hasStoredToken());
  if (!config.tiktok.appKey || !config.tiktok.appSecret) {
    line(false, 'TIKTOK_APP_KEY / TIKTOK_APP_SECRET are not set');
  } else if (!hasToken) {
    line(false, 'TikTok is not connected yet (dashboard → Connect TikTok, or npm run tiktok:auth)');
  } else {
    try {
      const r = await tiktok.getAuthorizedShops();
      save('tiktok-shops', r.raw);
      const shops = r.data.shops ?? [];
      line(true, `Credentials work. Authorized shops: ${shops.map((s) => `${s.name} [${s.region}]`).join(', ') || 'none'}`);
      const us = shops.filter((s) => s.region === 'US');
      if (!tiktok.shopCipher()) {
        if (us.length === 1) {
          repo.setSetting('tiktok_shop', { cipher: us[0].cipher, id: us[0].id, name: us[0].name });
          line(true, `Selected shop ${us[0].name} (saved)`);
        } else {
          line(false, `Set TIKTOK_SHOP_CIPHER to one of: ${shops.map((s) => `${s.name}=${s.cipher}`).join(', ')}`);
        }
      }
    } catch (e) {
      line(false, `Get Authorized Shops failed: ${describeError(e)}`);
    }

    try {
      const r = await tiktok.searchCombinablePackages(50);
      save('tiktok-combinable-packages', r.raw);
      combineApiAvailable = true;
      line(true, `Search Combinable Packages WORKS for this shop: ${r.packages.length} combinable group(s) right now (request ${r.requestIds[0]})`);
      for (const p of r.packages.slice(0, 10)) line(null, `package ${p.packageId}: orders ${p.orderIds.join(', ')}`);
    } catch (e) {
      combineApiAvailable = false;
      line(false, `Search Combinable Packages NOT available: ${describeError(e)}`);
    }

    try {
      const ids = await tiktok.searchAwaitingShipment(20, 1);
      line(true, `Get Order List works: ${ids.length} unshipped order(s) on the first page`);
      sampleOrderIds = ids.slice(0, 3);
      if (sampleOrderIds.length) {
        try {
          const orders = await tiktok.getOrders(sampleOrderIds);
          save('tiktok-order-detail', orders);
          line(true, 'Order Detail has every field this app needs (id, status, line_items[].seller_sku, …)');
          const o = orders[0];
          line(o.shippingType === 'SELLER', `First order shipping_type = ${o.shippingType} (Seller Shipping expected)`);
          line(o.deliveryOptionId ? true : false, `delivery_option_id: ${o.deliveryOptionId ?? 'missing'}`);
          line(o.packageIds.length ? true : false, `packages[].id: ${o.packageIds.join(', ') || 'missing'}`);
          line(o.shipByTime ? true : null, `ship-by time: ${o.shipByTime ? new Date(o.shipByTime * 1000).toISOString() : 'not found (deadline protection uses the window only)'}`);
          if (o.packageIds[0]) {
            try {
              const pkg = await tiktok.getPackageDetail(o.packageIds[0]);
              save('tiktok-package-detail', pkg);
              line(true, `Get Package Detail works (status ${pkg.status ?? 'n/a'})`);
            } catch (e) {
              line(false, `Get Package Detail: ${describeError(e)}`);
            }
          }
          if (o.deliveryOptionId) {
            try {
              const providers = await tiktok.getShippingProviders(o.deliveryOptionId);
              save('tiktok-shipping-providers', providers);
              line(true, `Get Shipping Providers works: ${providers.map((p) => p.name).join(', ')}`);
            } catch (e) {
              line(false, `Get Shipping Providers: ${describeError(e)}`);
            }
          }
        } catch (e) {
          line(false, `Order Detail fields differ from what the app expects: ${describeError(e)}`);
        }
      }
    } catch (e) {
      line(false, `Get Order List failed: ${describeError(e)}`);
    }
  }

  // ---------------------------------------------------------------- ShipHero
  section = 'ShipHero';
  if (!config.shiphero.refreshToken && !config.shiphero.accessToken && !shiphero.hasStoredToken()) {
    line(false, 'ShipHero is not connected yet (dashboard → Connect ShipHero)');
  } else {
    try {
      const r = await shiphero.gql('query Account { account { request_id data { id email } } }');
      save('shiphero-account', r.raw);
      line(true, 'ShipHero credentials work');
    } catch (e) {
      line(false, `ShipHero login failed: ${describeError(e)}`);
    }
    for (const tid of sampleOrderIds) {
      try {
        let field: 'partner_order_id' | 'order_number' = 'partner_order_id';
        let found = await shiphero.findOrdersByTikTokId(tid, field);
        if (!found.length) {
          field = 'order_number';
          found = await shiphero.findOrdersByTikTokId(tid, field);
        }
        if (!found.length) {
          line(null, `TikTok order ${tid} not found in ShipHero by partner_order_id or order_number (may not be imported yet)`);
          continue;
        }
        const o = found[0];
        line(field === config.shiphero.tiktokIdField, `TikTok order ${tid} = ShipHero order ${o.orderNumber} (matched by ${field}${field !== config.shiphero.tiktokIdField ? '; set SHIPHERO_TIKTOK_ID_FIELD=' + field : ''})`);
        const full = await shiphero.getOrder(o.id);
        save('shiphero-order', full);
        line(full ? true : false, `order(id) query works; warehouses ${full?.warehouseIds.join(', ') || 'n/a'}`);
        const m = await shiphero.mergeableOrders(o.orderNumber);
        save('shiphero-mergeable', m);
        line(true, `mergeable_orders query works (${m[0]?.potentialMerges.length ?? 0} potential merge(s) for ${o.orderNumber})`);
        await shiphero.shipmentsForOrder(o.id);
        line(true, 'shipments query works (shipment polling available)');
        break;
      } catch (e) {
        line(false, `ShipHero query problem: ${describeError(e)}`);
        break;
      }
    }
    if (!sampleOrderIds.length) line(null, 'No unshipped TikTok orders to look up in ShipHero right now.');
  }

  const problems = lines.filter((l) => l.ok === false).length;
  const verdict =
    problems === 0
      ? 'All checks passed. Next: pick 2 eligible orders for the pilot (see LIVE_PILOT_CHECKLIST.md).'
      : `${problems} problem(s) found. The app stays in dry run until they are fixed.`;
  const icon = (ok: boolean | null) => (ok === null ? '•' : ok ? '✔' : '✘');
  const md: string[] = [`# COLDEST API verification (${new Date().toISOString()})`, '', 'Read-only. Nothing was changed.'];
  let last = '';
  for (const l of lines) {
    if (l.section !== last) md.push('', `## ${l.section}`);
    last = l.section;
    md.push(`- ${icon(l.ok)} ${l.text}`);
  }
  if (combineApiAvailable === false) {
    md.push('', '**Combine-first via API is not available with this app/shop.** Check that the app has the "Package Split And Combine" scope and that the shop was re-authorized after adding it. If it still fails, TikTok does not offer pre-shipping combination by API for this US shop. Keep DRY_RUN=true and see docs/API_FINDINGS.md.');
  }
  md.push('', `**${verdict}**`);
  const result: VerifyResult = { at: new Date().toISOString(), lines, problems, combineApiAvailable, verdict, markdown: md.join('\n'), raw };
  repo.setSetting('last_verification', result);
  return result;
}
