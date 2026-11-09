/**
 * TikTok Shop Open API client — US shop, API version 202309.
 *
 * Endpoints used (all from the official TikTok Shop Partner Center reference):
 *   GET  /authorization/202309/shops                                  Get Authorized Shops
 *   POST /order/202309/orders/search                                   Get Order List
 *   GET  /order/202309/orders?ids=...                                  Get Order Detail
 *   GET  /fulfillment/202309/combinable_packages/search                Search Combinable Packages   (scope seller.fulfillment.package.write)
 *   POST /fulfillment/202309/packages/combine                          Combine Package              (scope seller.fulfillment.package.write)
 *   GET  /fulfillment/202309/packages/{package_id}                     Get Package Detail           (scope seller.fulfillment.basic)
 *   GET  /logistics/202309/delivery_options/{id}/shipping_providers    Get Shipping Providers
 *   POST /fulfillment/202309/packages/{package_id}/ship                Ship Package (self_shipment) (scope seller.fulfillment.basic)
 *   GET  {auth}/api/v2/token/get | /api/v2/token/refresh               Access-token exchange / refresh
 */
import type { Repo } from '../db/repo.ts';
import type { Logger } from '../util/logger.ts';
import { ApiError, NetworkError, SchemaMismatchError, fetchTransport, parseJson, retryRead, type Transport } from '../util/http.ts';
import { signTikTokRequest } from './sign.ts';
import {
  parseCombinableSearch,
  parseCombineResult,
  parseOrders,
  parsePackageDetail,
  parseShippingProviders,
  type CombinablePackage,
  type CombineResult,
  type PackageDetail,
  type ShippingProvider,
  type TikTokEnvelope,
  type TikTokOrder,
} from './types.ts';

export const TIKTOK_VERSION = '202309';

export interface TikTokClientOptions {
  appKey: string;
  appSecret: string;
  shopCipher: string;
  apiBase: string;
  authBase: string;
  accessToken?: string;
  refreshToken?: string;
  repo?: Repo;
  logger?: Logger;
  transport?: Transport;
  clock?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface TikTokResult<T> {
  data: T;
  requestId: string;
  raw: unknown;
}

export class TikTokClient {
  private transport: Transport;
  private clock: () => number;
  constructor(private o: TikTokClientOptions) {
    this.transport = o.transport ?? fetchTransport;
    this.clock = o.clock ?? Date.now;
  }

  /** Shop cipher from settings (.env / Railway variables) or, if empty, the one saved by the API check. */
  shopCipher(): string {
    return this.o.shopCipher || this.o.repo?.getSetting<{ cipher: string } | null>('tiktok_shop', null)?.cipher || '';
  }
  hasStoredToken(): boolean {
    return !!(this.o.repo?.getToken('tiktok')?.access_token);
  }

  // ------------------------------------------------------------ auth
  private tokenState() {
    const saved = this.o.repo?.getToken('tiktok');
    return {
      access: saved?.access_token || this.o.accessToken || '',
      refresh: saved?.refresh_token || this.o.refreshToken || '',
      accessExpiresAt: saved?.access_expires_at ? Date.parse(saved.access_expires_at) : null,
    };
  }

  /** Exchange the one-time authorization code from the seller authorization page for tokens. */
  async exchangeAuthCode(authCode: string) {
    const q = new URLSearchParams({ app_key: this.o.appKey, app_secret: this.o.appSecret, auth_code: authCode, grant_type: 'authorized_code' });
    return this.tokenCall(`${this.o.authBase}/api/v2/token/get?${q}`);
  }

  async refreshAccessToken() {
    const { refresh } = this.tokenState();
    if (!refresh) throw new Error('No TikTok refresh token. Run: npm run tiktok:auth');
    const q = new URLSearchParams({ app_key: this.o.appKey, app_secret: this.o.appSecret, refresh_token: refresh, grant_type: 'refresh_token' });
    return this.tokenCall(`${this.o.authBase}/api/v2/token/refresh?${q}`);
  }

  private async tokenCall(url: string) {
    const res = await this.transport({ method: 'GET', url, headers: { 'content-type': 'application/json' } });
    const json = parseJson(res.body, 'TikTok token endpoint') as TikTokEnvelope<Record<string, unknown>>;
    if (res.status !== 200 || json.code !== 0) throw new ApiError(`TikTok token error: ${json.message}`, res.status, json.code, json.request_id ?? null, json);
    const d = json.data;
    if (!d?.access_token) throw new SchemaMismatchError('Token response missing data.access_token', json);
    const tok = {
      access_token: String(d.access_token),
      refresh_token: d.refresh_token ? String(d.refresh_token) : null,
      // TikTok returns expiry as a unix timestamp in seconds
      access_expires_at: d.access_token_expire_in ? new Date(Number(d.access_token_expire_in) * 1000).toISOString() : null,
      refresh_expires_at: d.refresh_token_expire_in ? new Date(Number(d.refresh_token_expire_in) * 1000).toISOString() : null,
    };
    this.o.repo?.saveToken('tiktok', tok);
    this.o.logger?.info('TikTok token saved', { access_expires_at: tok.access_expires_at, seller: d.seller_name });
    return { ...tok, sellerName: d.seller_name ? String(d.seller_name) : null };
  }

  private async accessToken(): Promise<string> {
    const t = this.tokenState();
    // Refresh one day before expiry
    if (t.refresh && (!t.access || (t.accessExpiresAt !== null && t.accessExpiresAt - this.clock() < 24 * 3600_000))) {
      const r = await this.refreshAccessToken();
      return r.access_token;
    }
    if (!t.access) throw new Error('TikTok is not authorized. Run: npm run tiktok:auth');
    return t.access;
  }

  // ------------------------------------------------------------ core request
  private async call<T = unknown>(method: 'GET' | 'POST', path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown; shop?: boolean } = {}): Promise<TikTokResult<T>> {
    const token = await this.accessToken();
    const query: Record<string, string> = { app_key: this.o.appKey, timestamp: String(Math.floor(this.clock() / 1000)) };
    if (opts.shop !== false) {
      const cipher = this.shopCipher();
      if (!cipher) throw new Error('TikTok shop not selected yet. Run the API check (dashboard or npm run verify-api).');
      query.shop_cipher = cipher;
    }
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') query[k] = String(v);
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    query.sign = signTikTokRequest({ path, query, body, appSecret: this.o.appSecret, contentType: 'application/json' });
    const url = `${this.o.apiBase}${path}?${new URLSearchParams(query)}`;
    const res = await this.transport({ method, url, headers: { 'content-type': 'application/json', 'x-tts-access-token': token }, body });
    const json = parseJson(res.body, `TikTok ${path}`) as TikTokEnvelope<T>;
    if (res.status === 429) throw new ApiError('TikTok rate limit (HTTP 429)', 429, json?.code ?? null, json?.request_id ?? null, json);
    if (res.status >= 400 || json.code !== 0) {
      throw new ApiError(`TikTok ${path} failed: [${json?.code}] ${json?.message}`, res.status, json?.code ?? null, json?.request_id ?? null, json);
    }
    return { data: json.data, requestId: json.request_id, raw: json };
  }

  private read<T>(fn: () => Promise<T>) {
    return retryRead(fn, { sleepFn: this.o.sleepFn });
  }

  // ------------------------------------------------------------ read-only APIs
  getAuthorizedShops() {
    return this.read(() => this.call<{ shops: { id: string; name: string; region: string; cipher: string; code: string }[] }>('GET', `/authorization/${TIKTOK_VERSION}/shops`, { shop: false }));
  }

  /** All authoritative combinable package groups, following pagination to the end. */
  async searchCombinablePackages(pageSize = 50): Promise<{ packages: CombinablePackage[]; requestIds: string[]; raw: unknown[] }> {
    const packages: CombinablePackage[] = [];
    const requestIds: string[] = [];
    const raw: unknown[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < 200; page++) {
      const r = await this.read(() => this.call('GET', `/fulfillment/${TIKTOK_VERSION}/combinable_packages/search`, { query: { page_size: pageSize, page_token: pageToken ?? undefined } }));
      const parsed = parseCombinableSearch(r.data);
      packages.push(...parsed.packages);
      requestIds.push(r.requestId);
      raw.push(r.raw);
      if (!parsed.nextPageToken || parsed.nextPageToken === pageToken) break;
      pageToken = parsed.nextPageToken;
    }
    return { packages, requestIds, raw };
  }

  async getOrders(ids: string[]): Promise<TikTokOrder[]> {
    const out: TikTokOrder[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const r = await this.read(() => this.call('GET', `/order/${TIKTOK_VERSION}/orders`, { query: { ids: chunk.join(',') } }));
      out.push(...parseOrders(r.data));
    }
    return out;
  }

  /** Unshipped orders (for the dashboard). */
  async searchAwaitingShipment(pageSize = 50, maxPages = 20): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let p = 0; p < maxPages; p++) {
      const r = await this.read(() =>
        this.call<{ orders?: { id: string }[]; next_page_token?: string }>('POST', `/order/${TIKTOK_VERSION}/orders/search`, { query: { page_size: pageSize, page_token: pageToken }, body: { order_status: 'AWAITING_SHIPMENT' } }),
      );
      for (const o of r.data.orders ?? []) ids.push(String(o.id));
      if (!r.data.next_page_token || r.data.next_page_token === pageToken) break;
      pageToken = r.data.next_page_token;
    }
    return ids;
  }

  async getPackageDetail(packageId: string): Promise<PackageDetail & { requestId: string }> {
    const r = await this.read(() => this.call('GET', `/fulfillment/${TIKTOK_VERSION}/packages/${encodeURIComponent(packageId)}`));
    return { ...parsePackageDetail(r.data), requestId: r.requestId };
  }

  async getShippingProviders(deliveryOptionId: string): Promise<ShippingProvider[]> {
    const r = await this.read(() => this.call('GET', `/logistics/${TIKTOK_VERSION}/delivery_options/${encodeURIComponent(deliveryOptionId)}/shipping_providers`));
    return parseShippingProviders(r.data);
  }

  // ------------------------------------------------------------ MUTATIONS (never auto-retried here)
  /** Body uses the documented `combinable_packages` array. One attempt only — the engine reconciles on timeout. */
  async combinePackages(items: { packageId: string; orderIds: string[] }[]): Promise<CombineResult & { requestId: string; raw: unknown }> {
    const r = await this.call('POST', `/fulfillment/${TIKTOK_VERSION}/packages/combine`, {
      body: { combinable_packages: items.map((i) => ({ id: i.packageId, order_ids: i.orderIds })) },
    });
    return { ...parseCombineResult(r.data), requestId: r.requestId, raw: r.raw };
  }

  /** Seller Shipping: submit the real carrier tracking number against ONE package. */
  async shipPackageSelfShipment(packageId: string, trackingNumber: string, shippingProviderId: string): Promise<{ requestId: string; raw: unknown }> {
    const r = await this.call('POST', `/fulfillment/${TIKTOK_VERSION}/packages/${encodeURIComponent(packageId)}/ship`, {
      body: { self_shipment: { tracking_number: trackingNumber, shipping_provider_id: shippingProviderId } },
    });
    return { requestId: r.requestId, raw: r.raw };
  }
}

export { NetworkError };
