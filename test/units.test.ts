import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readConfig } from '../src/config.ts';
import { resolveProvider } from '../src/engine/carriers.ts';
import { signTikTokRequest } from '../src/tiktok/sign.ts';
import { parseCombinableSearch, parseOrders } from '../src/tiktok/types.ts';
import { SchemaMismatchError } from '../src/util/http.ts';
import { redact } from '../src/util/logger.ts';
import { parseShipmentUpdate, verifyShipHeroWebhook } from '../src/webhooks/shiphero.ts';
import { createCombinedHandler, createDashboardHandler, createWebhookHandler, checkSession, makeSession } from '../src/dashboard/server.ts';
import { runVerification } from '../src/verify.ts';
import { createHarness } from '../src/mocks/harness.ts';

test('safety defaults: DRY_RUN and PILOT_MODE are ON when not set; tracking defaults to native_verify', () => {
  const c = readConfig({});
  assert.equal(c.dryRun, true);
  assert.equal(c.pilotMode, true);
  assert.equal(c.trackingMode, 'native_verify');
  assert.deepEqual(c.blockedCarriers, ['USPS']);
  assert.equal(c.maxOrdersPerGroup, 20);
});

test('TikTok signature: matches the published algorithm, ignores sign/access_token, includes body', () => {
  const secret = 'secret123';
  const query = { app_key: 'abc', timestamp: '1700000000', shop_cipher: 'CIPH', access_token: 'SHOULD-BE-IGNORED', sign: 'old' };
  const body = '{"combinable_packages":[{"id":"1","order_ids":["2","3"]}]}';
  const expectedBase = `${secret}/fulfillment/202309/packages/combineapp_keyabcshop_cipherCIPHtimestamp1700000000${body}${secret}`;
  const expected = crypto.createHmac('sha256', secret).update(expectedBase).digest('hex');
  assert.equal(signTikTokRequest({ path: '/fulfillment/202309/packages/combine', query, body, appSecret: secret }), expected);
  // order of keys does not matter
  const shuffled = { timestamp: '1700000000', shop_cipher: 'CIPH', app_key: 'abc' };
  assert.equal(signTikTokRequest({ path: '/fulfillment/202309/packages/combine', query: shuffled, body, appSecret: secret }), expected);
  // multipart bodies are excluded
  assert.notEqual(signTikTokRequest({ path: '/x', query: shuffled, body, appSecret: secret, contentType: 'multipart/form-data' }), signTikTokRequest({ path: '/x', query: shuffled, body, appSecret: secret }));
});

test('strict parsers refuse to guess when documented fields are missing', () => {
  assert.throws(() => parseCombinableSearch({ combinable_packages: [{ package_id: '1', orders: [] }] }), SchemaMismatchError);
  assert.throws(() => parseOrders({ orders: [{ id: '1' }] }), SchemaMismatchError);
  assert.deepEqual(parseCombinableSearch({ combinable_packages: [{ id: 'P', order_ids: ['1', '2'] }], next_page_token: '' }), { packages: [{ packageId: 'P', orderIds: ['1', '2'] }], nextPageToken: null });
});

test('carrier → TikTok provider: only IDs from TikTok\'s list, ambiguity is an error', () => {
  const list = [{ id: '1', name: 'UPS' }, { id: '2', name: 'USPS' }, { id: '3', name: 'FedEx' }, { id: '4', name: 'FedEx SmartPost' }];
  assert.deepEqual(resolveProvider('ups', list), { ok: true, provider: { id: '1', name: 'UPS' } });
  assert.equal(resolveProvider('fedex', list).ok, true); // exact name wins
  assert.equal(resolveProvider('fedex_ground', list).ok, false); // two FedEx providers → ambiguous
  assert.equal(resolveProvider('Pigeon Post', list).ok, false);
  assert.equal(resolveProvider('ups', list, '999').ok, false); // override must exist in TikTok's list
});

test('ShipHero webhook parsing uses packages[] label data and keeps per-order line items', () => {
  const e = parseShipmentUpdate({ test: false, fulfillment: { shipment_id: 77, order_number: 'TT-1', partner_order_id: '1', order_uuid: 'U1', tracking_number: 'old', shipping_carrier: 'legacy', line_items: [{ id: 'a', sku: 'X', quantity: 2 }] }, packages: [{ shipping_label: { tracking_number: '1ZNEW', shipping_carrier: 'UPS', cost: '7.10' } }] });
  assert.equal(e.trackingNumber, '1ZNEW');
  assert.equal(e.carrier, 'UPS');
  assert.equal(e.labelCost, 7.1);
  assert.deepEqual(e.lineItems, [{ sku: 'X', quantity: 2, line_item_id: 'a' }]);
});

test('webhook authentication: HMAC header or URL token required', () => {
  const body = '{"a":1}';
  const secret = 's3cr3t-value';
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(verifyShipHeroWebhook(body, { 'x-shiphero-hmac-sha256': sig }, null, secret), true);
  assert.equal(verifyShipHeroWebhook(body, { 'x-shiphero-hmac-sha256': 'forged' }, null, secret), false);
  assert.equal(verifyShipHeroWebhook(body, {}, secret, secret), true);
  assert.equal(verifyShipHeroWebhook(body, {}, 'wrong', secret), false);
  assert.equal(verifyShipHeroWebhook(body, { 'x-shiphero-hmac-sha256': sig }, null, ''), false, 'no secret configured → reject');
});

test('logs never contain tokens or secrets', () => {
  const r = redact({ access_token: 'abcdefghijkl', nested: { app_secret: 'zzzz9999', ok: 'visible' } }) as Record<string, unknown>;
  assert.equal(r.access_token, '***ijkl');
  assert.deepEqual(r.nested, { app_secret: '***9999', ok: 'visible' });
});

test('session cookies: signed, expire, cannot be forged', () => {
  const s = makeSession('k'.repeat(40), 1000);
  assert.equal(checkSession('k'.repeat(40), `cme_session=${s}`, 2000), true);
  assert.equal(checkSession('k'.repeat(40), `cme_session=${s}`, 1000 + 13 * 3600_000), false);
  assert.equal(checkSession('x'.repeat(40), `cme_session=${s}`, 2000), false);
  assert.equal(checkSession('k'.repeat(40), `cme_session=${s.split('.')[0]}.AAAA`, 2000), false);
});

async function listen(handler: http.RequestListener) {
  const srv = http.createServer(handler).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { srv, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
}

test('dashboard: login required, CSRF header required, approve works end-to-end', async () => {
  const h = createHarness({ pilotMode: true, pilotOrderIds: ['Z1', 'Z2'], dryRun: true });
  h.seedOrder('Z1', 'zed', { X: 1 });
  h.seedOrder('Z2', 'zed', { X: 1 });
  await h.engine.tick();
  h.advance(6);
  await h.engine.tick();
  const g = h.repo.listGroups()[0];
  const { srv, base } = await listen(createDashboardHandler({ engine: h.engine, password: 'correct horse battery', sessionSecret: 's'.repeat(40), webhookSecret: 'w' }));
  try {
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    const bad = await fetch(`${base}/login`, { method: 'POST', body: 'password=nope', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    assert.equal(bad.headers.get('location'), '/?error=1');
    const ok = await fetch(`${base}/login`, { method: 'POST', body: 'password=correct+horse+battery', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    assert.match(ok.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax/);
    const status = await (await fetch(`${base}/api/status`, { headers: { cookie } })).json();
    assert.equal(status.dryRun, true);
    assert.equal(status.groups[0].state, 'AWAITING_APPROVAL');
    const noCsrf = await fetch(`${base}/api/groups/${g.id}/approve`, { method: 'POST', headers: { cookie }, body: JSON.stringify({ step: 'combine' }) });
    assert.equal(noCsrf.status, 403);
    const approve = await fetch(`${base}/api/groups/${g.id}/approve`, { method: 'POST', headers: { cookie, 'x-coldest-csrf': '1' }, body: JSON.stringify({ step: 'combine' }) });
    assert.equal(approve.status, 200);
    assert.equal(h.repo.getGroup(g.id)!.state, 'AWAITING_APPROVAL');
    assert.equal(h.repo.getGroup(g.id)!.pending_step, 'merge', 'combine simulated, now waiting for merge approval');
    const live = await fetch(`${base}/api/settings`, { method: 'POST', headers: { cookie, 'x-coldest-csrf': '1' }, body: JSON.stringify({ dryRun: false }) });
    assert.equal(live.status, 400, 'cannot go live from the dashboard while .env says DRY_RUN=true');
  } finally {
    srv.close();
  }
});

test('webhook port: only the shipment route, only when signed', async () => {
  const h = createHarness();
  const { srv, base } = await listen(createWebhookHandler({ engine: h.engine, webhookSecret: 'whsec_test_secret_123' }));
  try {
    const payload = JSON.stringify({ test: false, fulfillment: { shipment_id: 1, order_number: 'TT-X', line_items: [] }, packages: [] });
    assert.equal((await fetch(`${base}/api/status`)).status, 404, 'dashboard is NOT reachable on the webhook port');
    assert.equal((await fetch(`${base}/webhooks/shiphero/shipment-update`, { method: 'POST', body: payload })).status, 401);
    const sig = crypto.createHmac('sha256', 'whsec_test_secret_123').update(payload).digest('base64');
    const r = await fetch(`${base}/webhooks/shiphero/shipment-update`, { method: 'POST', body: payload, headers: { 'x-shiphero-hmac-sha256': sig } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { code: '200', Message: 'Success' });
    const r2 = await fetch(`${base}/webhooks/shiphero/shipment-update?token=whsec_test_secret_123`, { method: 'POST', body: payload });
    assert.equal(r2.status, 200);
    assert.equal(h.repo.countShipmentEvents().n, 1, 'second delivery deduplicated');
  } finally {
    srv.close();
  }
});

test('cloud (single-port) mode: health check + webhook work without login, dashboard still locked, cookie is Secure', async () => {
  const h = createHarness();
  const { srv, base } = await listen(createCombinedHandler({
    engine: h.engine, password: 'a-long-cloud-password-123', sessionSecret: 's'.repeat(40), webhookSecret: 'whsec_test_secret_123', trustProxy: true, cookieSecure: true,
  }));
  try {
    const hz = await fetch(`${base}/healthz`);
    assert.equal(hz.status, 200);
    assert.equal(await hz.text(), 'ok');
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    const payload = JSON.stringify({ test: false, fulfillment: { shipment_id: 9, order_number: 'TT-Y', line_items: [] }, packages: [] });
    assert.equal((await fetch(`${base}/webhooks/shiphero/shipment-update`, { method: 'POST', body: payload })).status, 401);
    assert.equal((await fetch(`${base}/webhooks/shiphero/shipment-update?token=whsec_test_secret_123`, { method: 'POST', body: payload })).status, 200);
    const ok = await fetch(`${base}/login`, { method: 'POST', body: 'password=a-long-cloud-password-123&next=/tiktok/callback?code=abc', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    assert.match(ok.headers.get('set-cookie')!, /; Secure/);
    assert.equal(ok.headers.get('location'), '/tiktok/callback?code=abc', 'returns to the page you came from');
    const evil = await fetch(`${base}/login`, { method: 'POST', body: 'password=a-long-cloud-password-123&next=//evil.example', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    assert.equal(evil.headers.get('location'), '/', 'no open redirect');
  } finally {
    srv.close();
  }
});

test('login lockout uses the real visitor IP behind the proxy', async () => {
  const h = createHarness();
  const { srv, base } = await listen(createDashboardHandler({ engine: h.engine, password: 'right-password-123456', sessionSecret: 's'.repeat(40), webhookSecret: 'w', trustProxy: true }));
  const attempt = (ip: string, pw: string) => fetch(`${base}/login`, { method: 'POST', body: `password=${pw}`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `${ip}, 10.0.0.1` }, redirect: 'manual' });
  try {
    for (let i = 0; i < 5; i++) await attempt('1.1.1.1', 'wrong');
    assert.equal((await attempt('1.1.1.1', 'right-password-123456')).status, 429, 'attacker IP locked out');
    assert.equal((await attempt('2.2.2.2', 'right-password-123456')).status, 302, 'other visitors unaffected');
  } finally {
    srv.close();
  }
});

test('dashboard: connect TikTok with a pasted URL, then run the read-only API check (no mutations)', async () => {
  const h = createHarness();
  h.seedOrder('AA1', 'amy', { X: 1 });
  h.seedOrder('AA2', 'amy', { X: 1 });
  const codes: string[] = [];
  const { srv, base } = await listen(createDashboardHandler({
    engine: h.engine, password: 'right-password-123456', sessionSecret: 's'.repeat(40), webhookSecret: 'w',
    connectTikTok: async (code) => { codes.push(code); const t = await h.tiktok.exchangeAuthCode(code); return { sellerName: t.sellerName, access_expires_at: t.access_expires_at }; },
    verify: () => runVerification({ config: h.config, repo: h.repo, tiktok: h.tiktok, shiphero: h.shiphero }),
  }));
  try {
    const login = await fetch(`${base}/login`, { method: 'POST', body: 'password=right-password-123456', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const post = (p: string, b: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { cookie, 'x-coldest-csrf': '1' }, body: JSON.stringify(b) });
    const c = await post('/api/tiktok/connect', { code: 'https://www.coldest.com/?app_key=x&code=ROW_abc123&locale=en' });
    assert.equal(c.status, 200);
    assert.deepEqual(codes, ['ROW_abc123'], 'code extracted from the pasted address');
    assert.equal((await c.json()).sellerName, 'COLDEST');
    assert.ok(h.repo.getToken('tiktok')?.access_token, 'token stored in the database (not in a file)');
    const v = await (await post('/api/verify', {})).json();
    assert.equal(v.combineApiAvailable, true);
    assert.equal(v.problems, 0, v.markdown);
    assert.equal(h.tt.mutations.length + h.sh.mutations.length, 0, 'API check never changes anything');
    const page = await fetch(`${base}/tiktok/callback?code=xyz`, { headers: { cookie } });
    assert.match(await page.text(), /Finish connecting/);
  } finally {
    srv.close();
  }
});

test('shop cipher saved by the API check is used when TIKTOK_SHOP_CIPHER is empty', async () => {
  const h = createHarness();
  (h.tiktok as unknown as { o: { shopCipher: string } }).o.shopCipher = '';
  h.repo.setSetting('tiktok_shop', { cipher: 'CIPHER-1', id: 'SHOP-1', name: 'COLDEST' });
  assert.equal(h.tiktok.shopCipher(), 'CIPHER-1');
  const r = await h.tiktok.searchCombinablePackages();
  assert.deepEqual(r.packages, []);
  assert.match(String(h.tt.calls.at(-1)!.path), /combinable_packages/);
});
