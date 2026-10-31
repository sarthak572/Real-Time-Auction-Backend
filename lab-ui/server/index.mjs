// Control server for the scenario UI. It can generate load and freeze containers, so it is locked down:
//  - listens on 127.0.0.1 only; refuses requests whose Host is not localhost (DNS-rebinding protection)
//  - POST requests must come from this page's own origin (no other website can press the buttons)
//  - only targets localhost unless LAB_ALLOW_REMOTE=1; only two fixed containers can be frozen
//  - one run at a time, hard caps on rate and duration, and containers are always unfrozen when a run ends
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Stats, createAgent, MAX_RPS } from './loadgen.mjs';
import { SCENARIOS, TIME_SCALE } from './scenarios.mjs';
import { recoverAll, frozenServices, liveNumbers } from './infra.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const PORT = Number(process.env.PORT ?? 4000);
const TARGET = (process.env.LAB_TARGET ?? 'http://localhost:3000').replace(/\/$/, '');
const PROM = (process.env.LAB_PROMETHEUS ?? 'http://localhost:9090').replace(/\/$/, '');
const GRAFANA = (process.env.LAB_GRAFANA ?? 'http://localhost:3030').replace(/\/$/, '');
const DASH_UID = process.env.LAB_DASHBOARD_UID ?? 'auction';
const MAX_DURATION = 300;

const isLocal = (h) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h);
if (!isLocal(new URL(TARGET).hostname) && process.env.LAB_ALLOW_REMOTE !== '1') {
  console.error(`Refusing to start: LAB_TARGET (${TARGET}) is not localhost. This tool generates heavy load; set LAB_ALLOW_REMOTE=1 only if you own the target.`);
  process.exit(1);
}
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, 'http://localhost:5173', 'http://127.0.0.1:5173']);

// ---------- run manager ----------
let run = null;
let nextId = 1;

const clamp = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : def;
};

function resolveParams(scenario, raw = {}) {
  const params = {};
  for (const p of scenario.params) params[p.key] = clamp(raw[p.key], p.min, p.max, p.def);
  if (scenario.fixedDuration) params.durationSec = Math.round(scenario.fixedDuration * TIME_SCALE);
  if (params.rps) params.rps = Math.min(params.rps, MAX_RPS);
  params.durationSec = Math.min(params.durationSec ?? 60, MAX_DURATION);
  return params;
}

function startRun(scenario, rawParams) {
  const params = resolveParams(scenario, rawParams);
  const abort = new AbortController();
  const stats = new Stats();
  const r = {
    id: nextId++,
    scenarioId: scenario.id,
    name: scenario.name,
    group: scenario.group,
    params,
    state: 'setup',
    phase: 'starting',
    startedAt: Date.now(),
    endedAt: null,
    elapsedSec: 0,
    durationSec: params.durationSec,
    rate: 0,
    error: null,
    log: [],
    stats,
    abort: () => abort.abort(),
  };
  const log = (msg) => {
    r.log.push({ t: Date.now(), msg });
    if (r.log.length > 200) r.log.shift();
  };
  const ctx = {
    target: TARGET,
    agent: createAgent(),
    stats,
    signal: abort.signal,
    params,
    log,
    currentRate: 0,
    setPhase: (p) => {
      r.phase = p;
      r.state = p === 'running' ? 'running' : 'setup';
      log(p);
    },
    setProgress: (t, d) => {
      r.elapsedSec = Math.min(t, d);
      r.rate = ctx.currentRate;
    },
  };
  run = r;
  log(`starting "${scenario.name}" against ${TARGET}`);

  (async () => {
    try {
      await scenario.run(ctx);
      r.state = abort.signal.aborted ? 'stopped' : 'done';
    } catch (err) {
      r.state = abort.signal.aborted ? 'stopped' : 'error';
      r.error = err.message;
      log(`error: ${err.message}`);
    } finally {
      if (scenario.group === 'failure') {
        const resumed = await recoverAll();
        log(`safety check: unpause attempted for ${resumed.length ? resumed.join(', ') : 'nothing (already running)'}`);
      }
      r.endedAt = Date.now();
      r.phase = r.state;
      log(`finished: ${r.state}`);
      await ctx.agent.close().catch(() => undefined);
    }
  })();
  return r;
}

const active = () => run && !run.endedAt;

function grafanaLink(r) {
  const from = (r ? r.startedAt : Date.now()) - 30_000;
  const to = r?.endedAt ? r.endedAt + 60_000 : 'now';
  return `${GRAFANA}/d/${DASH_UID}?orgId=1&from=${from}&to=${to}&refresh=5s`;
}

function runView(r) {
  if (!r) return null;
  const { abort: _abort, stats, ...rest } = r;
  return { ...rest, log: r.log.slice(-60), stats: stats.snapshot(), grafanaUrl: grafanaLink(r) };
}

// ---------- health of the things we depend on ----------
async function probe(url, ms = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { ok: res.ok, status: res.status, body: res.ok ? await res.json().catch(() => null) : null };
  } catch (err) {
    return { ok: false, error: err.cause?.code ?? err.message };
  }
}

async function status() {
  const [live, stats, prom, graf] = await Promise.all([
    probe(`${TARGET}/health/live`),
    probe(`${TARGET}/health/stats`),
    probe(`${PROM}/-/ready`).then(async (r) => r), // /-/ready returns text, so ok/status is what matters
    probe(`${GRAFANA}/api/health`),
  ]);
  const wb = stats.body?.writeBehind;
  return {
    target: { url: TARGET, ok: live.ok, error: live.error, instance: stats.body?.instance, bidImpl: stats.body?.bidImpl },
    flusher: wb && !wb.error ? { alive: wb.flusherAlive, streamLength: wb.streamLength, lagMs: wb.lastLagMs } : null,
    prometheus: { url: PROM, ok: prom.ok },
    grafana: { url: GRAFANA, ok: graf.ok, dashboard: `${GRAFANA}/d/${DASH_UID}?orgId=1&refresh=5s` },
    frozen: frozenServices(),
  };
}

// ---------- http ----------
const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
  });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

function serveStatic(req, res) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('UI not built yet. Run: npm run build   (then reload this page)');
  }
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST)) file = path.join(DIST, 'index.html'); // path traversal attempt
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!isLocal(host)) return send(res, 403, { error: 'only localhost may use this server' });
    const url = new URL(req.url, 'http://x');

    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'cross-origin request refused' });
    }

    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);

    if (req.method === 'GET' && url.pathname === '/api/scenarios') {
      return send(res, 200, SCENARIOS.map(({ run: _run, ...s }) => ({ ...s, maxRps: MAX_RPS })));
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, await status());
    if (req.method === 'GET' && url.pathname === '/api/live') return send(res, 200, await liveNumbers(PROM).catch(() => ({})));
    if (req.method === 'GET' && url.pathname === '/api/run') return send(res, 200, { run: runView(run), grafanaUrl: grafanaLink(run) });

    if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = await readJson(req);
      const scenario = SCENARIOS.find((s) => s.id === body.scenarioId);
      if (!scenario) return send(res, 400, { error: `unknown scenario "${body.scenarioId}"` });
      if (active()) return send(res, 409, { error: 'a run is already in progress; stop it first' });
      if (scenario.group === 'failure' && body.confirm !== true) return send(res, 400, { error: 'this scenario freezes a container; send confirm: true' });
      return send(res, 202, { run: runView(startRun(scenario, body.params)) });
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      if (!active()) return send(res, 200, { stopped: false });
      run.abort();
      return send(res, 200, { stopped: true });
    }

    // Panic button: unfreeze everything we may have frozen, whatever state the run is in.
    if (req.method === 'POST' && url.pathname === '/api/recover') {
      return send(res, 200, { unpaused: await recoverAll() });
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
});

async function shutdown() {
  if (active()) run.abort();
  await recoverAll().catch(() => undefined);
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Scenario UI: http://localhost:${PORT}`);
  console.log(`  target ${TARGET} | prometheus ${PROM} | grafana ${GRAFANA} (dashboard uid "${DASH_UID}")`);
});
