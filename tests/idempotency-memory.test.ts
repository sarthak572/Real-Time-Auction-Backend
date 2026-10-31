// The never-evicting state Redis must not be filled up by Idempotency-Keys.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { redis } from '../src/cache.js';
import { config } from '../src/config.js';
import { stateRedis, stateMemory, startMemoryWatch, waitStateReady } from '../src/state.js';
import { Flusher } from '../src/flusher.js';

const enabled = config.BID_IMPL === 'redis';
let app: FastifyInstance;
const flusher = new Flusher('idem-mem-flusher');

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

async function twoUsers() {
  const { rows } = await pool.query(`INSERT INTO users(name) SELECT 'mem-' || g FROM generate_series(1, 3) g RETURNING id`);
  return rows.map((r) => Number(r.id));
}

describe.skipIf(!enabled)('memory guard for Idempotency-Keys', () => {
  it('reads the real memory use and limit of the state Redis', async () => {
    startMemoryWatch();
    await new Promise((r) => setTimeout(r, 400));
    expect(stateMemory.used).toBeGreaterThan(1_000_000); // an empty Redis already uses more than 1 MB
    expect(stateMemory.max).toBeGreaterThan(stateMemory.used); // the compose file sets a 512 MB limit
  });

  it('when the Redis is nearly full, keyed bids are refused with 503 but plain bids still work', async () => {
    const [seller, bidder] = await twoUsers();
    const { rows } = await pool.query(
      `INSERT INTO auctions(seller_id, title, starting_price, current_price, ends_at)
       VALUES($1,'mem',100,100, now() + interval '10 minutes') RETURNING id`,
      [seller],
    );
    const a = Number(rows[0].id);
    const real = { ...stateMemory };
    try {
      stateMemory.used = Math.round(stateMemory.max * 0.95); // pretend it is 95% full

      const keyed = await app.inject({
        method: 'POST', url: `/auctions/${a}/bids`, payload: { bidderId: bidder, amount: 150 }, headers: { 'idempotency-key': 'full-1' },
      });
      expect(keyed.statusCode).toBe(503);
      expect(keyed.json().error).toBe('IDEMPOTENCY_STORE_FULL');

      const plain = await app.inject({ method: 'POST', url: `/auctions/${a}/bids`, payload: { bidderId: bidder, amount: 150 } });
      expect(plain.statusCode).toBe(201); // the guard protects bidding, it does not stop it
    } finally {
      Object.assign(stateMemory, real);
    }
    await flusher.drain();
  });
});
