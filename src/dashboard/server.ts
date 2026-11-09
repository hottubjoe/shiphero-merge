/**
 * Local dashboard (http://localhost:4870) + a SEPARATE webhook listener (port 4871).
 * - Dashboard binds to 127.0.0.1 only and requires the DASHBOARD_PASSWORD.
 * - Only the webhook port should ever be exposed to the internet (via a tunnel), and it accepts
 *   nothing except signed ShipHero Shipment Update webhooks.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Engine } from '../engine/engine.ts';
import type { Step } from '../db/repo.ts';
import { SHIPHERO_WEBHOOK_OK, ingestShipmentEvent, verifyShipHeroWebhook } from '../webhooks/shiphero.ts';
import type { VerifyResult } from '../verify.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'cme_session';
const SESSION_HOURS = 12;

export interface DashboardOptions {
  engine: Engine;
  password: string;
  sessionSecret: string;
  webhookSecret: string;
  connections?: () => Promise<Record<string, unknown>>;
  unshipped?: () => Promise<number | null>;
  /** Run the read-only API check. */
  verify?: () => Promise<VerifyResult>;
  /** Exchange a TikTok authorization code for tokens (stored in the database). */
  connectTikTok?: (code: string) => Promise<{ sellerName: string | null; access_expires_at: string | null }>;
  setupInfo?: () => Record<string, unknown>;
  /** Behind a proxy (Railway): take the visitor IP from X-Forwarded-For. */
  trustProxy?: boolean;
  /** Mark the login cookie Secure (HTTPS only). */
  cookieSecure?: boolean;
}

export function clientIp(req: http.IncomingMessage, trustProxy?: boolean): string {
  if (trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xf) ? xf[0] : xf)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? '?';
}
const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');

function sign(secret: string, payload: string) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}
export function makeSession(secret: string, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: now + SESSION_HOURS * 3600_000, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}
export function checkSession(secret: string, cookieHeader: string | undefined, now = Date.now()): boolean {
  const m = (cookieHeader ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!m) return false;
  const [payload, sig] = m.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig) return false;
  const expected = sign(secret, payload);
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > now;
  } catch {
    return false;
  }
}

function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const SEC_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:",
};
function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const isStr = typeof body === 'string';
  res.writeHead(status, { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...SEC_HEADERS, ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

export function createDashboardHandler(o: DashboardOptions) {
  const failed = new Map<string, { n: number; until: number }>();
  // Global brake against password guessing from many IPs: >20 failures in 15 min locks login for 15 min.
  let globalFails: number[] = [];
  let globalLockUntil = 0;
  const cookieAttrs = `HttpOnly; SameSite=Lax; Path=/${o.cookieSecure ? '; Secure' : ''}`;
  const page = (name: string) => fs.readFileSync(path.join(here, 'public', name), 'utf8');
  let unshippedCache: { at: number; value: number | null } | null = null;
  let connCache: { at: number; value: Record<string, unknown> } | null = null;

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ip = clientIp(req, o.trustProxy);
    try {
      // ---------------- login
      if (url.pathname === '/login' && req.method === 'POST') {
        const f = failed.get(ip);
        if ((f && f.until > Date.now()) || globalLockUntil > Date.now()) return send(res, 429, { error: 'Too many attempts. Wait a few minutes.' });
        const body = new URLSearchParams(await readBody(req));
        const pw = body.get('password') ?? '';
        const next = safeNext(body.get('next'));
        const a = crypto.createHash('sha256').update(pw).digest();
        const b = crypto.createHash('sha256').update(o.password).digest();
        if (!o.password || !crypto.timingSafeEqual(a, b)) {
          const n = (f?.n ?? 0) + 1;
          failed.set(ip, { n, until: n >= 5 ? Date.now() + 5 * 60_000 : 0 });
          globalFails = [...globalFails.filter((t) => t > Date.now() - 15 * 60_000), Date.now()];
          if (globalFails.length > 20) globalLockUntil = Date.now() + 15 * 60_000;
          o.engine.repo.audit(null, `ip:${ip}`, 'login_failed', o.engine.isDryRun());
          return send(res, 302, '', { location: `/?error=1${next !== '/' ? `&next=${encodeURIComponent(next)}` : ''}` });
        }
        failed.delete(ip);
        o.engine.repo.audit(null, `ip:${ip}`, 'login', o.engine.isDryRun());
        return send(res, 302, '', { location: next, 'set-cookie': `${COOKIE}=${makeSession(o.sessionSecret)}; ${cookieAttrs}; Max-Age=${SESSION_HOURS * 3600}` });
      }
      if (url.pathname === '/logout') return send(res, 302, '', { location: '/', 'set-cookie': `${COOKIE}=; ${cookieAttrs}; Max-Age=0` });

      const authed = checkSession(o.sessionSecret, req.headers.cookie);
      if (!authed) {
        if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'Not logged in' });
        return send(res, 200, page('login.html'));
      }
      if (url.pathname === '/' && req.method === 'GET') return send(res, 200, page('index.html'));
      // TikTok sends the seller back here after authorizing (set this as the app's redirect URL).
      if (url.pathname === '/tiktok/callback' && req.method === 'GET') return send(res, 200, page('connect.html'));

      // Every state-changing request must carry this header (blocks cross-site form posts).
      if (req.method === 'POST' && req.headers['x-coldest-csrf'] !== '1') return send(res, 403, { error: 'Missing CSRF header' });
      const actor = 'dashboard';
      const e = o.engine;

      if (url.pathname === '/api/status' && req.method === 'GET') {
        const groups = e.repo.listGroups();
        if (o.unshipped && (!unshippedCache || Date.now() - unshippedCache.at > 120_000)) {
          unshippedCache = { at: Date.now(), value: await o.unshipped().catch(() => null) };
        }
        return send(res, 200, {
          config: { envDryRun: e.cfg.dryRun, pilotMode: e.cfg.pilotMode, pilotOrderIds: e.cfg.pilotOrderIds, trackingMode: e.cfg.trackingMode, blockedCarriers: e.cfg.blockedCarriers, windowDefault: e.cfg.consolidationWindowMinutes },
          dryRun: e.isDryRun(),
          settings: e.settings(),
          metrics: e.metrics(),
          unshipped: unshippedCache?.value ?? null,
          groups,
        });
      }
      if (url.pathname === '/api/connections' && req.method === 'GET') {
        if (!connCache || Date.now() - connCache.at > 300_000 || url.searchParams.get('refresh')) {
          connCache = { at: Date.now(), value: o.connections ? await o.connections() : {} };
        }
        return send(res, 200, connCache.value);
      }
      const gm = url.pathname.match(/^\/api\/groups\/([\w-]+)(?:\/(approve|retry))?$/);
      if (gm && req.method === 'GET' && !gm[2]) {
        const g = e.repo.getGroup(gm[1]);
        if (!g) return send(res, 404, { error: 'not found' });
        return send(res, 200, { group: g, operations: e.repo.listOps(g.id), audit: e.repo.listAudit(g.id) });
      }
      if (gm && req.method === 'POST' && gm[2] === 'approve') {
        const { step } = JSON.parse((await readBody(req)) || '{}') as { step: Step };
        if (!['combine', 'merge', 'ship'].includes(step)) return send(res, 400, { error: 'bad step' });
        e.approve(gm[1], step, actor);
        await e.processGroup(gm[1]);
        return send(res, 200, { group: e.repo.getGroup(gm[1]) });
      }
      if (gm && req.method === 'POST' && gm[2] === 'retry') {
        e.retry(gm[1], actor);
        await e.processGroup(gm[1]);
        return send(res, 200, { group: e.repo.getGroup(gm[1]) });
      }
      if (url.pathname === '/api/settings' && req.method === 'POST') {
        const patch = JSON.parse((await readBody(req)) || '{}');
        const allowed = ['dryRun', 'paused', 'autoEligibility', 'autoCombine', 'windowMinutes'];
        const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
        return send(res, 200, { settings: e.updateSettings(clean, actor) });
      }
      if (url.pathname === '/api/run-now' && req.method === 'POST') {
        await e.tick();
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/setup' && req.method === 'GET') {
        return send(res, 200, { ...(o.setupInfo?.() ?? {}), lastVerification: e.repo.getSetting('last_verification', null) });
      }
      if (url.pathname === '/api/verify' && req.method === 'POST') {
        if (!o.verify) return send(res, 400, { error: 'not available' });
        e.repo.audit(null, actor, 'api_check_run', e.isDryRun());
        return send(res, 200, await o.verify());
      }
      if (url.pathname === '/api/tiktok/connect' && req.method === 'POST') {
        if (!o.connectTikTok) return send(res, 400, { error: 'not available' });
        const { code } = JSON.parse((await readBody(req)) || '{}') as { code?: string };
        const clean = String(code ?? '').trim().replace(/^.*[?&]code=([^&#]+).*$/s, '$1');
        if (!clean || clean.length > 2000) return send(res, 400, { error: 'Paste the authorization code or the full address that contains ?code=' });
        const r = await o.connectTikTok(decodeURIComponent(clean));
        e.repo.audit(null, actor, 'tiktok_connected', e.isDryRun(), { seller: r.sellerName, expires: r.access_expires_at });
        return send(res, 200, r);
      }
      if (url.pathname === '/api/audit' && req.method === 'GET') return send(res, 200, { audit: e.repo.listAudit(undefined, 500), operations: e.repo.listOps() });
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  };
}

/** Webhook-only listener. Nothing else is reachable on this port. */
export function createWebhookHandler(o: { engine: Engine; webhookSecret: string }) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/webhooks/shiphero/shipment-update' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    try {
      const raw = await readBody(req);
      if (!verifyShipHeroWebhook(raw, req.headers, url.searchParams.get('token'), o.webhookSecret)) {
        o.engine.repo.audit(null, 'webhook', 'webhook_rejected_signature', o.engine.isDryRun());
        res.writeHead(401).end();
        return;
      }
      const { result, event } = ingestShipmentEvent(o.engine.repo, JSON.parse(raw));
      o.engine.log.info('ShipHero shipment webhook', { result, shipment: event.shipmentId, order: event.orderNumber });
      // Process soon (outside the request, so ShipHero gets a fast 200).
      const g = o.engine.repo.groupForShipHeroOrder(event.orderUuid, event.orderNumber, event.partnerOrderId);
      if (g) setTimeout(() => void o.engine.processGroup(g.id), 2_000).unref();
      res.writeHead(200, { 'content-type': 'application/json' }).end(SHIPHERO_WEBHOOK_OK);
    } catch (err) {
      o.engine.log.warn('Bad webhook', { error: String(err) });
      res.writeHead(400).end();
    }
  };
}

/**
 * Cloud mode: one port for everything. /healthz and the webhook route are answered BEFORE any
 * dashboard logic; everything else requires the dashboard login.
 */
export function createCombinedHandler(o: DashboardOptions) {
  const dash = createDashboardHandler(o);
  const hook = createWebhookHandler({ engine: o.engine, webhookSecret: o.webhookSecret });
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const p = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (p === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (p.startsWith('/webhooks/')) return hook(req, res);
    return dash(req, res);
  };
}

export function startServers(o: DashboardOptions, opts: { host: string; port: number; singlePort: boolean }) {
  if (opts.singlePort) {
    return { dash: http.createServer(createCombinedHandler(o)).listen(opts.port, opts.host), hook: null };
  }
  const dash = http.createServer(createDashboardHandler(o)).listen(opts.port, opts.host);
  const hook = http.createServer(createWebhookHandler({ engine: o.engine, webhookSecret: o.webhookSecret })).listen(opts.port + 1, opts.host);
  return { dash, hook };
}
