import React, { useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

// Poll a function every `ms`; keep the last good value and any error.
function usePoll(fn, ms) {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const data = await fn();
        if (alive) setState({ data, error: null });
      } catch (error) {
        if (alive) setState((s) => ({ data: s.data, error }));
      }
    };
    tick();
    const id = setInterval(tick, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [fn, ms]);
  return state;
}

const fmt = (n, digits = 1) => (n === null || n === undefined || Number.isNaN(n) ? '–' : Number(n).toFixed(digits));
const fmtMs = (ms) => (ms === null || ms === undefined ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

function Chip({ ok, label, detail }) {
  return (
    <span className={`chip ${ok === null ? 'chip-off' : ok ? 'chip-ok' : 'chip-bad'}`} title={detail}>
      <i /> {label}
      {detail ? <small>{detail}</small> : null}
    </span>
  );
}

function Tile({ label, value, unit, hint }) {
  return (
    <div className="tile" title={hint}>
      <div className="tile-value">
        {value}
        {unit ? <span>{unit}</span> : null}
      </div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

function ParamInput({ p, value, onChange, disabled }) {
  return (
    <label className="param">
      <span>{p.label}</span>
      <input type="number" min={p.min} max={p.max} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
    </label>
  );
}

function ScenarioCard({ s, params, setParam, busy, targetDown, onRun }) {
  return (
    <article className={`card ${s.group === 'failure' ? 'card-failure' : ''}`}>
      <header>
        <h3>{s.name}</h3>
        {s.group === 'failure' ? <span className="badge badge-warn">freezes a container</span> : null}
      </header>
      <p>{s.description}</p>
      <div className="params">
        {s.params.map((p) =>
          p.key === 'durationSec' && s.fixedDuration ? null : (
            <ParamInput key={p.key} p={p} value={params[p.key] ?? p.def} disabled={busy} onChange={(v) => setParam(s.id, p.key, v)} />
          ),
        )}
        {s.fixedDuration ? <span className="muted">fixed {s.fixedDuration} s</span> : null}
      </div>
      <details>
        <summary>What to look for in Grafana</summary>
        <ul>
          {s.watch.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        <p className="muted">{s.expect}</p>
      </details>
      <button className={s.group === 'failure' ? 'btn btn-warn' : 'btn btn-primary'} disabled={busy || targetDown} onClick={() => onRun(s)}>
        {s.group === 'failure' ? 'Run failure drill…' : 'Run'}
      </button>
    </article>
  );
}

function RunPanel({ run, onStop }) {
  if (!run) return <div className="panel muted">No run yet. Pick a scenario on the left.</div>;
  const active = !run.endedAt;
  const pct = Math.min(100, (run.elapsedSec / run.durationSec) * 100);
  const st = run.stats;
  return (
    <div className="panel">
      <div className="run-head">
        <h2>{run.name}</h2>
        <span className={`badge badge-${run.state}`}>{run.state}</span>
      </div>
      <div className="muted">{active ? run.phase : `finished after ${fmt((run.endedAt - run.startedAt) / 1000, 0)} s`}</div>
      <div className="bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="muted small">
        {fmt(run.elapsedSec, 0)} / {run.durationSec} s · sending {fmt(run.rate, 0)} req/s
      </div>

      <div className="grid4">
        <Tile label="sent" value={st.sent} />
        <Tile label="answered" value={st.done} />
        <Tile label="dropped by tool" value={st.dropped} hint="Too many requests were already waiting, so the tool skipped them" />
        <Tile label="connection errors" value={st.netErrors} />
        <Tile label="p50 (≤)" value={fmtMs(st.p50Ms)} />
        <Tile label="p95 (≤)" value={fmtMs(st.p95Ms)} />
        <Tile label="p99 (≤)" value={fmtMs(st.p99Ms)} />
        <Tile label="replayed" value={st.replayed} hint="Answers marked Idempotent-Replayed" />
      </div>
      <p className="muted small">Latency is measured by this tool (client side) and rounded up to a bucket. Prometheus and Grafana measure the server side.</p>

      <h4>Answers received</h4>
      <table>
        <tbody>
          {Object.entries(st.outcomes).map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="num">{v}</td>
            </tr>
          ))}
          {Object.keys(st.outcomes).length === 0 ? (
            <tr>
              <td className="muted">nothing yet</td>
              <td />
            </tr>
          ) : null}
        </tbody>
      </table>
      {st.ws.opened + st.ws.refused > 0 ? (
        <p className="small">
          WebSockets: {st.ws.opened} connected, {st.ws.refused} refused, {st.ws.messages} messages received
        </p>
      ) : null}
      {run.error ? <p className="error">Error: {run.error}</p> : null}

      <div className="actions">
        {active ? (
          <button className="btn btn-stop" onClick={onStop}>
            Stop
          </button>
        ) : null}
        <a className="btn btn-link" href={run.grafanaUrl} target="_blank" rel="noreferrer">
          Open Grafana at this run ↗
        </a>
      </div>

      <h4>Log</h4>
      <pre className="log">
        {run.log
          .slice(-10)
          .map((l) => `${new Date(l.t).toLocaleTimeString()}  ${l.msg}`)
          .join('\n')}
      </pre>
    </div>
  );
}

export default function App() {
  const scenariosPoll = usePoll(api.scenarios, 60000);
  const status = usePoll(api.status, 3000).data;
  const live = usePoll(api.live, 2500).data;
  const runPoll = usePoll(api.run, 1000);
  const run = runPoll.data?.run ?? null;
  const [params, setParams] = useState({});
  const [confirming, setConfirming] = useState(null);
  const [message, setMessage] = useState(null);

  const scenarios = scenariosPoll.data ?? [];
  const busy = !!run && !run.endedAt;
  const targetDown = !status || !status.target.ok;

  const setParam = useCallback((id, key, value) => setParams((p) => ({ ...p, [id]: { ...p[id], [key]: value } })), []);

  const start = async (s, confirm) => {
    setMessage(null);
    try {
      await api.start(s.id, params[s.id], confirm);
    } catch (e) {
      setMessage(e.message);
    }
  };
  const onRun = (s) => (s.group === 'failure' ? setConfirming(s) : start(s, false));

  const load = scenarios.filter((s) => s.group === 'load');
  const failure = scenarios.filter((s) => s.group === 'failure');

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Auction Lab Console</h1>
          <p className="muted">Press a button to create traffic or a failure, then watch what it does in Grafana.</p>
        </div>
        <a className="btn btn-link" href={status?.grafana.dashboard ?? '#'} target="_blank" rel="noreferrer">
          Open Grafana dashboard ↗
        </a>
      </header>

      <div className="chips">
        <Chip ok={status ? status.target.ok : null} label="Auction API" detail={status?.target.ok ? `${status.target.bidImpl ?? ''}` : status?.target.error} />
        <Chip
          ok={status?.flusher ? status.flusher.alive : null}
          label="Flusher"
          detail={status?.flusher ? `backlog ${status.flusher.streamLength}` : 'unknown'}
        />
        <Chip ok={status ? status.prometheus.ok : null} label="Prometheus" />
        <Chip ok={status ? status.grafana.ok : null} label="Grafana" />
      </div>

      {status && !status.target.ok ? (
        <div className="banner banner-bad">
          The auction API at <b>{status.target.url}</b> is not answering. Start it with <code>npm run cluster:start</code> in the project folder (and stop the other stack that may be using
          port 3000). Scenario buttons are disabled until it is up.
        </div>
      ) : null}
      {status && status.target.ok && (!status.prometheus.ok || !status.grafana.ok) ? (
        <div className="banner banner-warn">
          Prometheus or Grafana is not up. Run <code>npm run obs:up</code> to start them, otherwise there is nothing to look at.
        </div>
      ) : null}
      {status?.frozen.length ? (
        <div className="banner banner-bad">
          Frozen right now: <b>{status.frozen.join(', ')}</b>{' '}
          <button className="btn btn-warn" onClick={() => api.recover().then((r) => setMessage(`unpaused: ${r.unpaused.join(', ') || 'nothing'}`))}>
            Recover now
          </button>
        </div>
      ) : null}
      {message ? <div className="banner banner-warn">{message}</div> : null}

      <section className="tiles">
        <Tile label="requests / s" value={fmt(live?.requestsPerSec, 0)} hint="From Prometheus, last 30 s" />
        <Tile label="bids accepted / s" value={fmt(live?.bidsAcceptedPerSec, 0)} />
        <Tile label="bid p95" value={live?.bidP95Seconds == null ? '–' : fmtMs(Math.round(live.bidP95Seconds * 1000))} />
        <Tile label="5xx / s" value={fmt(live?.serverErrorsPerSec, 1)} />
        <Tile label="bids waiting to be saved" value={fmt(live?.backlog, 0)} />
        <Tile label="flusher lag" value={live?.flusherLagSeconds == null ? '–' : `${fmt(live.flusherLagSeconds, 2)} s`} />
        <Tile label="event-loop lag p99" value={live?.eventLoopP99Seconds == null ? '–' : fmtMs(Math.round(live.eventLoopP99Seconds * 1000))} />
      </section>

      <div className="cols">
        <div>
          <h2>Load tests</h2>
          <div className="cards">
            {load.map((s) => (
              <ScenarioCard key={s.id} s={s} params={params[s.id] ?? {}} setParam={setParam} busy={busy} targetDown={targetDown} onRun={onRun} />
            ))}
          </div>
          <h2>Failure drills</h2>
          <p className="muted">These pause a container for a short time (data is not touched) and always resume it afterwards.</p>
          <div className="cards">
            {failure.map((s) => (
              <ScenarioCard key={s.id} s={s} params={params[s.id] ?? {}} setParam={setParam} busy={busy} targetDown={targetDown} onRun={onRun} />
            ))}
          </div>
        </div>
        <aside>
          <RunPanel run={run} onStop={() => api.stop()} />
        </aside>
      </div>

      {confirming ? (
        <div className="modal-bg" onClick={() => setConfirming(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{confirming.name}</h3>
            <p>{confirming.description}</p>
            <p className="muted">It runs <code>docker compose pause</code> on a local container and unpauses it automatically, even if you stop the run.</p>
            <div className="actions">
              <button className="btn" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <button
                className="btn btn-warn"
                onClick={() => {
                  const s = confirming;
                  setConfirming(null);
                  start(s, true);
                }}
              >
                Start drill
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
