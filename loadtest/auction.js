// k6 load test. Usage: k6 run -e SCENARIO=reads|bids_spread|bids_hot -e PEAK=2000 loadtest/auction.js
// Open model (ramping-arrival-rate): we push a fixed request RATE regardless of how slow the server gets,
// which is how real traffic behaves and is how you find the breaking point.
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

const BASE = __ENV.BASE || 'http://localhost:3000';
const SCENARIO = __ENV.SCENARIO || 'reads';
const PEAK = Number(__ENV.PEAK || 1000);
// k6 memory grows with virtual users. When responses take milliseconds a few hundred are plenty.
const PRE_VUS = Number(__ENV.PREVUS || 200);
const MAX_VUS = Number(__ENV.MAXVUS || 3000);
// IDEM=1 sends an Idempotency-Key with every bid; DUP is the share of bids that are then sent a second time with
// the same key (a client retry), which the server must answer without placing a second bid.
const IDEM = __ENV.IDEM === '1';
const DUP = Number(__ENV.DUP || 0);
const AUCTIONS = SCENARIO === 'bids_hot' ? 1 : 100;
const BIDDERS = 200;
const JSON_H = { headers: { 'Content-Type': 'application/json' } };
// During the test itself nobody reads the response body, so don't keep it in memory (setup() still needs its bodies).
const JSON_NOBODY = { headers: { 'Content-Type': 'application/json' }, responseType: 'none' };
const NOBODY = { responseType: 'none' };

http.setResponseCallback(http.expectedStatuses(200, 201, 409)); // 409 = legit "bid too low"

export const options = {
  scenarios: {
    load: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
      stages: [
        { target: Math.round(PEAK / 4), duration: '20s' },
        { target: Math.round(PEAK / 2), duration: '20s' },
        { target: PEAK, duration: '30s' },
        { target: PEAK, duration: '30s' },
        { target: 0, duration: '10s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

const post = (path, body, params = JSON_H) => http.post(`${BASE}${path}`, JSON.stringify(body), params);

export function setup() {
  const seller = JSON.parse(post('/users', { name: 'seller' }).body).id;
  const bidders = [];
  for (let i = 0; i < BIDDERS; i++) bidders.push(Number(JSON.parse(post('/users', { name: `b${i}` }).body).id));
  const auctions = [];
  for (let i = 0; i < AUCTIONS; i++) {
    const r = post('/auctions', { sellerId: Number(seller), title: `load-${i}`, startingPrice: 100, durationSeconds: 3600 });
    auctions.push(Number(JSON.parse(r.body).id));
  }
  return { bidders, auctions };
}

export default function (d) {
  const n = exec.scenario.iterationInTest;
  const auction = d.auctions[n % d.auctions.length];
  if (SCENARIO === 'reads') {
    const res = n % 5 === 0 ? http.get(`${BASE}/auctions?limit=20`, NOBODY) : http.get(`${BASE}/auctions/${auction}`, NOBODY);
    check(res, { 'read 200': (r) => r.status === 200 });
  } else {
    const bidder = d.bidders[n % d.bidders.length];
    const body = { bidderId: bidder, amount: 101 + Math.floor(n / d.auctions.length) };
    let params = JSON_NOBODY;
    if (IDEM) params = { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `k6-${exec.scenario.iterationInTest}-${__VU}` }, responseType: 'none' };
    const res = post(`/auctions/${auction}/bids`, body, params);
    if (IDEM && Math.random() < DUP) post(`/auctions/${auction}/bids`, body, params); // the client retry
    check(res, { 'bid 201/409': (r) => r.status === 201 || r.status === 409 });
  }
}
