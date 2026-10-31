// Integration tests for placing bids against the real Postgres and Redis from docker-compose.
// Each test creates its own users and auction, so tests never depend on existing data.
// (A separate test database is still TODO; these tests only add rows, never delete.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { redis } from '../src/cache.js';
import { config } from '../src/config.js';
import { stateRedis, waitStateReady } from '../src/state.js';
import { Flusher } from '../src/flusher.js';

let app: FastifyInstance;
const flusher = new Flusher('test-flusher');
beforeAll(async () => {
  app = buildApp();
  await app.ready();
  await waitStateReady();
  await flusher.init();
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await redis.quit();
  await stateRedis.quit();
});

// With write-behind, Postgres trails Redis by up to one flush. Tests that inspect Postgres first let the flusher catch up.
const settle = async () => {
  if (config.BID_IMPL === 'redis') await flusher.drain();
};

async function users(n: number): Promise<number[]> {
  const { rows } = await pool.query(
    `INSERT INTO users(name) SELECT 'test-' || g FROM generate_series(1, $1) g RETURNING id`,
    [n],
  );
  return rows.map((r) => Number(r.id));
}

/** Creates an auction directly in SQL so a test can choose its own end time. */
async function auction(sellerId: number, startingPrice = 100, endsInSeconds = 600): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO auctions(seller_id, title, starting_price, current_price, ends_at)
     VALUES($1,'test',$2,$2, now() + make_interval(secs => $3)) RETURNING id`,
    [sellerId, startingPrice, endsInSeconds],
  );
  return Number(rows[0].id);
}

const bid = (auctionId: number, bidderId: number, amount: number) =>
  app.inject({ method: 'POST', url: `/auctions/${auctionId}/bids`, payload: { bidderId, amount } });

const state = async (id: number) =>
  (await pool.query('SELECT current_price, highest_bidder, bid_count FROM auctions WHERE id=$1', [id])).rows[0];

describe(`bid rules (BID_IMPL=${config.BID_IMPL})`, () => {
  it('accepts a first bid equal to the starting price and returns seq 1', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller, 100);
    const res = await bid(a, b1, 100);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ amount: '100', seq: '1', bidder_id: String(b1) });
  });

  it('rejects a first bid below the starting price', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller, 100);
    const res = await bid(a, b1, 99);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'BID_TOO_LOW', message: 'bid must be at least 100' });
  });

  it('requires later bids to beat the current price by at least 1', async () => {
    const [seller, b1, b2] = await users(3);
    const a = await auction(seller, 100);
    expect((await bid(a, b1, 150)).statusCode).toBe(201);
    const equal = await bid(a, b2, 150);
    expect(equal.statusCode).toBe(409);
    expect(equal.json().message).toBe('bid must be at least 151');
    expect((await bid(a, b2, 151)).statusCode).toBe(201);
  });

  it('rejects the seller bidding on their own auction', async () => {
    const [seller] = await users(1);
    const a = await auction(seller);
    const res = await bid(a, seller, 500);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('SELF_BID');
  });

  it('rejects bids on an auction that has ended', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller, 100, -5);
    const res = await bid(a, b1, 500);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('AUCTION_CLOSED');
  });

  it('returns 404 for an unknown auction', async () => {
    const [b1] = await users(1);
    const res = await bid(2_000_000_000, b1, 500);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('AUCTION_NOT_FOUND');
  });

  it('assigns gapless seq numbers in order for sequential bids', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller, 100);
    for (let i = 0; i < 5; i++) await bid(a, b1, 100 + i);
    await settle();
    const { rows } = await pool.query('SELECT seq, amount FROM bids WHERE auction_id=$1 ORDER BY seq', [a]);
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((r) => Number(r.amount))).toEqual([100, 101, 102, 103, 104]);
  });

  it('a bid invalidates the cached auction so the next read shows the new price', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller, 100);
    const before = await app.inject({ method: 'GET', url: `/auctions/${a}` }); // fills the cache
    expect(before.json().current_price).toBe('100');
    await bid(a, b1, 250);
    const after = await app.inject({ method: 'GET', url: `/auctions/${a}` });
    expect(after.json().current_price).toBe('250');
    expect(after.json().bid_count).toBe('1');
  });
});

describe(`bids under concurrency (BID_IMPL=${config.BID_IMPL})`, () => {
  it('50 parallel bids with different amounts: consistent price, gapless seq, increasing amounts', async () => {
    const [seller, ...bidders] = await users(51);
    const a = await auction(seller, 100);
    // Shuffled amounts 101..150 so the arrival order differs from the amount order.
    const amounts = Array.from({ length: 50 }, (_, i) => 101 + i).sort(() => Math.random() - 0.5);
    const results = await Promise.all(amounts.map((amt, i) => bid(a, bidders[i], amt)));

    await settle();
    const codes = results.map((r) => r.statusCode);
    expect(codes.every((c) => c === 201 || c === 409)).toBe(true); // no 500s
    const accepted = codes.filter((c) => c === 201).length;
    expect(accepted).toBeGreaterThanOrEqual(1);
    for (const r of results.filter((r) => r.statusCode === 409)) expect(r.json().error).toBe('BID_TOO_LOW');

    const { rows } = await pool.query('SELECT seq, amount, bidder_id FROM bids WHERE auction_id=$1 ORDER BY seq', [a]);
    expect(rows.length).toBe(accepted); // every 201 is stored, nothing else is
    expect(rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: accepted }, (_, i) => i + 1)); // gapless
    const amountsBySeq = rows.map((r) => Number(r.amount));
    for (let i = 1; i < amountsBySeq.length; i++) expect(amountsBySeq[i]).toBeGreaterThan(amountsBySeq[i - 1]);

    const s = await state(a);
    expect(Number(s.current_price)).toBe(150); // the highest bid can never lose
    expect(Number(s.bid_count)).toBe(accepted);
    expect(Number(s.highest_bidder)).toBe(Number(rows[rows.length - 1].bidder_id));
  });

  it('20 parallel bids of the same amount: exactly one wins', async () => {
    const [seller, ...bidders] = await users(21);
    const a = await auction(seller, 100);
    const results = await Promise.all(bidders.map((b) => bid(a, b, 500)));
    await settle();
    expect(results.filter((r) => r.statusCode === 201).length).toBe(1);
    expect(results.filter((r) => r.statusCode === 409).length).toBe(19);
    const s = await state(a);
    expect(Number(s.bid_count)).toBe(1);
    expect(Number(s.current_price)).toBe(500);
  });

  it('bids on different auctions in parallel do not interfere', async () => {
    const [seller, ...bidders] = await users(11);
    const auctions = await Promise.all(Array.from({ length: 10 }, () => auction(seller, 100)));
    const results = await Promise.all(auctions.map((a, i) => bid(a, bidders[i], 200)));
    await settle();
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    for (const a of auctions) expect(Number((await state(a)).bid_count)).toBe(1);
  });
});
