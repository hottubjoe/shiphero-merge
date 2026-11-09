import fs from 'node:fs';
import path from 'node:path';

/** Minimal .env loader (no external packages, works on Windows). */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export type TrackingMode = 'native_verify' | 'engine';

export interface Config {
  dryRun: boolean;
  pilotMode: boolean;
  pilotOrderIds: string[];
  trackingMode: TrackingMode;
  blockedCarriers: string[];
  dashboardPort: number;
  /** 127.0.0.1 on your PC; 0.0.0.0 in the cloud (set by the Dockerfile). */
  host: string;
  /** Cloud mode: dashboard + webhook + health check share ONE port (Railway gives one). */
  singlePort: boolean;
  /** Behind Railway's HTTPS proxy: trust X-Forwarded-For / mark cookies Secure. */
  trustProxy: boolean;
  cookieSecure: boolean;
  dashboardPassword: string;
  sessionSecret: string;
  tiktok: {
    appKey: string;
    appSecret: string;
    accessToken: string;
    refreshToken: string;
    shopCipher: string;
    shopId: string;
    apiBase: string;
    authBase: string;
  };
  shiphero: {
    refreshToken: string;
    accessToken: string;
    apiBase: string;
    webhookSecret: string;
    tiktokIdField: 'partner_order_id' | 'order_number';
  };
  consolidationWindowMinutes: number;
  deadlineSafetyHours: number;
  pollIntervalSeconds: number;
  avgSingleLabelCost: number | null;
  /** Hard cap from TikTok policy: one tracking number may cover at most 20 orders. */
  maxOrdersPerGroup: number;
  databaseFile: string;
  logFile: string;
}

const bool = (v: string | undefined, def: boolean) =>
  v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
const num = (v: string | undefined, def: number) => (v === undefined || v === '' || isNaN(Number(v)) ? def : Number(v));
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const trackingMode = (env.TRACKING_MODE ?? 'native_verify') as TrackingMode;
  if (!['native_verify', 'engine'].includes(trackingMode)) throw new Error(`TRACKING_MODE must be native_verify or engine`);
  const idField = (env.SHIPHERO_TIKTOK_ID_FIELD ?? 'partner_order_id') as Config['shiphero']['tiktokIdField'];
  return {
    // SAFETY: defaults are DRY_RUN=true and PILOT_MODE=true
    dryRun: bool(env.DRY_RUN, true),
    pilotMode: bool(env.PILOT_MODE, true),
    pilotOrderIds: list(env.PILOT_ORDER_IDS),
    trackingMode,
    blockedCarriers: list(env.BLOCKED_CARRIERS ?? 'USPS').map((s) => s.toUpperCase()),
    // Railway (and most hosts) tell the app which port to use via PORT.
    dashboardPort: num(env.PORT, num(env.DASHBOARD_PORT, 4870)),
    host: env.HOST || '127.0.0.1',
    singlePort: bool(env.SINGLE_PORT, !!env.PORT),
    trustProxy: bool(env.TRUST_PROXY, false),
    cookieSecure: bool(env.COOKIE_SECURE, false),
    dashboardPassword: env.DASHBOARD_PASSWORD ?? '',
    sessionSecret: env.SESSION_SECRET ?? '',
    tiktok: {
      appKey: env.TIKTOK_APP_KEY ?? '',
      appSecret: env.TIKTOK_APP_SECRET ?? '',
      accessToken: env.TIKTOK_ACCESS_TOKEN ?? '',
      refreshToken: env.TIKTOK_REFRESH_TOKEN ?? '',
      shopCipher: env.TIKTOK_SHOP_CIPHER ?? '',
      shopId: env.TIKTOK_SHOP_ID ?? '',
      apiBase: env.TIKTOK_API_BASE || 'https://open-api.tiktokglobalshop.com',
      authBase: env.TIKTOK_AUTH_BASE || 'https://auth.tiktok-shops.com',
    },
    shiphero: {
      refreshToken: env.SHIPHERO_REFRESH_TOKEN ?? '',
      accessToken: env.SHIPHERO_ACCESS_TOKEN ?? '',
      apiBase: env.SHIPHERO_API_BASE || 'https://public-api.shiphero.com',
      webhookSecret: env.SHIPHERO_WEBHOOK_SECRET ?? '',
      tiktokIdField: idField,
    },
    consolidationWindowMinutes: num(env.CONSOLIDATION_WINDOW_MINUTES, 5),
    deadlineSafetyHours: num(env.DEADLINE_SAFETY_HOURS, 12),
    pollIntervalSeconds: num(env.POLL_INTERVAL_SECONDS, 60),
    avgSingleLabelCost: env.AVG_SINGLE_LABEL_COST ? Number(env.AVG_SINGLE_LABEL_COST) : null,
    maxOrdersPerGroup: 20,
    databaseFile: env.DATABASE_FILE || './data/coldest-merge.sqlite',
    logFile: env.LOG_FILE || './data/engine.log',
  };
}

/** Problems that stop the dashboard itself from starting. */
export function dashboardProblems(c: Config): string[] {
  const p: string[] = [];
  const min = c.host === '127.0.0.1' ? 12 : 16; // stricter when reachable from the internet
  if (c.dashboardPassword.length < min) p.push(`DASHBOARD_PASSWORD must be at least ${min} characters.`);
  if (c.sessionSecret.length < 32) p.push('SESSION_SECRET must be at least 32 random characters.');
  return p;
}

/**
 * Problems that stop background processing. Tokens and the shop cipher may live in the
 * database (connected from the dashboard) instead of environment variables.
 */
export function connectionProblems(c: Config, stored: { tiktokToken: boolean; shopCipher: boolean }): string[] {
  const p: string[] = [];
  if (!c.tiktok.appKey || !c.tiktok.appSecret) p.push('TIKTOK_APP_KEY and TIKTOK_APP_SECRET are missing.');
  if (!c.tiktok.accessToken && !c.tiktok.refreshToken && !stored.tiktokToken) p.push('TikTok is not connected yet (dashboard → Connect TikTok).');
  if (!c.tiktok.shopCipher && !stored.shopCipher) p.push('TikTok shop not selected yet (dashboard → Run API check).');
  if (!c.shiphero.refreshToken && !c.shiphero.accessToken) p.push('SHIPHERO_REFRESH_TOKEN is missing.');
  if (!c.dryRun && c.pilotMode && c.pilotOrderIds.length !== 2) p.push('Live pilot requires exactly 2 PILOT_ORDER_IDS.');
  return p;
}
