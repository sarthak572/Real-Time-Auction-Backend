// Thin wrapper over the control server's JSON API.
async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  scenarios: () => call('GET', '/api/scenarios'),
  status: () => call('GET', '/api/status'),
  live: () => call('GET', '/api/live'),
  run: () => call('GET', '/api/run'),
  start: (scenarioId, params, confirm) => call('POST', '/api/run', { scenarioId, params, confirm }),
  stop: () => call('POST', '/api/stop'),
  recover: () => call('POST', '/api/recover'),
};
