// Things the scenarios do OUTSIDE the API: pause/unpause containers, ask Prometheus for numbers.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const COMPOSE_FILE = process.env.LAB_COMPOSE_FILE ?? path.resolve(here, '..', '..', 'docker-compose.yml');

// Test hook: run a stub script instead of the real docker CLI.
const stub = process.env.LAB_DOCKER_STUB;

function docker(args) {
  const [cmd, argv] = stub ? [process.execPath, [stub, ...args]] : ['docker', args];
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { timeout: 30_000 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));
  });
}

// Services we may freeze. Fixed list: the UI can never ask for an arbitrary container.
export const FREEZABLE = ['postgres', 'redis-state'];
const frozen = new Set();

/** `docker compose pause` freezes the container's processes; its data and volumes are untouched. */
export async function freeze(service) {
  if (!FREEZABLE.includes(service)) throw new Error(`refusing to freeze "${service}"`);
  await docker(['compose', '-f', COMPOSE_FILE, 'pause', service]);
  frozen.add(service);
}

export async function unfreeze(service) {
  await docker(['compose', '-f', COMPOSE_FILE, 'unpause', service]);
  frozen.delete(service);
}

/** Always called when a run ends or the server exits, so a failed run can never leave a container frozen. */
export async function recoverAll() {
  const done = [];
  for (const s of FREEZABLE) {
    try {
      await docker(['compose', '-f', COMPOSE_FILE, 'unpause', s]);
      done.push(s);
    } catch {
      /* not paused, or not running: fine */
    }
  }
  frozen.clear();
  return done;
}

export const frozenServices = () => [...frozen];

// ---- Prometheus: the few numbers shown next to the controls (the full picture is in Grafana) ----
const W = '30s'; // Prometheus scrapes every 5 s here, so 30 s = 6 samples per window
export const LIVE_QUERIES = {
  requestsPerSec: `sum(rate(http_request_duration_seconds_count{route!="/metrics"}[${W}]))`,
  bidsAcceptedPerSec: `sum(rate(auction_bids_total{result="accepted"}[${W}]))`,
  bidP95Seconds: `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{route="/auctions/:id/bids"}[${W}])))`,
  serverErrorsPerSec: `sum(rate(http_request_duration_seconds_count{status=~"5.."}[${W}]))`,
  backlog: 'max(writebehind_stream_length)',
  flusherLagSeconds: 'max(flusher_lag_seconds)',
  eventLoopP99Seconds: 'max(nodejs_eventloop_lag_p99_seconds)',
};

export async function promQuery(promUrl, query) {
  const res = await fetch(`${promUrl}/api/v1/query?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(2500) });
  const body = await res.json();
  const v = body?.data?.result?.[0]?.value?.[1];
  const n = v === undefined ? null : Number(v);
  return Number.isFinite(n) ? n : null; // NaN (e.g. 0/0 when idle) shows as "no data"
}

export async function liveNumbers(promUrl) {
  const entries = await Promise.all(Object.entries(LIVE_QUERIES).map(async ([k, q]) => [k, await promQuery(promUrl, q).catch(() => null)]));
  return Object.fromEntries(entries);
}
