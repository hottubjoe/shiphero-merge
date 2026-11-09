/** Main entry point: `npm start` (your PC) or the Docker image (Railway). */
import crypto from 'node:crypto';
import http from 'node:http';
import { buildApp, checkConnections } from './app.ts';
import { connectionProblems, dashboardProblems } from './config.ts';
import { startServers } from './dashboard/server.ts';
import { runVerification } from './verify.ts';

const app = buildApp();
const { config, engine, logger, repo, tiktok } = app;

const dashProblems = dashboardProblems(config);
if (dashProblems.length) {
  console.log('\nSetup needed before the dashboard can start:\n');
  for (const p of dashProblems) console.log('  • ' + p);
  console.log(`\n(If you need one: SESSION_SECRET=${crypto.randomBytes(32).toString('hex')})\n`);
  // Don't crash-loop: serve a plain setup page (no data, no controls) until the settings are fixed.
  const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  http
    .createServer((req, res) => {
      if (req.url === '/healthz') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;background:#0d1117;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:520px;padding:24px"><h2>COLDEST Merge Engine: almost ready</h2><p>Fix this in your hosting settings (Railway → Variables), then wait for the restart:</p><ul>${dashProblems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul><p style="color:#8b949e">Nothing is running against TikTok or ShipHero until this is fixed.</p></div></body>`,
      );
    })
    .listen(config.dashboardPort, config.host);
} else {
  startApp();
}

function startApp() {

const problemsNow = () => connectionProblems(config, { tiktokToken: tiktok.hasStoredToken(), shopCipher: !!tiktok.shopCipher() });

startServers(
  {
    engine,
    password: config.dashboardPassword,
    sessionSecret: config.sessionSecret,
    webhookSecret: config.shiphero.webhookSecret,
    trustProxy: config.trustProxy,
    cookieSecure: config.cookieSecure,
    connections: () => checkConnections(app),
    unshipped: async () => (problemsNow().length ? null : (await tiktok.searchAwaitingShipment()).length),
    verify: () => runVerification(app),
    connectTikTok: async (code) => {
      const t = await tiktok.exchangeAuthCode(code);
      return { sellerName: t.sellerName, access_expires_at: t.access_expires_at };
    },
    setupInfo: () => ({
      tiktokAppKeySet: !!(config.tiktok.appKey && config.tiktok.appSecret),
      tiktokConnected: !!(config.tiktok.accessToken || config.tiktok.refreshToken || tiktok.hasStoredToken()),
      shopName: repo.getSetting<{ name: string } | null>('tiktok_shop', null)?.name ?? (config.tiktok.shopCipher ? 'set by TIKTOK_SHOP_CIPHER' : null),
      shipheroSet: !!(config.shiphero.refreshToken || config.shiphero.accessToken),
      webhookSecretSet: !!config.shiphero.webhookSecret,
      problems: problemsNow(),
    }),
  },
  { host: config.host, port: config.dashboardPort, singlePort: config.singlePort },
);

const where = config.host === '127.0.0.1' ? `http://localhost:${config.dashboardPort}` : `port ${config.dashboardPort} (open your Railway web address)`;
console.log(`
  COLDEST Order Merge Engine is running
  ─────────────────────────────────────
  Dashboard:  ${where}
  Mode:       ${engine.isDryRun() ? 'DRY RUN (nothing is changed in TikTok or ShipHero)' : 'LIVE'}${config.pilotMode ? ' + PILOT (approval before every change)' : ''}
  Tracking:   ${config.trackingMode === 'native_verify' ? 'ShipHero native integration sends it; this app verifies' : 'this app sends it'}
  Webhooks:   ${config.singlePort ? '/webhooks/shiphero/shipment-update on the same address' : `http://localhost:${config.dashboardPort + 1}/webhooks/shiphero/shipment-update (expose only this port)`}
`);

// Background loop. It runs only while setup is complete, and re-checks every pass,
// so connecting TikTok from the dashboard starts it without a restart.
let lastProblemNote = '';
const loop = async () => {
  const problems = problemsNow();
  if (problems.length) {
    const note = problems.join(' | ');
    if (note !== lastProblemNote) logger.warn('Background checks paused until setup is complete', { problems });
    lastProblemNote = note;
  } else {
    lastProblemNote = '';
    await engine.tick();
  }
  setTimeout(loop, config.pollIntervalSeconds * 1000).unref();
};
setTimeout(loop, 3000);

const shutdown = (sig: string) => {
  logger.info(`Shutting down (${sig})`);
  try {
    repo.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM')); // Railway sends SIGTERM on redeploy
}
