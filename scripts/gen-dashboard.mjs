// Generates grafana/dashboards/auction.json. Run: node scripts/gen-dashboard.mjs
// Panels are described in a few lines each so the dashboard is easy to extend; edit this file, not the JSON.
import { writeFileSync } from 'node:fs';

const ds = { type: 'prometheus', uid: 'prometheus' };
const BIDS = 'route="/auctions/:id/bids"';
let nextId = 1;

const targets = (list) => list.map((t, i) => ({ refId: String.fromCharCode(65 + i), expr: t[0], legendFormat: t[1] ?? '', datasource: ds }));

const stat = (title, x, w, expr, unit = 'short', thresholds) => ({
  id: nextId++, type: 'stat', title, datasource: ds, gridPos: { x, y: 0, w, h: 4 },
  fieldConfig: {
    defaults: {
      unit, decimals: unit === 'short' ? 0 : undefined, noValue: '-',
      thresholds: thresholds ?? { mode: 'absolute', steps: [{ color: 'text', value: null }] },
      color: { mode: 'thresholds' },
    }, overrides: [],
  },
  options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'value', graphMode: 'area', textMode: 'auto' },
  targets: targets([[expr]]),
});

const ts = (title, x, y, w, list, unit = 'short', opts = {}) => ({
  id: nextId++, type: 'timeseries', title, description: opts.description ?? '', datasource: ds, gridPos: { x, y, w, h: 8 },
  fieldConfig: {
    defaults: {
      unit, min: opts.min,
      custom: { lineWidth: 2, fillOpacity: opts.stack ? 35 : 8, stacking: { mode: opts.stack ? 'normal' : 'none', group: 'A' }, showPoints: 'never', spanNulls: true },
    }, overrides: [],
  },
  options: { legend: { displayMode: 'list', placement: 'bottom', showLegend: true }, tooltip: { mode: 'multi', sort: 'desc' } },
  targets: targets(list),
});

const bad = { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'red', value: 1 }] };
const warnAt = (n) => ({ mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'orange', value: n }] });

const panels = [
  // ---- row of headline numbers ----
  stat('Bids accepted / s', 0, 4, 'sum(rate(auction_bids_total{result="accepted"}[30s]))', 'ops'),
  stat('Bid p95 latency', 4, 4, `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{${BIDS}}[30s])))`, 's'),
  stat('Server errors / s (5xx)', 8, 4, 'sum(rate(http_request_duration_seconds_count{status=~"5.."}[30s])) or vector(0)', 'ops', bad),
  stat('Bids waiting to be saved', 12, 4, 'max(writebehind_stream_length)', 'short', warnAt(5000)),
  stat('Flusher lag', 16, 4, 'max(flusher_lag_seconds)', 's', warnAt(1)),
  stat('Open WebSockets', 20, 4, 'sum(ws_active_sockets)', 'short'),

  // ---- traffic and latency ----
  ts('Requests per second, by route', 0, 4, 12, [['sum by (route) (rate(http_request_duration_seconds_count[30s]))', '{{route}}']], 'reqps'),
  ts('Bid latency percentiles', 12, 4, 12, [
    [`histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket{${BIDS}}[30s])))`, 'p50'],
    [`histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{${BIDS}}[30s])))`, 'p95'],
    [`histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{${BIDS}}[30s])))`, 'p99'],
    ['histogram_quantile(0.95, sum by (le) (rate(auction_bid_decision_seconds_bucket[30s])))', 'p95 of the Redis decision only'],
  ], 's', { description: 'Whole request time for POST /auctions/:id/bids, and (last line) just the part spent deciding in Redis.' }),

  ts('Bid outcomes per second', 0, 12, 12, [['sum by (result) (rate(auction_bids_total[30s]))', '{{result}}']], 'ops', {
    stack: true,
    description: 'accepted, too_low and auction_closed are normal answers. replayed = a retry answered from its Idempotency-Key. unavailable and error are problems.',
  }),
  ts('Responses by status code', 12, 12, 12, [['sum by (status) (rate(http_request_duration_seconds_count[30s]))', '{{status}}']], 'reqps', { stack: true }),

  // ---- the Node processes ----
  ts('Event-loop lag p99', 0, 20, 8, [['nodejs_eventloop_lag_p99_seconds{job=~"api.*"}', '{{instance}}']], 's', {
    description: 'How late timers fire because the single JavaScript thread was busy. Rising lag means the process is CPU-bound.',
  }),
  ts('CPU used (1.0 = one core)', 8, 20, 8, [['rate(process_cpu_seconds_total[30s])', '{{job}} {{instance}}']], 'short', {
    description: 'A single Node process cannot use more than 1.0 for its JavaScript. Near 1.0 means that process is the limit.',
  }),
  ts('Memory (resident)', 16, 20, 8, [['process_resident_memory_bytes', '{{job}} {{instance}}'], ['nodejs_heap_size_used_bytes{job=~"api.*"}', 'heap {{instance}}']], 'bytes'),

  // ---- write-behind ----
  ts('Write-behind backlog and lag', 0, 28, 12, [
    ['max(writebehind_stream_length)', 'bids waiting in Redis'],
    ['max(flusher_lag_seconds) * 1000', 'flusher lag (ms)'],
  ], 'short', { description: 'Normal: backlog near zero, lag a few hundred ms. A backlog that only grows means the flusher is dead or too slow.' }),
  ts('Flusher throughput', 12, 28, 12, [
    ['sum(rate(flusher_bids_total[30s]))', 'bids saved / s'],
    ['sum(rate(flusher_bids_total[30s])) / sum(rate(flusher_batch_size_count[30s]))', 'average batch size'],
    ['histogram_quantile(0.95, sum by (le) (rate(flusher_flush_duration_seconds_bucket[30s]))) * 1000', 'p95 flush time (ms)'],
  ]),

  // ---- supporting systems ----
  ts('Postgres connection pool', 0, 36, 8, [['pg_pool_connections', '{{instance}} {{state}}']], 'short', {
    description: 'waiting > 0 means requests are queued for a database connection.',
  }),
  ts('Cache hit ratio', 8, 36, 8, [['sum(rate(cache_hits_total[1m])) / (sum(rate(cache_hits_total[1m])) + sum(rate(cache_misses_total[1m])))', 'hit ratio']], 'percentunit', { min: 0 }),
  ts('WebSockets', 16, 36, 8, [
    ['sum(ws_active_sockets)', 'open sockets'],
    ['sum(rate(ws_messages_sent_total[30s]))', 'messages sent / s'],
    ['sum(rate(ws_dropped_slow_clients_total[1m]))', 'slow clients dropped / s'],
  ]),

  // ---- health of the monitoring itself ----
  ts('State Redis memory (it never evicts: when full, bids fail)', 0, 44, 12, [
    ['state_redis_memory_bytes{kind="used"}', 'used ({{instance}})'],
    ['max(state_redis_memory_bytes{kind="max"})', 'limit'],
  ], 'bytes', { min: 0, description: 'Idempotency keys and unsaved bids live here. Keep used well below the limit.' }),
  ts('Targets up', 12, 44, 12, [['up', '{{job}} {{instance}}']], 'short', { min: 0, description: '1 = Prometheus can scrape it. 0 = it is down, or not running.' }),
];

const dashboard = {
  uid: 'auction',
  title: 'Auction backend',
  tags: ['auction'],
  timezone: 'browser',
  schemaVersion: 39,
  version: 1,
  refresh: '5s',
  time: { from: 'now-10m', to: 'now' },
  templating: { list: [] },
  annotations: { list: [] },
  panels,
};

writeFileSync(new URL('../grafana/dashboards/auction.json', import.meta.url), JSON.stringify(dashboard, null, 2));
console.log(`wrote grafana/dashboards/auction.json with ${panels.length} panels`);
