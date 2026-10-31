// Open-model load generator: requests start at a target rate whether or not earlier ones have finished.
// (A closed model, where each virtual user waits for its reply, slows down when the server slows down and
// hides overload. Same reasoning as the arrival-rate executors in k6.)
import { Agent, request } from 'undici';

export const MAX_RPS = 2000; // hard ceiling: your notes record a laptop freeze at 6,000 req/s offered
export const MAX_INFLIGHT = 800;

const BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const createAgent = () => new Agent({ connections: 256, keepAliveTimeout: 30_000, pipelining: 1 });

export class Stats {
  constructor() {
    this.sent = 0;
    this.done = 0;
    this.dropped = 0; // wanted to send, but too many requests were already waiting
    this.netErrors = 0; // connection refused, reset, timeout
    this.replayed = 0; // answers marked Idempotent-Replayed
    this.outcomes = new Map(); // "201", "409 BID_TOO_LOW", ...
    this.lat = new Array(BUCKETS_MS.length + 1).fill(0);
    this.ws = { opened: 0, refused: 0, messages: 0 };
  }

  record(outcome, ms, replayed) {
    this.done++;
    if (replayed) this.replayed++;
    const key = this.outcomes.size >= 25 && !this.outcomes.has(outcome) ? 'other' : outcome;
    this.outcomes.set(key, (this.outcomes.get(key) ?? 0) + 1);
    let i = BUCKETS_MS.findIndex((b) => ms <= b);
    if (i === -1) i = BUCKETS_MS.length;
    this.lat[i]++;
  }

  /** Upper bound of the bucket holding the p-th percentile (an estimate, like a Prometheus histogram). */
  percentile(p) {
    const total = this.lat.reduce((a, b) => a + b, 0);
    if (total === 0) return null;
    let seen = 0;
    for (let i = 0; i < this.lat.length; i++) {
      seen += this.lat[i];
      if (seen >= total * p) return i < BUCKETS_MS.length ? BUCKETS_MS[i] : BUCKETS_MS.at(-1) * 2;
    }
    return null;
  }

  snapshot() {
    return {
      sent: this.sent,
      done: this.done,
      dropped: this.dropped,
      netErrors: this.netErrors,
      replayed: this.replayed,
      p50Ms: this.percentile(0.5),
      p95Ms: this.percentile(0.95),
      p99Ms: this.percentile(0.99),
      outcomes: Object.fromEntries([...this.outcomes.entries()].sort((a, b) => b[1] - a[1])),
      ws: this.ws,
    };
  }
}

/** One request through the shared connection pool; every result goes into `stats`. */
export async function send(ctx, r) {
  const t0 = performance.now();
  try {
    const res = await request(ctx.target + r.path, {
      method: r.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...r.headers },
      body: r.body === undefined ? undefined : JSON.stringify(r.body),
      dispatcher: ctx.agent,
      headersTimeout: 8000,
      bodyTimeout: 8000,
    });
    const text = await res.body.text();
    let outcome = String(res.statusCode);
    if (res.statusCode >= 400) {
      try {
        outcome += ' ' + (JSON.parse(text).error ?? '');
      } catch {
        /* non-JSON error body */
      }
    }
    ctx.stats.record(outcome.trim(), performance.now() - t0, res.headers['idempotent-replayed'] === 'true');
  } catch {
    ctx.stats.netErrors++;
  }
}

/**
 * Run `profile(tSeconds) -> requests/sec` for `durationSec`, building each request with `makeRequest()`.
 * `events` are one-off actions fired at a given second (used by the failure scenarios).
 */
export async function drive(ctx, { durationSec, profile, makeRequest, events = [] }) {
  const start = performance.now();
  let last = start;
  let acc = 0;
  let inflight = 0;
  const pending = new Set();
  const fired = new Set();

  while (!ctx.signal.aborted) {
    const now = performance.now();
    const t = (now - start) / 1000;
    ctx.setProgress(t, durationSec);
    if (t >= durationSec) break;

    events.forEach((e, i) => {
      if (!fired.has(i) && t >= e.at) {
        fired.add(i);
        Promise.resolve(e.fn()).catch((err) => ctx.log(`event "${e.name}" failed: ${err.message}`));
      }
    });

    const rate = Math.min(Math.max(profile(t), 0), MAX_RPS);
    ctx.currentRate = rate;
    acc = Math.min(acc + (rate * (now - last)) / 1000, 500); // cap the catch-up burst after a stall
    last = now;
    while (acc >= 1) {
      acc -= 1;
      if (inflight >= MAX_INFLIGHT) {
        ctx.stats.dropped++;
        continue;
      }
      inflight++;
      ctx.stats.sent++;
      const p = send(ctx, makeRequest()).finally(() => {
        inflight--;
        pending.delete(p);
      });
      pending.add(p);
    }
    await sleep(10);
  }
  // Let requests already on the wire finish so the totals are complete.
  await Promise.race([Promise.allSettled([...pending]), sleep(10_000)]);
}

/** Linear ramp helper: piecewise-linear profile through [[t, rps], ...]. */
export function piecewise(points) {
  return (t) => {
    if (t <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      const [t1, r1] = points[i];
      const [t0, r0] = points[i - 1];
      if (t <= t1) return r0 + ((r1 - r0) * (t - t0)) / (t1 - t0 || 1);
    }
    return points.at(-1)[1];
  };
}
