import client from 'prom-client';

/**
 * Prometheus metrics. Every process (each API instance, the flusher) has its own registry and exposes it
 * (the API on GET /metrics, the flusher on its own small HTTP port); Prometheus scrapes them all.
 *
 * Naming: *_total are counters (use rate()), *_seconds are durations in seconds, histograms give percentiles
 * with histogram_quantile(). Keep label values to a small fixed set: every distinct label combination is a
 * separate time series that costs memory in Prometheus.
 */
export const registry = new client.Registry();

// CPU, memory (rss, heap), GC, open handles and event-loop lag (nodejs_eventloop_lag_*) for free.
client.collectDefaultMetrics({ register: registry, eventLoopMonitoringPrecision: 10 });

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Time to answer an HTTP request, by route pattern (not the raw URL) and status code',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const bidsTotal = new client.Counter({
  name: 'auction_bids_total',
  help: 'Bids by outcome',
  labelNames: ['result'] as const, // accepted, too_low, auction_closed, self_bid, not_found, unavailable, replayed, key_conflict, error
  registers: [registry],
});

export const bidDecisionDuration = new client.Histogram({
  name: 'auction_bid_decision_seconds',
  help: 'Time the bid path spends deciding a bid (the Redis round trip, not the whole request)',
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

/** Mirror a counter that already lives elsewhere in the code: Prometheus adds the difference each time it scrapes. */
export function mirrorCounter(name: string, help: string, read: () => number) {
  let last = 0;
  return new client.Counter({
    name,
    help,
    registers: [registry],
    collect() {
      const now = read();
      if (now > last) this.inc(now - last);
      last = now;
    },
  });
}

export function gauge(name: string, help: string, read: () => number | Promise<number>) {
  return new client.Gauge({
    name,
    help,
    registers: [registry],
    async collect() {
      this.set(await read());
    },
  });
}

export function labelledGauge(name: string, help: string, label: string, read: () => Record<string, number>) {
  return new client.Gauge({
    name,
    help,
    labelNames: [label],
    registers: [registry],
    collect() {
      for (const [k, v] of Object.entries(read())) this.set({ [label]: k }, v);
    },
  });
}

export const bidResultOf = (code: string): string =>
  ({
    BID_TOO_LOW: 'too_low',
    AUCTION_CLOSED: 'auction_closed',
    SELF_BID: 'self_bid',
    AUCTION_NOT_FOUND: 'not_found',
    BID_STORE_UNAVAILABLE: 'unavailable',
    FLUSHER_BEHIND: 'unavailable',
    IDEMPOTENCY_KEY_REUSED: 'key_conflict',
  })[code] ?? 'error';
