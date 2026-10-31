// Idempotency-Key on POST /auctions/:id/bids (write-behind path only).
// The promise: a client that retries a request (timeout, dropped connection, double click) with the same key
// gets the SAME answer back and never causes a second bid.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { redis } from '../src/cache.js';
import { config } from '../src/config.js';
import { stateRedis, waitStateReady } from '../src/state.js';
import { Flusher } from '../src/flusher.js';
import { Redis } from 'ioredis';

const enabled = config.BID_IMPL === 'redis';
let app: FastifyInstance;
const flusher = new Flusher('idem-test-flusher');

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  await waitStateReady();
  await flusher.init();
  await flusher.drain();
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await redis.quit();
  await stateRedis.quit();
});

async function users(n: number): Promise<number[]> {
  const { rows } = await pool.query(`INSERT INTO users(name) SELECT 'idem-' || g FROM generate_series(1, $1) g RETURNING id`, [n]);
  return rows.map((r) => Number(r.id));
}
async function auction(sellerId: number, startingPrice = 100): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO auctions(seller_id, title, starting_price, current_price, ends_at)
     VALUES($1,'idem',$2,$2, now() + interval '10 minutes') RETURNING id`,
    [sellerId, startingPrice],
  );
  return Number(rows[0].id);
}
const bid = (auctionId: number, bidderId: number, amount: number, key?: string) =>
  app.inject({
    method: 'POST',
    url: `/auctions/${auctionId}/bids`,
    payload: { bidderId, amount },
    headers: key ? { 'idempotency-key': key } : {},
  });
const bidCount = async (id: number) => Number((await pool.query('SELECT count(*) FROM bids WHERE auction_id=$1', [id])).rows[0].count);

describe.skipIf(!enabled)('Idempotency-Key on bids', () => {
  it('a retry with the same key returns the same answer and does not place a second bid', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller);
    const key = randomUUID();

    const first = await bid(a, b1, 150, key);
    const retry = await bid(a, b1, 150, key);

    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(first.json()); // identical body, including seq and timestamp

    await flusher.drain();
    expect(await bidCount(a)).toBe(1);
    expect((await app.inject({ method: 'GET', url: `/auctions/${a}` })).json().bid_count).toBe('1');
  });

  it('a retry does not send a second event to viewers', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller);
    const key = randomUUID();
    // Listen on the real channel, the way a live viewer's server does.
    const listener = new Redis(config.PUBSUB_URL);
    const seen: string[] = [];
    listener.on('message', (_c, m) => seen.push(m));
    await listener.subscribe(`auction:${a}:events`);

    await bid(a, b1, 150, key);
    await bid(a, b1, 150, key);
    await bid(a, b1, 150, key);
    await new Promise((r) => setTimeout(r, 300));
    await listener.quit();

    expect(seen).toHaveLength(1); // three requests, one event
    expect(JSON.parse(seen[0])).toMatchObject({ type: 'bid', auctionId: a, bidderId: b1, amount: 150, seq: 1 });
  });

  it('the same key with a different request is refused, and nothing is changed', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller);
    const key = randomUUID();
    expect((await bid(a, b1, 150, key)).statusCode).toBe(201);

    const different = await bid(a, b1, 999, key); // same key, other amount
    expect(different.statusCode).toBe(422);
    expect(different.json().error).toBe('IDEMPOTENCY_KEY_REUSED');

    await flusher.drain();
    expect(await bidCount(a)).toBe(1);
    expect((await app.inject({ method: 'GET', url: `/auctions/${a}` })).json().current_price).toBe('150');
  });

  it('a refusal is remembered too: retrying a too-low bid gives the same 409, flagged as a replay', async () => {
    const [seller, b1, b2] = await users(3);
    const a = await auction(seller);
    await bid(a, b1, 200);
    const key = randomUUID();

    const first = await bid(a, b2, 150, key);
    expect(first.statusCode).toBe(409);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    // Even after the price moves on, the retry gets the original answer for that original request.
    await bid(a, b1, 300);
    const retry = await bid(a, b2, 150, key);
    expect(retry.statusCode).toBe(409);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(first.json());
  });

  it('20 simultaneous copies of one request produce exactly one bid', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller);
    const key = randomUUID();

    const results = await Promise.all(Array.from({ length: 20 }, () => bid(a, b1, 150, key)));

    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(results.map((r) => r.json().seq)).size).toBe(1); // everyone was told the same sequence number
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(19);

    await flusher.drain();
    expect(await bidCount(a)).toBe(1);
  });

  it('keys belong to the bidder: two bidders can use the same key string', async () => {
    const [seller, b1, b2] = await users(3);
    const a = await auction(seller);
    const key = 'checkout-1';
    const r1 = await bid(a, b1, 150, key);
    const r2 = await bid(a, b2, 160, key);
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBeUndefined();
    expect(r2.json().seq).toBe('2');
  });

  it('without a key nothing is remembered: sending the same bid twice is two attempts', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller);
    expect((await bid(a, b1, 150)).statusCode).toBe(201);
    const second = await bid(a, b1, 150);
    expect(second.statusCode).toBe(409); // a normal decision: 150 no longer beats 150
    expect(second.headers['idempotent-replayed']).toBeUndefined();
  });

  it('rejects a malformed key with 400 before touching any state', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller);
    for (const bad of ['has space', 'x'.repeat(129), 'semi;colon']) {
      const res = await bid(a, b1, 150, bad);
      expect(res.statusCode).toBe(400);
    }
    expect(await bidCount(a)).toBe(0);
  });

  it('keys expire, so they cannot pile up in the state Redis forever', async () => {
    const [seller, b1] = await users(2);
    const a = await auction(seller);
    const key = randomUUID();
    await bid(a, b1, 150, key);
    const ttl = await stateRedis.ttl(`idem:${b1}:${key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(config.IDEMPOTENCY_TTL_SECONDS);
  });
});
