import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1, // fail fast when Redis is down; we fall back to Postgres
  enableOfflineQueue: false, // don't buffer commands in memory while disconnected
  connectTimeout: 2_000,
});
redis.on('error', (err) => logger.error({ event: 'redis.error', err: err.message }, 'redis error'));

// Counters for /health/stats (replaced by Prometheus counters in Phase 7).
export const cacheStats = { hits: 0, misses: 0, errors: 0, coalesced: 0 };

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Cache-aside read: Redis first, loader (Postgres) on a miss, then store with a TTL.
 * - Redis failure never fails the request: we fall back to the loader ("fail open").
 * - Concurrent misses for the same key share ONE loader call (stops a cache stampede
 *   from sending thousands of identical queries to Postgres when a hot key expires).
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T | undefined>,
  log: { debug: (o: object, m: string) => void },
): Promise<T | undefined> {
  try {
    const hit = await redis.get(key);
    if (hit !== null) {
      cacheStats.hits++;
      log.debug({ event: 'cache.hit', key }, 'cache hit');
      return JSON.parse(hit) as T;
    }
  } catch (err) {
    cacheStats.errors++;
    log.debug({ event: 'cache.error', key, op: 'get', err: (err as Error).message }, 'cache read failed');
  }

  cacheStats.misses++;
  log.debug({ event: 'cache.miss', key }, 'cache miss');

  const pending = inFlight.get(key);
  if (pending) {
    cacheStats.coalesced++;
    return pending as Promise<T | undefined>;
  }

  const p = (async () => {
    const value = await loader();
    if (value !== undefined) {
      try {
        await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      } catch (err) {
        cacheStats.errors++;
        log.debug({ event: 'cache.error', key, op: 'set', err: (err as Error).message }, 'cache write failed');
      }
    }
    return value;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, p);
  return p;
}

/** Drop a key after the database changed. Failures are logged; the TTL is the safety net. */
export async function invalidate(key: string): Promise<void> {
  try {
    await redis.del(key);
    logger.debug({ event: 'cache.invalidated', key }, 'cache invalidated');
  } catch (err) {
    cacheStats.errors++;
    logger.warn({ event: 'cache.invalidate_failed', key, err: (err as Error).message }, 'cache invalidation failed');
  }
}

export const auctionKey = (id: number) => `auction:${id}`;
export const listKey = (limit: number) => `auctions:active:${limit}`;
