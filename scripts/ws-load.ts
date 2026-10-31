// WebSocket load test: opens many sockets, then places bids and measures delivery.
// Usage: npx tsx scripts/ws-load.ts <sockets> <auctions> <bidsPerSecond> <seconds> [port]
// Latency = (time the client receives the event) - (time the client started the POST). Same clock, so no skew,
// but it includes this script's own CPU use, so treat it as an upper bound.
import WebSocket from 'ws';

const [N, M, RATE, SECONDS, PORT] = [Number(process.argv[2] ?? 1000), Number(process.argv[3] ?? 10), Number(process.argv[4] ?? 20), Number(process.argv[5] ?? 20), process.argv[6] ?? '3000'];
const HOST = `localhost:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = async (path: string, body: unknown) => {
  const r = await fetch(`http://${HOST}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const stats = async () => (await (await fetch(`http://${HOST}/health/stats`)).json()) as any;

const seller = Number((await post('/users', { name: 'load-seller' })).body.id);
const bidder = Number((await post('/users', { name: 'load-bidder' })).body.id);
const auctions: number[] = [];
for (let i = 0; i < M; i++) auctions.push(Number((await post('/auctions', { sellerId: seller, title: 'ws-load', startingPrice: 100, durationSeconds: 3600 })).body.id));

const sendTime = new Map<string, number>(); // "auction:amount" -> performance.now() when POST started
const latencies: number[] = [];
const viewers = new Map<number, number>();
let delivered = 0, connectErrors = 0, unexpectedCloses = 0;

function connect(auctionId: number): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${HOST}/auctions/${auctionId}/live`);
    ws.on('open', () => { viewers.set(auctionId, (viewers.get(auctionId) ?? 0) + 1); resolve(); });
    ws.on('message', (d) => {
      const now = performance.now();
      const m = JSON.parse(d.toString());
      if (m.type !== 'bid') return;
      delivered++;
      const t = sendTime.get(`${m.auctionId}:${m.amount}`);
      if (t !== undefined) latencies.push(now - t);
    });
    ws.on('close', () => { unexpectedCloses++; });
    ws.on('error', () => { connectErrors++; resolve(); });
  });
}

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1) : NaN; };
const base = await stats();
console.log(`baseline: rss=${base.rssMb}MB heap=${base.heapUsedMb}MB`);

// Phase 1: open sockets in steps and watch server memory.
const steps = [0.2, 0.5, 1].map((f) => Math.round(N * f));
let opened = 0;
for (const target of steps) {
  while (opened < target) {
    const batch = Math.min(200, target - opened);
    await Promise.all(Array.from({ length: batch }, (_, i) => connect(auctions[(opened + i) % M])));
    opened += batch;
  }
  await sleep(1500);
  const s = await stats();
  console.log(`sockets=${s.realtime.activeSockets} rss=${s.rssMb}MB heap=${s.heapUsedMb}MB  (~${((s.rssMb - base.rssMb) * 1024 / Math.max(1, s.realtime.activeSockets)).toFixed(1)} KB/socket) loopLagP99=${s.eventLoopLagP99Ms}ms`);
}

// Phase 2: bids at RATE/s, spread across auctions, one in-flight bid per auction so amounts stay ordered.
console.log(`bidding: ${RATE}/s for ${SECONDS}s over ${M} auction(s), ~${Math.round(N / M)} viewers each`);
const next = new Map(auctions.map((a) => [a, 100]));
const busy = new Set<number>();
let accepted = 0, rejected = 0, expected = 0, errors = 0, tick = 0;
const bidMs: number[] = [];
const end = Date.now() + SECONDS * 1000;
const timer = setInterval(async () => {
  if (Date.now() > end) return;
  const a = auctions[tick++ % M];
  if (busy.has(a)) return; // previous bid on this auction still running
  busy.add(a);
  const amount = next.get(a)! + 1;
  next.set(a, amount);
  sendTime.set(`${a}:${amount}`, performance.now());
  const t0 = performance.now();
  try {
    const r = await post(`/auctions/${a}/bids`, { bidderId: bidder, amount });
    bidMs.push(performance.now() - t0);
    if (r.status === 201) { accepted++; expected += viewers.get(a) ?? 0; } else rejected++;
  } catch { errors++; } finally { busy.delete(a); }
}, 1000 / RATE);
await sleep(SECONDS * 1000 + 3000); // +3s to let deliveries finish
clearInterval(timer);

const s = await stats();
console.log('\n=== RESULT ===');
console.log(`bids: accepted=${accepted} rejected=${rejected} errors=${errors}  bid POST p50=${pct(bidMs, 0.5)}ms p95=${pct(bidMs, 0.95)}ms`);
console.log(`deliveries: ${delivered} of ${expected} expected (${((delivered / Math.max(1, expected)) * 100).toFixed(2)}%)  throughput ~${Math.round(delivered / SECONDS)}/s`);
console.log(`delivery latency ms: p50=${pct(latencies, 0.5)} p95=${pct(latencies, 0.95)} p99=${pct(latencies, 0.99)} max=${pct(latencies, 1)}`);
console.log(`server: rss=${s.rssMb}MB heap=${s.heapUsedMb}MB loopLagP99=${s.eventLoopLagP99Ms}ms maxLag=${s.eventLoopLagMaxMs}ms pool.waiting=${s.pool.waiting}`);
console.log(`realtime: ${JSON.stringify({ sockets: s.realtime.activeSockets, sent: s.realtime.messagesSent, published: s.realtime.published, droppedSlow: s.realtime.droppedSlowClients, heartbeatKilled: s.realtime.heartbeatTerminated, bufferedBytes: s.realtime.bufferedBytes })}`);
console.log(`client: connectErrors=${connectErrors} unexpectedCloses=${unexpectedCloses}`);
process.exit(0);
