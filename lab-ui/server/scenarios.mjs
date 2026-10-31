// Every button in the UI is one entry here. A scenario creates its own test data through the public API
// (users and auctions named "lab-..."), then drives traffic at the target. It never touches the database directly.
import { request } from 'undici';
import WebSocket from 'ws';
import { drive, piecewise } from './loadgen.mjs';
import { freeze, unfreeze } from './infra.mjs';

// Test hook only: LAB_TEST_FAST shrinks the fixed timelines (and the minimum duration) so tests finish in seconds.
export const TIME_SCALE = process.env.LAB_TEST_FAST ? 0.2 : 1;
const S = TIME_SCALE;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------- test data ----------
async function call(ctx, method, path, body) {
  const res = await request(ctx.target + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    dispatcher: ctx.agent,
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });
  const text = await res.body.text();
  if (res.statusCode >= 300) throw new Error(`${method} ${path} -> ${res.statusCode} ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

/** 1 seller, N bidders, M auctions (open for an hour). Bid amounts start at 101 and rise per auction. */
async function setup(ctx, { auctions, bidders }) {
  ctx.setPhase(`creating test data (${bidders} bidders, ${auctions} auctions)`);
  const stamp = Date.now().toString(36);
  const seller = await call(ctx, 'POST', '/users', { name: `lab-seller-${stamp}` });
  const bidderIds = [];
  for (let i = 0; i < bidders; i += 10) {
    const chunk = await Promise.all(
      Array.from({ length: Math.min(10, bidders - i) }, (_, j) => call(ctx, 'POST', '/users', { name: `lab-bidder-${stamp}-${i + j}` })),
    );
    bidderIds.push(...chunk.map((u) => Number(u.id)));
    if (ctx.signal.aborted) throw new Error('stopped during setup');
  }
  const auctionIds = [];
  for (let i = 0; i < auctions; i += 10) {
    const chunk = await Promise.all(
      Array.from({ length: Math.min(10, auctions - i) }, (_, j) =>
        call(ctx, 'POST', '/auctions', { sellerId: Number(seller.id), title: `lab-auction-${stamp}-${i + j}`, startingPrice: 100, durationSeconds: 3600 }),
      ),
    );
    auctionIds.push(...chunk.map((a) => Number(a.id)));
  }
  const next = new Map(auctionIds.map((id) => [id, 101]));
  ctx.log(`test data ready: seller ${seller.id}, auctions ${auctionIds[0]}..${auctionIds.at(-1)}`);
  return { bidders: bidderIds, auctions: auctionIds, next };
}

function bidRequest(fx, auctionId) {
  const amount = fx.next.get(auctionId);
  fx.next.set(auctionId, amount + 1);
  return { method: 'POST', path: `/auctions/${auctionId}/bids`, body: { bidderId: pick(fx.bidders), amount } };
}
const readRequest = (fx) => ({ path: `/auctions/${pick(fx.auctions)}` });

// ---------- helpers for the common shapes ----------
async function runMix(ctx, { auctions, bidders = 50, bidShare, profile, events }) {
  const fx = await setup(ctx, { auctions, bidders });
  ctx.setPhase('running');
  await drive(ctx, {
    durationSec: ctx.params.durationSec,
    profile: profile(ctx.params),
    events: events?.(ctx) ?? [],
    makeRequest: () => (Math.random() < bidShare ? bidRequest(fx, pick(fx.auctions)) : readRequest(fx)),
  });
}

const durationParam = (def, max = 180) => ({ key: 'durationSec', label: 'Duration (s)', min: process.env.LAB_TEST_FAST ? 3 : 20, max, def });
const rpsParam = (def, max = 1500) => ({ key: 'rps', label: 'Requests/s', min: 10, max, def });

// ---------- the scenarios ----------
export const SCENARIOS = [
  {
    id: 'steady',
    group: 'load',
    name: 'Steady traffic',
    description: 'A calm baseline: 80% bids and 20% reads spread over 20 auctions. Run this first so you know what "normal" looks like.',
    params: [durationParam(60), rpsParam(150)],
    watch: ['Bids accepted / s', 'Bid p95 latency', 'Requests per second, by route', 'Bids waiting to be saved', 'Cache hit ratio'],
    expect: 'Flat lines. Backlog stays near zero and flusher lag stays small. Note these numbers; every other scenario is compared with them.',
    run: (ctx) => runMix(ctx, { auctions: 20, bidShare: 0.8, profile: (p) => () => p.rps }),
  },
  {
    id: 'hot',
    group: 'load',
    name: 'Hot auction',
    description: 'Every bid goes to ONE auction, as in the last seconds of a popular auction. Many bids arrive at the same price and lose.',
    params: [durationParam(45), rpsParam(600)],
    watch: ['Bid outcomes per second', 'Bid latency percentiles', 'Flusher throughput', 'Event-loop lag p99', 'CPU used (1.0 = one core)'],
    expect: 'Most bids refused as too_low (only one can win each price). The Redis script decides without a lock, so latency should stay low; the flusher writes in batches.',
    run: (ctx) => runMix(ctx, { auctions: 1, bidShare: 1, profile: (p) => () => p.rps }),
  },
  {
    id: 'spike',
    group: 'load',
    name: 'Traffic spike',
    description: 'Calm at 50 req/s, jump to the peak for 15 s, then drop back. Watch how long it takes to recover.',
    params: [rpsParam(1000, 2000)],
    fixedDuration: 45,
    watch: ['Requests per second, by route', 'Bid latency percentiles', 'Bids waiting to be saved', 'Flusher lag', 'Event-loop lag p99'],
    expect: 'Backlog and flusher lag rise during the peak, then drain back to ~0 after it. The question is how long that takes.',
    run: (ctx) =>
      runMix(ctx, { auctions: 20, bidShare: 0.8, profile: (p) => piecewise([[0, 50], [10 * S, 50], [11 * S, p.rps], [26 * S, p.rps], [27 * S, 50], [45 * S, 50]]) }),
  },
  {
    id: 'ramp',
    group: 'load',
    name: 'Ramp to saturation',
    description: 'Rate climbs steadily until something gives. Finds the ceiling. Heavy: close other programs first, this can slow your computer.',
    params: [durationParam(90), rpsParam(1200, 2000)],
    watch: ['Bid p95 latency', 'Event-loop lag p99', 'CPU used (1.0 = one core)', 'Postgres connection pool', 'Server errors / s (5xx)'],
    expect: 'Throughput climbs with the rate, then flattens while latency and event-loop lag jump: that point is the ceiling. Expect queueing before errors.',
    run: (ctx) => runMix(ctx, { auctions: 20, bidShare: 0.8, profile: (p) => piecewise([[0, 50], [p.durationSec, p.rps]]) }),
  },
  {
    id: 'reads',
    group: 'load',
    name: 'Read-heavy (cache)',
    description: 'Only reads of auction pages. Shows the Redis cache protecting Postgres.',
    params: [durationParam(45), rpsParam(800)],
    watch: ['Cache hit ratio', 'Postgres connection pool', 'Requests per second, by route', 'Bid p95 latency'],
    expect: 'Hit ratio near 100% after the first seconds; pool waiting stays 0.',
    run: (ctx) => runMix(ctx, { auctions: 20, bidShare: 0, profile: (p) => () => p.rps }),
  },
  {
    id: 'retry',
    group: 'load',
    name: 'Retry storm (idempotency)',
    description: 'Bids carry an Idempotency-Key and 30% are exact repeats, like clients retrying after a timeout. No repeat may create a second bid.',
    params: [durationParam(45), rpsParam(200)],
    watch: ['Bid outcomes per second', 'Bids accepted / s', 'State Redis memory (it never evicts: when full, bids fail)'],
    expect: 'A "replayed" outcome appears next to "accepted". Accepted stays at the rate of NEW bids, not total requests.',
    run: async (ctx) => {
      const fx = await setup(ctx, { auctions: 20, bidders: 50 });
      const history = [];
      const stamp = Date.now().toString(36);
      let n = 0;
      ctx.setPhase('running');
      await drive(ctx, {
        durationSec: ctx.params.durationSec,
        profile: () => ctx.params.rps,
        makeRequest: () => {
          if (history.length > 20 && Math.random() < 0.3) return pick(history); // exact repeat: same key, same body
          const r = bidRequest(fx, pick(fx.auctions));
          r.headers = { 'idempotency-key': `lab-${stamp}-${n++}` };
          if (history.length < 500) history.push(r);
          else history[Math.floor(Math.random() * 500)] = r;
          return r;
        },
      });
    },
  },
  {
    id: 'viewers',
    group: 'load',
    name: 'Live viewers (WebSockets)',
    description: 'Opens WebSocket viewers on one auction while bids arrive at 100 req/s. The server limits each address (default 50), so extra connections are refused.',
    params: [durationParam(45), { key: 'sockets', label: 'Viewers', min: 1, max: 500, def: 40 }],
    watch: ['Open WebSockets', 'WebSockets', 'Bid latency percentiles', 'Event-loop lag p99'],
    expect: 'Open WebSockets rises by the number accepted. Every bid is pushed to every viewer, so messages grow with viewers x bids.',
    run: async (ctx) => {
      const fx = await setup(ctx, { auctions: 1, bidders: 30 });
      const auctionId = fx.auctions[0];
      const wsBase = ctx.target.replace(/^http/, 'ws');
      const sockets = [];
      ctx.setPhase(`opening ${ctx.params.sockets} viewers`);
      for (let i = 0; i < ctx.params.sockets; i++) {
        const ws = new WebSocket(`${wsBase}/auctions/${auctionId}/live`);
        let counted = false;
        ws.on('open', () => ((counted = true), ctx.stats.ws.opened++));
        ws.on('message', () => ctx.stats.ws.messages++);
        ws.on('unexpected-response', () => !counted && ((counted = true), ctx.stats.ws.refused++));
        ws.on('error', () => !counted && ((counted = true), ctx.stats.ws.refused++));
        sockets.push(ws);
        if (i % 20 === 19) await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 1500));
      ctx.log(`viewers connected: ${ctx.stats.ws.opened}, refused: ${ctx.stats.ws.refused}`);
      try {
        ctx.setPhase('running');
        await drive(ctx, { durationSec: ctx.params.durationSec, profile: () => 100, makeRequest: () => bidRequest(fx, auctionId) });
      } finally {
        for (const ws of sockets) ws.terminate();
      }
    },
  },
  {
    id: 'postgres-freeze',
    group: 'failure',
    name: 'Postgres outage (20 s)',
    description: 'Steady bidding for 60 s. At 10 s the Postgres container is FROZEN (docker pause, data untouched); at 30 s it is resumed. Tests the write-behind design.',
    params: [rpsParam(150, 500)],
    fixedDuration: 60,
    watch: ['Bids waiting to be saved', 'Flusher lag', 'Write-behind backlog and lag', 'Bids accepted / s', 'Postgres connection pool'],
    expect: 'Bids keep being accepted while Postgres is frozen. Backlog and flusher lag climb for 20 s, then drain after the resume. Reads that miss the cache may fail or stall.',
    run: (ctx) =>
      runMix(ctx, {
        auctions: 20,
        bidShare: 0.8,
        profile: (p) => () => p.rps,
        events: (c) => [
          { at: 10 * S, name: 'freeze postgres', fn: async () => (c.log('FROZE postgres'), freeze('postgres')) },
          { at: 30 * S, name: 'resume postgres', fn: async () => (c.log('RESUMED postgres'), unfreeze('postgres')) },
        ],
      }),
  },
  {
    id: 'redis-freeze',
    group: 'failure',
    name: 'State Redis outage (10 s)',
    description: 'Bidding for 45 s. At 10 s the state Redis (the live authority for bids) is FROZEN; at 20 s it is resumed. Bids must never be written elsewhere.',
    params: [rpsParam(100, 300)],
    fixedDuration: 45,
    watch: ['Bid outcomes per second', 'Server errors / s (5xx)', 'Bid p95 latency', 'Bids waiting to be saved'],
    expect: 'Bids fail or stall while it is frozen (a frozen process may hang rather than refuse, so look at latency as well as errors), then recover. No bid should be accepted without being recorded.',
    run: (ctx) =>
      runMix(ctx, {
        auctions: 20,
        bidShare: 0.9,
        profile: (p) => () => p.rps,
        events: (c) => [
          { at: 10 * S, name: 'freeze state redis', fn: async () => (c.log('FROZE redis-state'), freeze('redis-state')) },
          { at: 20 * S, name: 'resume state redis', fn: async () => (c.log('RESUMED redis-state'), unfreeze('redis-state')) },
        ],
      }),
  },
];
