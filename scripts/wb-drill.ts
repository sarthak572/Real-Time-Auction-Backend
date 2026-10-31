// Failure drill for write-behind bidding. Run: npx tsx scripts/wb-drill.ts
//
// Starts the API and the flusher as separate processes, sends continuous bids, and while traffic is flowing:
//   t=5s   hard-kills the flusher (SIGKILL), restarts it at t=8s
//   t=12s  hard-kills the state Redis container (docker kill), restarts it at t=15s
// Then checks the one promise that matters: every bid the API answered with 201 must be in Postgres, exactly once.
//
// What this does NOT simulate: power loss or losing the Docker VM. `docker kill` is SIGKILL of the Redis process;
// the operating system keeps what Redis already wrote, so a real power cut could lose up to ~1 s more (appendfsync everysec).
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import { pool } from '../src/db.js';

const REDIS_CONTAINER = 'auction_production-redis-state-1';
const API = 'http://localhost:3000';
const LOG_DIR = process.argv[2] ?? 'results/05-write-behind';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${m}`);

function start(name: string, file: string): ChildProcess {
  const out = openSync(`${LOG_DIR}/drill-${name}.log`, 'a');
  // `node --import tsx` runs as ONE process, so killing the child really kills it (no hidden grandchild).
  return spawn('node', ['--import', 'tsx', file], {
    env: { ...process.env, NODE_ENV: 'production', BID_IMPL: 'redis', PORT: '3000' },
    stdio: ['ignore', out, out],
  });
}

// The flusher counters live in Redis and accumulate across runs (and tests); start this drill from zero.
execSync(`docker exec ${REDIS_CONTAINER} redis-cli DEL flusher:stats`, { stdio: 'ignore' });

const api = start('api', 'src/server.ts');
let flusher = start('flusher', 'src/worker.ts');
await sleep(8000);

// --- setup: 20 auctions, 40 bidders, one seller ---
const seller = Number((await pool.query(`INSERT INTO users(name) VALUES('drill-seller') RETURNING id`)).rows[0].id);
const bidders = (await pool.query(`INSERT INTO users(name) SELECT 'drill-b' || g FROM generate_series(1,40) g RETURNING id`)).rows.map((r) => Number(r.id));
const auctions = (
  await pool.query(
    `INSERT INTO auctions(seller_id,title,starting_price,current_price,ends_at)
     SELECT $1,'drill',100,100, now() + interval '1 hour' FROM generate_series(1,20) RETURNING id`,
    [seller],
  )
).rows.map((r) => Number(r.id));

// --- traffic ---
const acked = new Map<string, { amount: number; bidder: number }>(); // "auction:seq" -> what the API promised
const counts: Record<string, number> = {};
const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
const next = new Map(auctions.map((a) => [a, 100]));
let running = true;

async function worker() {
  while (running) {
    const a = auctions[Math.floor(Math.random() * auctions.length)];
    const bidder = bidders[Math.floor(Math.random() * bidders.length)];
    const amount = (next.get(a) ?? 100) + 1;
    next.set(a, amount);
    try {
      const res = await fetch(`${API}/auctions/${a}/bids`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bidderId: bidder, amount }),
        signal: AbortSignal.timeout(5000),
      });
      bump(String(res.status));
      if (res.status === 201) {
        const b = (await res.json()) as { seq: string };
        acked.set(`${a}:${b.seq}`, { amount, bidder });
      } else await res.arrayBuffer();
    } catch {
      bump('network-error');
      await sleep(100);
    }
  }
}
const workers = Array.from({ length: 30 }, () => worker());

log('traffic started');
await sleep(5000);
log(`HARD-KILL flusher (SIGKILL). acked so far: ${acked.size}`);
flusher.kill('SIGKILL');
await sleep(3000);
log(`restart flusher. acked so far: ${acked.size}`);
flusher = start('flusher', 'src/worker.ts');
await sleep(4000);
log(`HARD-KILL state Redis (docker kill). acked so far: ${acked.size}`);
execSync(`docker kill ${REDIS_CONTAINER}`, { stdio: 'ignore' });
await sleep(3000);
log('restart state Redis');
execSync(`docker start ${REDIS_CONTAINER}`, { stdio: 'ignore' });
await sleep(5000);
running = false;
await Promise.all(workers);
log(`traffic stopped. acked: ${acked.size}  responses: ${JSON.stringify(counts)}`);

// --- let the flusher catch up ---
let backlog = -1;
for (let i = 0; i < 60; i++) {
  const s = (await (await fetch(`${API}/health/stats`)).json()) as { writeBehind?: { streamLength?: number } };
  backlog = s.writeBehind?.streamLength ?? -1;
  if (backlog === 0) break;
  await sleep(500);
}
log(`stream backlog after wait: ${backlog}`);

// --- verify ---
const { rows } = await pool.query(
  `SELECT auction_id, seq, amount, bidder_id FROM bids WHERE auction_id = ANY($1::bigint[])`,
  [auctions],
);
const inPg = new Map<string, { amount: number; bidder: number }>();
let duplicates = 0;
for (const r of rows) {
  const k = `${r.auction_id}:${r.seq}`;
  if (inPg.has(k)) duplicates++;
  inPg.set(k, { amount: Number(r.amount), bidder: Number(r.bidder_id) });
}
let missing = 0, mismatched = 0;
for (const [k, v] of acked) {
  const p = inPg.get(k);
  if (!p) missing++;
  else if (p.amount !== v.amount || p.bidder !== v.bidder) mismatched++;
}
const savedNotAcked = [...inPg.keys()].filter((k) => !acked.has(k)).length;

let gaps = 0, countWrong = 0;
for (const a of auctions) {
  const seqs = rows.filter((r) => Number(r.auction_id) === a).map((r) => Number(r.seq)).sort((x, y) => x - y);
  for (let i = 0; i < seqs.length; i++) if (seqs[i] !== i + 1) { gaps++; break; }
  const au = (await pool.query('SELECT bid_count FROM auctions WHERE id=$1', [a])).rows[0];
  if (Number(au.bid_count) !== (seqs[seqs.length - 1] ?? 0)) countWrong++;
}
const stats = (await (await fetch(`${API}/health/stats`)).json()) as { writeBehind?: Record<string, unknown> };

console.log('\n=== DRILL RESULT ===');
console.log(`acknowledged bids (HTTP 201):            ${acked.size}`);
console.log(`saved in Postgres:                       ${rows.length}`);
console.log(`acknowledged but MISSING from Postgres:  ${missing}`);
console.log(`acknowledged but different content:      ${mismatched}`);
console.log(`duplicate (auction, seq) rows:           ${duplicates}`);
console.log(`saved but never acknowledged:            ${savedNotAcked}  (e.g. Redis killed after applying, before replying: allowed)`);
console.log(`auctions with a gap in seq:              ${gaps}`);
console.log(`auctions where bid_count != max seq:     ${countWrong}`);
console.log(`flusher conflict counter:                ${JSON.stringify(stats.writeBehind)}`);
console.log(missing === 0 && mismatched === 0 && duplicates === 0 && gaps === 0 && countWrong === 0 ? '\nPASS: no acknowledged bid was lost or duplicated' : '\nFAIL: see counts above');

flusher.kill('SIGTERM');
api.kill('SIGTERM');
await sleep(1500);
await pool.end();
process.exit(0);
