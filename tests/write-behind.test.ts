// Tests for the write-behind path: Redis decides and records bids, a flusher saves them to Postgres later.
// Only runs when BID_IMPL=redis. The flusher is driven by hand here (never running in the background),
// so every test controls exactly when Postgres catches up.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { redis } from '../src/cache.js';
import { config } from '../src/config.js';
import { stateRedis, waitStateReady, stateKey, STREAM, GROUP } from '../src/state.js';
import { Flusher, applyBatch, type StreamBid } from '../src/flusher.js';

const enabled = config.BID_IMPL === 'redis';
let app: FastifyInstance;
const flusher = new Flusher('wb-test-flusher');

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  await waitStateReady();
  await flusher.init();
  await flusher.drain(); // start from an empty stream
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await redis.quit();
  await stateRedis.quit();
});

async function users(n: number): Promise<number[]> {
  const { rows } = await pool.query(
    `INSERT INTO users(name) SELECT 'wb-' || g FROM generate_series(1, $1) g RETURNING id`,
    [n],
  );
  return rows.map((r) => Number(r.id));
}
async function auction(sellerId: number, startingPrice = 100): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO auctions(seller_id, title, starting_price, current_price, ends_at)
     VALUES($1,'wb',$2,$2, now() + interval '10 minutes') RETURNING id`,
    [sellerId, startingPrice],
  );
  return Number(rows[0].id);
}
const bid = (auctionId: number, bidderId: number, amount: number) =>
  app.inject({ method: 'POST', url: `/auctions/${auctionId}/bids`, payload: { bidderId, amount } });
const pgAuction = async (id: number) =>
  (await pool.query('SELECT current_price, highest_bidder, bid_count FROM auctions WHERE id=$1', [id])).rows[0];
const pgBidCount = async (id: number) =>
  Number((await pool.query('SELECT count(*) FROM bids WHERE auction_id=$1', [id])).rows[0].count);

/** The stream entries that belong to one auction, parsed the same way the flusher parses them. */
async function streamBids(auctionId: number): Promise<StreamBid[]> {
  const raw = (await stateRedis.xrange(STREAM, '-', '+')) as [string, string[]][];
  return raw
    .map(([streamId, f]) => {
      const m: Record<string, string> = {};
      for (let i = 0; i < f.length; i += 2) m[f[i]] = f[i + 1];
      return { streamId, auctionId: Number(m.a), bidderId: Number(m.b), amount: Number(m.m), seq: Number(m.s), ts: Number(m.t) };
    })
    .filter((b) => b.auctionId === auctionId);
}

describe.skipIf(!enabled)('write-behind (BID_IMPL=redis)', () => {
  it('reads show the new price immediately, before Postgres has it', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller);
    expect((await bid(a, b1, 250)).statusCode).toBe(201);

    const read = await app.inject({ method: 'GET', url: `/auctions/${a}` });
    expect(read.json()).toMatchObject({ current_price: '250', bid_count: '1', highest_bidder: String(b1) });

    const before = await pgAuction(a); // Postgres is still behind: nothing flushed yet
    expect(before).toMatchObject({ current_price: '100', bid_count: '0' });
    expect(await pgBidCount(a)).toBe(0);

    await flusher.drain();
    expect(await pgAuction(a)).toMatchObject({ current_price: '250', bid_count: '1', highest_bidder: String(b1) });
    expect(await pgBidCount(a)).toBe(1);
  });

  it('applying the same batch twice does not duplicate bids or change the result', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller);
    for (const amt of [110, 120, 130]) await bid(a, b1, amt);
    const entries = await streamBids(a);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);

    await applyBatch(entries);
    await applyBatch(entries); // what happens when a flusher crashes after writing but before acknowledging
    expect(await pgBidCount(a)).toBe(3);
    expect(await pgAuction(a)).toMatchObject({ current_price: '130', bid_count: '3' });
    await flusher.drain(); // acknowledge the leftovers
  });

  it('a bid that reuses a seq already in Postgres with different content is reported, not silently dropped', async () => {
    const [seller, b1, b2] = await users(3);
    const a = await auction(seller);
    await bid(a, b1, 150);
    const entries = await streamBids(a);
    // Postgres already holds a different bid #1 (as if Redis had lost recent writes and reused the seq).
    await pool.query('INSERT INTO bids(auction_id, bidder_id, amount, seq) VALUES($1,$2,999,1)', [a, b2]);
    expect(await applyBatch(entries)).toBe(1);
    await flusher.drain();
  });

  it('a late batch never moves the auction backwards', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller);
    for (const amt of [110, 120, 130]) await bid(a, b1, amt);
    const entries = await streamBids(a);

    await applyBatch(entries.filter((e) => e.seq === 3)); // newest batch lands first
    await applyBatch(entries.filter((e) => e.seq < 3)); // older batch arrives afterwards (e.g. reclaimed from a dead flusher)
    expect(await pgAuction(a)).toMatchObject({ current_price: '130', bid_count: '3' });
    expect(await pgBidCount(a)).toBe(3);
    await flusher.drain();
  });

  it('entries read by a flusher that died are picked up by another one', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller);
    await bid(a, b1, 150);
    await bid(a, b1, 160);

    // A "ghost" flusher reads the entries and dies without acknowledging them.
    const got = (await stateRedis.xreadgroup('GROUP', GROUP, 'ghost', 'COUNT', 1000, 'STREAMS', STREAM, '>')) as unknown[];
    expect(got).not.toBeNull();
    expect(await pgBidCount(a)).toBe(0);

    await flusher.drain(); // takes over the ghost's unacknowledged entries
    expect(await pgBidCount(a)).toBe(2);
    expect(await pgAuction(a)).toMatchObject({ current_price: '160', bid_count: '2' });
    expect(await stateRedis.xlen(STREAM)).toBe(0);
  });

  it('if Redis lost the live state, it is rebuilt from Postgres and bidding continues with the right seq', async () => {
    const [seller, b1, b2] = await users(3);
    const a = await auction(seller);
    await bid(a, b1, 150);
    await flusher.drain(); // Postgres is now up to date
    await stateRedis.del(stateKey(a)); // simulate losing the state hash

    const low = await bid(a, b2, 150);
    expect(low.statusCode).toBe(409);
    expect(low.json().message).toBe('bid must be at least 151');
    const ok = await bid(a, b2, 151);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().seq).toBe('2');
    await flusher.drain();
    expect(await pgBidCount(a)).toBe(2);
  });

  it('every accepted bid in a concurrent burst ends up in Postgres exactly once', async () => {
    const [seller, ...bidders] = await users(41);
    const a = await auction(seller);
    const amounts = Array.from({ length: 40 }, (_, i) => 101 + i).sort(() => Math.random() - 0.5);
    const results = await Promise.all(amounts.map((amt, i) => bid(a, bidders[i], amt)));
    const accepted = results.filter((r) => r.statusCode === 201).length;
    expect(results.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);

    await flusher.drain();
    expect(await pgBidCount(a)).toBe(accepted);
    const { rows } = await pool.query('SELECT seq FROM bids WHERE auction_id=$1 ORDER BY seq', [a]);
    expect(rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: accepted }, (_, i) => i + 1));
    expect(await pgAuction(a)).toMatchObject({ current_price: '140', bid_count: String(accepted) });
  });
});
