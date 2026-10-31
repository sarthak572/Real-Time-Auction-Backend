// Checks the nginx + two-instance setup. Needs: scripts/cluster.sh start   Run: npx tsx scripts/cluster-check.ts
import WebSocket from 'ws';
import { execSync } from 'node:child_process';

const LB = 'localhost:3000'; // nginx
const INSTANCES = ['localhost:3001', 'localhost:3002'];
let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = async (host: string, path: string, body?: unknown) => {
  const r = await fetch(`http://${host}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  return { status: r.status, instance: r.headers.get('x-instance'), rid: r.headers.get('x-request-id'), body: (await r.json()) as any };
};
const stats = async (host: string) => (await json(host, '/health/stats')).body;

// ---- 1. nginx spreads plain requests over both instances ----
const seen = new Map<string, number>();
for (let i = 0; i < 40; i++) {
  const r = await json(LB, '/health/live');
  seen.set(r.instance ?? '?', (seen.get(r.instance ?? '?') ?? 0) + 1);
}
check('requests through nginx are served by both instances', seen.size === 2, JSON.stringify(Object.fromEntries(seen)));

// ---- 2. request id: nginx generates it, the API uses and returns the same one ----
const r1 = await json(LB, '/health/live');
check('nginx request id reaches the API (32 hex chars)', /^[0-9a-f]{32}$/.test(r1.rid ?? ''), `(${r1.rid})`);

// ---- setup ----
const seller = Number((await json(LB, '/users', { name: 'cl-seller' })).body.id);
const bidder = Number((await json(LB, '/users', { name: 'cl-bidder' })).body.id);
const auction = Number((await json(LB, '/auctions', { sellerId: seller, title: 'cluster', startingPrice: 100, durationSeconds: 600 })).body.id);

// ---- 3. WebSockets through nginx land on both instances ----
type Conn = { ws: WebSocket; msgs: any[]; closed: boolean; code?: number };
const open = (host: string, query = ''): Promise<Conn> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}/auctions/${auction}/live${query}`);
    const c: Conn = { ws, msgs: [], closed: false };
    ws.on('message', (d) => c.msgs.push(JSON.parse(d.toString())));
    ws.on('close', (code) => { c.closed = true; c.code = code; });
    ws.on('open', () => resolve(c));
    ws.on('unexpected-response', (_q, res) => reject(new Error('http ' + res.statusCode)));
    ws.on('error', () => undefined);
  });
const viewers: Conn[] = [];
for (let i = 0; i < 30; i++) viewers.push(await open(LB));
await sleep(500);
const sockets = await Promise.all(INSTANCES.map(async (h) => (await stats(h)).realtime.activeSockets as number));
check('30 WebSockets through nginx are split across both instances', sockets.every((n) => n > 0) && sockets[0] + sockets[1] === 30, `(3001: ${sockets[0]}, 3002: ${sockets[1]})`);

// ---- 4. bids handled by either instance reach every viewer, in order ----
const handledBy = new Map<string, number>();
const BIDS = 40;
for (let i = 1; i <= BIDS; i++) {
  // Alternate the instance explicitly. Going through nginx would not guarantee that both instances take bids: with
  // least_conn, sequential requests on one keep-alive connection can all land on the same instance. (How nginx spreads
  // plain requests is checked above; here the question is whether a bid taken by EITHER instance reaches ALL viewers.)
  const r = await json(INSTANCES[i % 2], `/auctions/${auction}/bids`, { bidderId: bidder, amount: 100 + i });
  if (r.status !== 201) check('bid accepted', false, JSON.stringify(r.body));
  handledBy.set(r.instance ?? '?', (handledBy.get(r.instance ?? '?') ?? 0) + 1);
}
await sleep(800);
const complete = viewers.filter((v) => v.msgs.filter((m) => m.type === 'bid').map((m) => m.seq).join() === Array.from({ length: BIDS }, (_, k) => k + 1).join()).length;
check(`${BIDS} bids, alternately taken by each instance`, handledBy.size === 2, JSON.stringify(Object.fromEntries(handledBy)));
check(`all 30 viewers got bids 1..${BIDS} in order, whichever instance they or the bid used`, complete === 30, `(${complete}/30)`);

// ---- 5. failover: kill one instance while bids are flowing ----
const killedBefore = viewers.filter((v) => v.closed).length;
const outcomes: Record<string, number> = {};
const statusOf = async (n: number) => {
  try {
    const r = await json(LB, `/auctions/${auction}/bids`, { bidderId: bidder, amount: 300 + n });
    return String(r.status);
  } catch {
    return 'client-error';
  }
};
let n = 0;
const sender = (async () => {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const s = await statusOf(n++);
    outcomes[s] = (outcomes[s] ?? 0) + 1;
    await sleep(15);
  }
})();
await sleep(1500);
execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3002 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`, { stdio: 'ignore' });
console.log('      (killed instance on :3002 during traffic)');
await sender;
const bad = Object.entries(outcomes).filter(([s]) => !['201', '409'].includes(s));
check('bids kept flowing through nginx after one instance died', (outcomes['201'] ?? 0) > 50, JSON.stringify(outcomes));
check('no bid failed with a server error or client error during failover', bad.length === 0, bad.length ? JSON.stringify(Object.fromEntries(bad)) : '');

// viewers on the dead instance lose their socket; they reconnect (through nginx, to the survivor) and catch up
await sleep(500);
const dropped = viewers.filter((v) => v.closed);
check('viewers connected to the dead instance were disconnected', dropped.length > killedBefore, `(${dropped.length} dropped)`);
const lastSeq = Math.max(...viewers.filter((v) => !v.closed).map((v) => Math.max(...v.msgs.filter((m) => m.type === 'bid').map((m) => m.seq))));
const rejoin = await open(LB, '?lastSeq=10');
await sleep(800);
const snap = rejoin.msgs.find((m) => m.type === 'snapshot');
const replayed = rejoin.msgs.filter((m) => m.replay).length;
check('a dropped viewer reconnects through nginx and catches up', !!snap && snap.seq === lastSeq, `(snapshot seq ${snap?.seq}, latest seen by survivors ${lastSeq}, replayed ${replayed})`);

// ---- 6. bring the instance back: nginx uses it again ----
execSync('bash scripts/cluster.sh start-api 3002', { stdio: 'ignore' });
await sleep(6000); // nginx marks a failed server unavailable for fail_timeout (5 s)
const after = new Map<string, number>();
for (let i = 0; i < 40; i++) {
  const r = await json(LB, '/health/live');
  after.set(r.instance ?? '?', (after.get(r.instance ?? '?') ?? 0) + 1);
}
// least_conn sends new requests to whichever instance has fewer open connections. The survivor still holds this test's
// WebSockets, so the restarted (idle) instance may get ALL of them for a while. The point is that it gets traffic at all.
check('restarted instance receives traffic again', after.has('api-3002'), JSON.stringify(Object.fromEntries(after)));

viewers.forEach((v) => v.ws.close());
rejoin.ws.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
