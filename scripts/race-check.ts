// Two API instances firing bids at the same auction at the same moment.
// Needs: scripts/cluster.sh start        Run: npx tsx scripts/race-check.ts
// Each round fires all requests at once (half at :3001, half at :3002) and then checks, in Postgres, that the outcome
// is exactly what a strict one-at-a-time order would have produced.
import { pool } from '../src/db.js';

const HOSTS = ['localhost:3001', 'localhost:3002'];
let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(bidders: number) {
  const seller = Number((await pool.query(`INSERT INTO users(name) VALUES('race-seller') RETURNING id`)).rows[0].id);
  const ids = (await pool.query(`INSERT INTO users(name) SELECT 'race-b' || g FROM generate_series(1,$1) g RETURNING id`, [bidders])).rows.map((r) => Number(r.id));
  const auction = Number(
    (await pool.query(
      `INSERT INTO auctions(seller_id,title,starting_price,current_price,ends_at) VALUES($1,'race',100,100, now() + interval '10 minutes') RETURNING id`,
      [seller],
    )).rows[0].id,
  );
  return { auction, ids };
}

async function bid(host: string, auction: number, bidderId: number, amount: number) {
  const res = await fetch(`http://${host}/auctions/${auction}/bids`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bidderId, amount }),
  });
  return { status: res.status, instance: res.headers.get('x-instance') ?? '?', body: (await res.json()) as { seq?: string } };
}

async function waitForFlusher() {
  for (let i = 0; i < 60; i++) {
    const s = (await (await fetch(`http://${HOSTS[0]}/health/stats`)).json()) as { writeBehind?: { streamLength?: number } };
    if (s.writeBehind?.streamLength === 0) return;
    await sleep(250);
  }
}

for (let round = 1; round <= 3; round++) {
  console.log(`\n--- round ${round} ---`);

  // A) the SAME amount from many bidders at once: exactly one can win
  {
    const N = 100;
    const { auction, ids } = await setup(N);
    const results = await Promise.all(ids.map((id, i) => bid(HOSTS[i % 2], auction, id, 500))); // all fired together
    const won = results.filter((r) => r.status === 201);
    const lost = results.filter((r) => r.status === 409);
    const byInstance = (rs: typeof results) => [...new Set(rs.map((r) => r.instance))].sort().join(' + ');
    check(`A: ${N} identical bids from both instances: exactly one wins`, won.length === 1 && lost.length === N - 1, `(won ${won.length}, refused ${lost.length}; requests came through ${byInstance(results)})`);
    check('A: the winner was given seq 1', won[0]?.body.seq === '1');
    await waitForFlusher();
    const saved = Number((await pool.query('SELECT count(*) FROM bids WHERE auction_id=$1', [auction])).rows[0].count);
    check('A: Postgres holds exactly one bid for it', saved === 1, `(${saved})`);
  }

  // B) many DIFFERENT amounts at once, arriving in random order: the result must look like some strict one-at-a-time order
  {
    const N = 200;
    const { auction, ids } = await setup(N);
    const amounts = Array.from({ length: N }, (_, i) => 101 + i).sort(() => Math.random() - 0.5);
    const results = await Promise.all(amounts.map((amt, i) => bid(HOSTS[i % 2], auction, ids[i], amt)));
    const accepted = results.filter((r) => r.status === 201).length;
    check(`B: ${N} different bids from both instances: no errors`, results.every((r) => r.status === 201 || r.status === 409), `(accepted ${accepted}, refused ${N - accepted})`);
    await waitForFlusher();
    const { rows } = await pool.query('SELECT seq, amount FROM bids WHERE auction_id=$1 ORDER BY seq', [auction]);
    const seqs = rows.map((r) => Number(r.seq));
    const amts = rows.map((r) => Number(r.amount));
    check('B: sequence numbers are 1..N with no gaps or repeats', seqs.every((s, i) => s === i + 1) && seqs.length === accepted, `(${seqs.length} saved)`);
    check('B: every accepted bid beat the one before it (strictly rising)', amts.every((a, i) => i === 0 || a > amts[i - 1]));
    const price = Number((await pool.query('SELECT current_price FROM auctions WHERE id=$1', [auction])).rows[0].current_price);
    check('B: the highest bid (300) is the final price, whatever order they arrived in', price === 300 && amts[amts.length - 1] === 300, `(price ${price})`);
  }
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
await pool.end();
process.exit(failed ? 1 : 0);
