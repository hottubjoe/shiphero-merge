/**
 * Runs the fake TikTok + ShipHero servers on real HTTP ports so the whole app
 * (verify-api, dashboard, worker) can be exercised over the network without real credentials.
 * Usage: node --import tsx scripts/fake-servers.ts   (TikTok on :5701, ShipHero on :5702)
 */
import http from 'node:http';
import { FakeShipHero } from '../src/mocks/fakeShipHero.ts';
import { FakeTikTok } from '../src/mocks/fakeTikTok.ts';
import type { Transport } from '../src/util/http.ts';

const tt = new FakeTikTok({ appKey: 'FAKEKEY', appSecret: 'FAKESECRET', accessToken: 'FAKE-TT-TOKEN' });
const sh = new FakeShipHero('FAKE-SH-TOKEN');
const now = Math.floor(Date.now() / 1000);
for (const [id, buyer, skus] of [['576100000000000001', 'demo', ['COLD-SHAMPOO']], ['576100000000000002', 'demo', ['COLD-CONDITIONER']], ['576100000000000003', 'solo', ['COLD-DEO']]] as const) {
  tt.addOrder({ id, buyerKey: buyer, skus: [...skus], create_time: now - 900 });
  sh.addOrder(id, `${buyer}@example.com`, Object.fromEntries(skus.map((s) => [s, 1])));
}

function serve(port: number, transport: Transport) {
  http
    .createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      try {
        const r = await transport({ method: req.method as 'GET', url: `http://localhost:${port}${req.url}`, headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
        res.writeHead(r.status, { 'content-type': 'application/json' }).end(r.body);
      } catch {
        req.socket.destroy(); // simulate a network failure
      }
    })
    .listen(port, '127.0.0.1');
}
serve(5701, tt.transport);
serve(5702, sh.transport);
console.log('Fake TikTok on http://127.0.0.1:5701, fake ShipHero on http://127.0.0.1:5702');
