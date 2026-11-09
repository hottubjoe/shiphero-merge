/** Wires the real engine + real API clients to the fake TikTok/ShipHero servers. */
import { readConfig, type Config } from '../config.ts';
import { Repo } from '../db/repo.ts';
import { Engine } from '../engine/engine.ts';
import { ShipHeroClient } from '../shiphero/client.ts';
import { TikTokClient } from '../tiktok/client.ts';
import { silentLogger, type Logger } from '../util/logger.ts';
import { FakeShipHero } from './fakeShipHero.ts';
import { FakeTikTok } from './fakeTikTok.ts';

export interface HarnessOptions {
  dryRun?: boolean;
  pilotMode?: boolean;
  pilotOrderIds?: string[];
  trackingMode?: 'native_verify' | 'engine';
  autoCombine?: boolean;
  windowMinutes?: number;
  dbFile?: string;
  logger?: Logger;
  workerId?: string;
  shared?: { repo: Repo; tt: FakeTikTok; sh: FakeShipHero; clock: { now: number } };
}

export function createHarness(o: HarnessOptions = {}) {
  const clock = o.shared?.clock ?? { now: Date.parse('2026-11-09T15:00:00Z') };
  const now = () => clock.now;
  const config: Config = {
    ...readConfig({}),
    dryRun: o.dryRun ?? false,
    pilotMode: o.pilotMode ?? false,
    pilotOrderIds: o.pilotOrderIds ?? [],
    trackingMode: o.trackingMode ?? 'engine',
    consolidationWindowMinutes: o.windowMinutes ?? 5,
  };
  config.tiktok = { ...config.tiktok, appKey: 'APPKEY', appSecret: 'APPSECRET', accessToken: 'TT-TOKEN', shopCipher: 'CIPHER-1', shopId: 'SHOP-1', apiBase: 'https://fake-tiktok', authBase: 'https://fake-tiktok-auth' };
  config.shiphero = { ...config.shiphero, accessToken: 'SH-TOKEN', apiBase: 'https://fake-shiphero', webhookSecret: 'whsec_test_secret_123' };
  const repo = o.shared?.repo ?? new Repo(o.dbFile ?? ':memory:', now);
  const tt = o.shared?.tt ?? new FakeTikTok({ appKey: 'APPKEY', appSecret: 'APPSECRET', accessToken: 'TT-TOKEN' });
  const sh = o.shared?.sh ?? new FakeShipHero('SH-TOKEN');
  const noSleep = async () => {};
  const tiktok = new TikTokClient({ ...config.tiktok, repo, transport: tt.transport, clock: now, sleepFn: noSleep });
  const shiphero = new ShipHeroClient({ ...config.shiphero, repo, transport: sh.transport, clock: now, sleepFn: noSleep });
  const logger = o.logger ?? silentLogger;
  const engine = new Engine({ repo, tiktok, shiphero, config, logger, clock: now, workerId: o.workerId ?? 'test-worker' });
  if (!o.shared) {
    repo.setSetting('runtime', {
      dryRun: config.dryRun,
      paused: false,
      autoEligibility: true,
      autoCombine: o.autoCombine ?? !config.pilotMode,
      windowMinutes: config.consolidationWindowMinutes,
      providerOverrides: {},
    });
  }
  const advance = (minutes: number) => (clock.now += minutes * 60_000);
  /** Seed a TikTok order and the matching ShipHero order (as the native integration would import it). */
  const seedOrder = (id: string, buyer: string, skus: Record<string, number>, extra: Partial<Parameters<FakeTikTok['addOrder']>[0]> = {}, shWarehouse = 'WH-1') => {
    const units = Object.entries(skus).flatMap(([s, q]) => Array(q).fill(s));
    tt.addOrder({ id, buyerKey: buyer, skus: units, create_time: Math.floor(clock.now / 1000) - 60, rts_sla_time: Math.floor(clock.now / 1000) + 2 * 86400, ...extra });
    return sh.addOrder(id, `${buyer}@example.com`, skus, shWarehouse);
  };
  return { repo, tt, sh, engine, config, clock, advance, seedOrder, tiktok, shiphero };
}
