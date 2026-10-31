// End-to-end check of the control server against FAKES (mock API, mock Prometheus, stub docker).
// Run: npm run build && npm run test:smoke      Proves the control logic; says nothing about the real backend.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockTarget, startMockObservability } from './mock-target.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORTS = { ui: 4900, api: 4901, obs: 4902 };
const UI = `http://127.0.0.1:${PORTS.ui}`;
const stubLog = path.join(os.tmpdir(), `lab-ui-docker-${process.pid}.log`);
fs.writeFileSync(stubLog, '');

let passed = 0;
let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  cond ? passed++ : failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => (await fetch(UI + p)).json();
const post = async (p, body, headers = {}) => {
  const res = await fetch(UI + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
};
async function waitDone(timeoutMs = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { run } = await get('/api/run');
    if (run?.endedAt) return run;
    await sleep(200);
  }
  throw new Error('run did not finish in time');
}
const dockerCalls = () => fs.readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean);

const api = await startMockTarget(PORTS.api, { wsLimit: 5 });
const obs = await startMockObservability(PORTS.obs);
const server = spawn(process.execPath, [path.join(here, '..', 'server', 'index.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORTS.ui),
    LAB_TARGET: `http://127.0.0.1:${PORTS.api}`,
    LAB_PROMETHEUS: `http://127.0.0.1:${PORTS.obs}`,
    LAB_GRAFANA: `http://127.0.0.1:${PORTS.obs}`,
    LAB_TEST_FAST: '1',
    LAB_DOCKER_STUB: path.join(here, 'docker-stub.mjs'),
    STUB_LOG: stubLog,
  },
  stdio: 'ignore',
});

try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(UI + '/api/scenarios');
      break;
    } catch {
      await sleep(100);
    }
  }

  // ---- read-only endpoints ----
  const scenarios = await get('/api/scenarios');
  check('lists 9 scenarios', scenarios.length === 9, String(scenarios.length));
  check('scenario list leaks no functions', scenarios.every((s) => typeof s.run === 'undefined'));
  const st = await get('/api/status');
  check('status sees the (fake) API', st.target.ok === true && st.target.instance === 'mock-1');
  check('status reads flusher backlog', st.flusher?.alive === true && st.flusher.streamLength === 3);
  check('status sees prometheus and grafana', st.prometheus.ok && st.grafana.ok);
  const live = await get('/api/live');
  check('live numbers come from prometheus', live.requestsPerSec === 12.5);
  const html = await (await fetch(UI + '/')).text();
  check('serves the built page', html.includes('Auction Lab Console'), 'run npm run build first');

  // ---- steady load ----
  let r = await post('/api/run', { scenarioId: 'steady', params: { durationSec: 4, rps: 50 } });
  check('steady starts (202)', r.status === 202, JSON.stringify(r.body));
  const second = await post('/api/run', { scenarioId: 'steady' });
  check('second run refused while one is active (409)', second.status === 409);
  let run = await waitDone();
  const o = run.stats.outcomes;
  check('steady finished', run.state === 'done', run.state + ' ' + run.error);
  check('steady sent roughly rate x time', run.stats.sent > 100 && run.stats.sent < 320, String(run.stats.sent));
  check('steady got 201s and normal refusals', (o['201'] ?? 0) > 0, JSON.stringify(o));
  check('no connection errors', run.stats.netErrors === 0, String(run.stats.netErrors));
  check('every request is accounted for', run.stats.done + run.stats.netErrors === run.stats.sent, `${run.stats.done}+${run.stats.netErrors} vs ${run.stats.sent}`);
  check('grafana link carries the run window', /from=\d+&to=\d+/.test(run.grafanaUrl), run.grafanaUrl);

  // ---- caps and stop ----
  r = await post('/api/run', { scenarioId: 'hot', params: { rps: 99999, durationSec: 100000 } });
  check('rps is capped at the scenario maximum (1500)', r.body.run.params.rps === 1500, String(r.body.run.params.rps));
  check('duration is capped at 180 for this scenario', r.body.run.params.durationSec === 180, String(r.body.run.params.durationSec));
  await sleep(1500);
  await post('/api/stop');
  run = await waitDone();
  check('stop ends the run as "stopped"', run.state === 'stopped', run.state);

  // ---- idempotency ----
  await post('/api/run', { scenarioId: 'retry', params: { durationSec: 4, rps: 100 } });
  run = await waitDone();
  check('retry storm produced replayed answers', run.stats.replayed > 0, String(run.stats.replayed));

  // ---- websockets ----
  await post('/api/run', { scenarioId: 'viewers', params: { durationSec: 4, sockets: 8 } });
  run = await waitDone();
  check('viewers: limit respected (5 connected, 3 refused)', run.stats.ws.opened === 5 && run.stats.ws.refused === 3, JSON.stringify(run.stats.ws));
  check('viewers received pushed bids', run.stats.ws.messages > 0, String(run.stats.ws.messages));

  // ---- failure drills ----
  r = await post('/api/run', { scenarioId: 'postgres-freeze' });
  check('failure drill needs confirm (400)', r.status === 400);
  fs.writeFileSync(stubLog, '');
  r = await post('/api/run', { scenarioId: 'postgres-freeze', confirm: true, params: { rps: 50 } });
  check('failure drill starts with confirm', r.status === 202, JSON.stringify(r.body));
  run = await waitDone();
  let calls = dockerCalls();
  check('drill froze then resumed postgres', calls.some((c) => c.includes('pause postgres') && !c.includes('unpause')) && calls.some((c) => c.includes('unpause postgres')), calls.join(' | '));
  check('drill finished cleanly', run.state === 'done', run.state + ' ' + run.error);

  fs.writeFileSync(stubLog, '');
  await post('/api/run', { scenarioId: 'redis-freeze', confirm: true, params: { rps: 30 } });
  await sleep(2600); // the freeze fires at 10 s x 0.2 = 2 s
  await post('/api/stop');
  run = await waitDone();
  calls = dockerCalls();
  check('stopping mid-drill still unfreezes everything', calls.filter((c) => c.includes('unpause')).length >= 2 && calls.some((c) => c.includes('unpause redis-state')), calls.join(' | '));

  // ---- safety ----
  r = await post('/api/run', { scenarioId: 'nope' });
  check('unknown scenario refused (400)', r.status === 400);
  r = await post('/api/run', { scenarioId: 'steady' }, { origin: 'http://evil.example' });
  check('cross-origin POST refused (403)', r.status === 403, String(r.status));
  const badHost = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORTS.ui, path: '/api/status', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode));
  });
  check('non-localhost Host header refused (403)', badHost === 403, String(badHost));
  const traversal = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORTS.ui, path: '/..%2f..%2fpackage.json' }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(b));
    });
  });
  check('path traversal does not leak files', !traversal.includes('"auction-lab-ui"'));
} catch (err) {
  console.log('ERROR', err.stack);
  failed++;
} finally {
  server.kill();
  api.close();
  obs.close();
  fs.rmSync(stubLog, { force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
