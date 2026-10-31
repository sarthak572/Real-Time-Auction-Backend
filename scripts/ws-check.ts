// End-to-end check of Phase 4. Needs TWO instances running:
//   A on :3000 (defaults)
//   B on :3001 with WS_HEARTBEAT_MS=1000 WS_MAX_CONNECTIONS_PER_IP=20
// Run: npx tsx scripts/ws-check.ts
import WebSocket from 'ws';

const A = 'localhost:3000';
const B = 'localhost:3001';
let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = async (host: string, path: string, body: unknown) => {
  const r = await fetch(`http://${host}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

type Conn = { ws: WebSocket; msgs: any[]; closed: boolean; closeCode?: number };
function open(host: string, auctionId: number, query = '', opts: any = {}): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}/auctions/${auctionId}/live${query}`, opts);
    const c: Conn = { ws, msgs: [], closed: false };
    ws.on('message', (d) => c.msgs.push(JSON.parse(d.toString())));
    ws.on('close', (code) => { c.closed = true; c.closeCode = code; });
    ws.on('open', () => resolve(c));
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('http ' + res.statusCode), { status: res.statusCode })));
    ws.on('error', () => undefined);
  });
}
async function waitFor(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(25); }
  return fn();
}

const seller = (await post(A, '/users', { name: 'ws-seller' })).body.id;
const bidder = (await post(A, '/users', { name: 'ws-bidder' })).body.id;
const auction = Number((await post(A, '/auctions', { sellerId: Number(seller), title: 'ws', startingPrice: 100, durationSeconds: 600 })).body.id);

// 1. Unknown auction is refused with a normal HTTP 404 before upgrade
await open(B, 999999999).then(() => check('unknown auction rejected', false), (e) => check('unknown auction -> HTTP 404 on upgrade', e.status === 404, `(got ${e.status})`));

// 2. Snapshot on connect, then a bid placed on instance A reaches viewers on A AND B
const onB = await open(B, auction);
const onA = await open(A, auction);
await waitFor(() => onB.msgs.length > 0 && onA.msgs.length > 0);
check('snapshot received with seq 0', onB.msgs[0]?.type === 'snapshot' && onB.msgs[0].seq === 0 && onB.msgs[0].currentPrice === 100);

const lat: number[] = [];
for (let i = 1; i <= 5; i++) {
  const r = await post(A, `/auctions/${auction}/bids`, { bidderId: Number(bidder), amount: 100 + i * 10 });
  if (r.status !== 201) check('bid accepted', false, JSON.stringify(r.body));
}
await waitFor(() => onB.msgs.filter((m) => m.type === 'bid').length === 5 && onA.msgs.filter((m) => m.type === 'bid').length === 5);
const bidsB = onB.msgs.filter((m) => m.type === 'bid');
const bidsA = onA.msgs.filter((m) => m.type === 'bid');
for (const m of bidsB) lat.push(Date.now() - Date.parse(m.at));
check('instance B viewer got all 5 bids placed on instance A (via Redis pub/sub)', bidsB.length === 5, `latency ms: ${lat.join(',')}`);
check('instance A viewer got all 5 bids', bidsA.length === 5);
check('events arrive in seq order 1..5', bidsB.map((m) => m.seq).join() === '1,2,3,4,5');
check('amounts are correct', bidsB.map((m) => m.amount).join() === '110,120,130,140,150');

// 3. Reconnect with lastSeq=2: snapshot (seq 5) + replay of bids 3,4,5
const re = await open(B, auction, '?lastSeq=2');
await waitFor(() => re.msgs.filter((m) => m.replay).length === 3);
check('catch-up: snapshot is at seq 5', re.msgs[0]?.type === 'snapshot' && re.msgs[0].seq === 5 && re.msgs[0].currentPrice === 150);
check('catch-up: replays exactly the missed bids 3,4,5', re.msgs.filter((m) => m.replay).map((m) => m.seq).join() === '3,4,5');
const none = await open(B, auction, '?lastSeq=5');
await sleep(300);
check('no replay when client is up to date', none.msgs.filter((m) => m.replay).length === 0);

// 4. Application-level ping/pong and bad input
onB.ws.send(JSON.stringify({ type: 'ping' }));
onB.ws.send('not json');
await waitFor(() => onB.msgs.some((m) => m.type === 'pong') && onB.msgs.some((m) => m.type === 'error'));
check('app-level ping answered with pong', onB.msgs.some((m) => m.type === 'pong'));
check('malformed message answered with error (connection stays open)', onB.msgs.some((m) => m.code === 'BAD_MESSAGE') && !onB.closed);

// 5. Oversized message is refused (maxPayload) and the connection closed
const big = await open(B, auction);
big.ws.send('x'.repeat(5000));
await waitFor(() => big.closed);
check('oversized message closes connection (code 1009)', big.closed && big.closeCode === 1009, `(code ${big.closeCode})`);

// 6. Heartbeat: a client that never answers pings is terminated; a healthy one survives
const dead = await open(B, auction, '', { autoPong: false });
await sleep(4000);
check('dead client (no pongs) terminated by heartbeat', dead.closed);
check('healthy client survives heartbeats', !onB.closed && !onA.closed);

// 7. Disconnect cleanup
for (const c of [onA, onB, re, none, big, dead]) c.ws.close();
await sleep(500);
const stats = (await (await fetch(`http://${B}/health/stats`)).json()) as any;
check('server removed closed sockets', stats.realtime.activeSockets === 0, `(active ${stats.realtime.activeSockets})`);
check('heartbeat termination counted', stats.realtime.heartbeatTerminated >= 1, JSON.stringify({ received: stats.realtime.received, sent: stats.realtime.messagesSent }));

// 8. Per-IP connection limit on B (configured as 20)
const many: Conn[] = [];
for (let i = 0; i < 20; i++) many.push(await open(B, auction));
await open(B, auction).then(() => check('21st connection rejected', false), (e) => check('21st connection from same IP -> HTTP 429', e.status === 429, `(got ${e.status})`));
many.forEach((c) => c.ws.close());
await sleep(300);

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
