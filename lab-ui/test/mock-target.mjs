// A fake auction API + fake Prometheus/Grafana + fake docker, used only by the smoke test.
// It mimics the real API's rules closely enough to exercise the scenarios; it proves the UI's server
// logic, NOT the real backend's behaviour.
import http from 'node:http';
import { WebSocketServer } from 'ws';

export function startMockTarget(port, { wsLimit = 5 } = {}) {
  let nextId = 1;
  const auctions = new Map(); // id -> { price, bids, sockets:Set }
  const idem = new Map();
  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      const url = new URL(req.url, 'http://x');
      const m = url.pathname.match(/^\/auctions\/(\d+)(\/bids)?$/);
      if (url.pathname === '/health/live') return json(res, 200, { status: 'ok' });
      if (url.pathname === '/health/stats') {
        return json(res, 200, { instance: 'mock-1', bidImpl: 'redis', writeBehind: { flusherAlive: true, streamLength: 3, lastLagMs: 12 } });
      }
      if (req.method === 'POST' && url.pathname === '/users') return json(res, 201, { id: String(nextId++), name: body.name });
      if (req.method === 'POST' && url.pathname === '/auctions') {
        const id = nextId++;
        auctions.set(id, { price: body.startingPrice - 1, sockets: new Set() });
        return json(res, 201, { id: String(id) });
      }
      if (req.method === 'GET' && m && !m[2]) {
        return auctions.has(+m[1]) ? json(res, 200, { id: m[1] }) : json(res, 404, { error: 'AUCTION_NOT_FOUND' });
      }
      if (req.method === 'POST' && m && m[2]) {
        const a = auctions.get(+m[1]);
        if (!a) return json(res, 404, { error: 'AUCTION_NOT_FOUND' });
        const key = req.headers['idempotency-key'];
        const idemKey = key && `${body.bidderId}:${key}`;
        if (idemKey && idem.has(idemKey)) return json(res, 201, idem.get(idemKey), { 'idempotent-replayed': 'true' });
        if (body.amount <= a.price) return json(res, 409, { error: 'BID_TOO_LOW' });
        a.price = body.amount;
        const out = { seq: String(a.price), amount: String(body.amount) };
        if (idemKey) idem.set(idemKey, out);
        for (const ws of a.sockets) ws.send(JSON.stringify({ type: 'bid', seq: a.price }));
        return json(res, 201, out);
      }
      return json(res, 404, { error: 'not found' });
    });
  });

  // Same shape as the real API: refuse viewers beyond a per-address limit with HTTP 429 during the upgrade.
  const wss = new WebSocketServer({ noServer: true });
  let viewers = 0;
  server.on('upgrade', (req, socket, head) => {
    const m = req.url.match(/^\/auctions\/(\d+)\/live/);
    if (!m || viewers >= wsLimit || !auctions.has(+m[1])) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      viewers++;
      auctions.get(+m[1]).sockets.add(ws);
      ws.on('close', () => viewers--);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

export function startMockObservability(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/-/ready') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('Prometheus Server is Ready.');
    }
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"database":"ok"}');
    }
    if (url.pathname === '/api/v1/query') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'success', data: { result: [{ metric: {}, value: [0, '12.5'] }] } }));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
