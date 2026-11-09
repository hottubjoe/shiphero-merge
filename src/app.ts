/** Builds the real application objects from .env settings. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv, readConfig, type Config } from './config.ts';
import { Repo } from './db/repo.ts';
import { Engine } from './engine/engine.ts';
import { ShipHeroClient } from './shiphero/client.ts';
import { TikTokClient } from './tiktok/client.ts';
import { ApiError } from './util/http.ts';
import { Logger } from './util/logger.ts';

export function buildApp(opts: { quiet?: boolean } = {}) {
  loadDotEnv();
  const config = readConfig();
  const logger = new Logger(config.logFile, opts.quiet);
  const repo = new Repo(config.databaseFile);
  // No SESSION_SECRET set? Create a random one once and keep it in the (private) database.
  if (!config.sessionSecret) {
    let secret = repo.getSetting<string>('session_secret', '');
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      repo.setSetting('session_secret', secret);
    }
    config.sessionSecret = secret;
  }
  const tiktok = new TikTokClient({ ...config.tiktok, repo, logger });
  const shiphero = new ShipHeroClient({ ...config.shiphero, repo, logger });
  const engine = new Engine({ repo, tiktok, shiphero, config, logger });
  // First start: runtime settings follow .env (dry run on, auto-combine off).
  if (!repo.getSetting('runtime', null)) {
    repo.setSetting('runtime', { dryRun: config.dryRun, paused: false, autoEligibility: true, autoCombine: false, windowMinutes: config.consolidationWindowMinutes, providerOverrides: {} });
  }
  // If .env says dry run, force the runtime flag to dry run as well.
  if (config.dryRun && !engine.settings().dryRun) repo.setSetting('runtime', { ...engine.settings(), dryRun: true });
  return { config, logger, repo, tiktok, shiphero, engine };
}

export const describeError = (e: unknown) => (e instanceof ApiError ? `${e.message}${e.requestId ? ` (request ${e.requestId})` : ''}` : (e as Error)?.message ?? String(e));

export async function checkConnections(app: { tiktok: TikTokClient; shiphero: ShipHeroClient; config: Config }) {
  const out: Record<string, { ok: boolean; detail: string }> = {};
  try {
    const r = await app.tiktok.getAuthorizedShops();
    const shop = r.data.shops.find((s) => s.cipher === app.config.tiktok.shopCipher) ?? r.data.shops[0];
    out.tiktok = { ok: true, detail: shop ? `${shop.name} (${shop.region})` : 'authorized, no shops returned' };
  } catch (e) {
    out.tiktok = { ok: false, detail: describeError(e) };
  }
  try {
    const r = await app.shiphero.gql<{ account: { data: { email: string } } }>('query Account { account { request_id data { id email } } }');
    out.shiphero = { ok: true, detail: `connected${r.data.account?.data?.email ? ` as ${r.data.account.data.email}` : ''}` };
  } catch (e) {
    out.shiphero = { ok: false, detail: describeError(e) };
  }
  try {
    const r = await app.tiktok.searchCombinablePackages(20);
    out.combineApi = { ok: true, detail: `available — ${r.packages.length} combinable group(s) right now` };
  } catch (e) {
    out.combineApi = { ok: false, detail: `not available: ${describeError(e)}` };
  }
  return out;
}

/** Update (or add) KEY=value lines in .env without touching anything else. */
export function updateEnvFile(values: Record<string, string>, file = path.resolve(process.cwd(), '.env')) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.trimEnd()}\n${k}=${v}\n`;
  }
  fs.writeFileSync(file, text);
}
