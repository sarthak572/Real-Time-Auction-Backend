import type { FastifyInstance } from 'fastify';

// Development tool only: a tiny page that watches an auction live and can place bids.
// Open it in two tabs (or on two server ports) to see real-time delivery across instances.
const html = `<!doctype html><meta charset="utf-8"><title>Live auction demo</title>
<style>
body{font:15px system-ui;max-width:720px;margin:2rem auto;padding:0 1rem}
input,button{font:inherit;padding:.3rem .5rem;margin-right:.3rem}
#price{font-size:2.2rem;font-weight:600}.muted{color:#777}
#log{height:240px;overflow:auto;background:#111;color:#ddd;padding:.5rem;font:13px ui-monospace,monospace;white-space:pre-wrap}
.warn{color:#f90}.ok{color:#6c6}
</style>
<h2>Live auction demo</h2>
<p>
 WS host <input id="host" size="16"> auction <input id="aid" size="4" value="1">
 <button id="go">Connect</button> <span id="status" class="muted">disconnected</span>
</p>
<div id="price">-</div>
<div class="muted">highest bidder <b id="who">-</b> | seq <b id="seq">-</b></div>
<p>
 Place a bid via REST (host <input id="api" size="16">): bidder id <input id="bidder" size="4" value="2">
 amount <input id="amount" size="6" value="200"> <button id="bid">Bid</button>
</p>
<div id="log"></div>
<script>
const $ = (id) => document.getElementById(id);
$('host').value = $('api').value = location.host;
let ws, seq = null, attempt = 0, wantOpen = false;
const log = (t, c = '') => { const d = document.createElement('div'); d.className = c; d.textContent = new Date().toLocaleTimeString() + '  ' + t; $('log').append(d); $('log').scrollTop = 1e9; };
const show = () => { $('seq').textContent = seq ?? '-'; };

function connect() {
  wantOpen = true;
  // Reconnect with the last seq we saw so the server can replay what we missed.
  const q = seq !== null ? '?lastSeq=' + seq : '';
  ws = new WebSocket('ws://' + $('host').value + '/auctions/' + $('aid').value + '/live' + q);
  ws.onopen = () => { attempt = 0; $('status').textContent = 'connected'; log('connected' + q, 'ok'); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'snapshot') {
      seq = m.seq; $('price').textContent = m.currentPrice; $('who').textContent = m.highestBidder ?? '-';
      log('snapshot price=' + m.currentPrice + ' seq=' + m.seq);
    } else if (m.type === 'bid') {
      if (m.replay) { log('replayed bid #' + m.seq + ' amount=' + m.amount + ' by ' + m.bidderId, 'muted'); return; }
      if (seq !== null && m.seq <= seq) return;                       // duplicate or old: ignore
      if (seq !== null && m.seq > seq + 1) { log('GAP: expected ' + (seq + 1) + ' got ' + m.seq + ' -> reconnecting', 'warn'); ws.close(); return; }
      seq = m.seq; $('price').textContent = m.amount; $('who').textContent = m.bidderId;
      log('bid #' + m.seq + ' amount=' + m.amount + ' by ' + m.bidderId + ' (' + (Date.now() - Date.parse(m.at)) + ' ms)', 'ok');
    } else log(JSON.stringify(m));
    show();
  };
  ws.onclose = (e) => {
    $('status').textContent = 'disconnected (' + e.code + ')';
    if (!wantOpen) return;
    const wait = Math.min(10000, 500 * 2 ** attempt++) + Math.random() * 300; // exponential backoff + jitter
    log('closed (' + e.code + '), retrying in ' + Math.round(wait) + ' ms', 'warn');
    setTimeout(() => wantOpen && connect(), wait);
  };
}
$('go').onclick = () => { if (ws) { wantOpen = false; ws.close(); } seq = null; connect(); };
$('bid').onclick = async () => {
  const r = await fetch('http://' + $('api').value + '/auctions/' + $('aid').value + '/bids', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bidderId: +$('bidder').value, amount: +$('amount').value }) });
  log('POST bid -> ' + r.status + ' ' + (r.ok ? '' : JSON.stringify(await r.json())), r.ok ? '' : 'warn');
};
</script>`;

export async function demoRoutes(app: FastifyInstance) {
  app.get('/demo', async (_req, reply) => reply.type('text/html').send(html));
}
