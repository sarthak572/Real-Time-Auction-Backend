import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger, throttle } from './logger.js';
import { pool } from './db.js';
import { AppError } from './errors.js';

/**
 * Live auction state for write-behind bidding.
 *
 *   auction:<id>:state   hash  status, seller, starting, price, bidder, seq, ends   (the authority while the auction is live)
 *   bids:stream          stream one entry per accepted bid, waiting for the flusher to write it to Postgres
 *
 * This is a DIFFERENT Redis from the cache (docker-compose service `redis-state`): it persists to disk
 * and never evicts, because a lost key here is a lost bid that was already acknowledged to a user.
 */
export const STREAM = 'bids:stream';
export const GROUP = 'flusher';
export const FLUSHER_STATS = 'flusher:stats';
export const stateKey = (auctionId: number) => `auction:${auctionId}:state`;
const KEEP_AFTER_END_MS = 24 * 3600 * 1000;

export const stateRedis = new Redis(config.STATE_REDIS_URL, {
  maxRetriesPerRequest: 1, // fail fast; bids are refused (never written elsewhere) while this is down
  enableOfflineQueue: false,
  connectTimeout: 2_000,
});
stateRedis.on('error', (err) => logger.error({ event: 'state_redis.error', err: err.message }, 'state redis error'));

/** Last known memory use of the state Redis (refreshed every 5 s while startMemoryWatch() is running). */
export const stateMemory = { used: 0, max: 0 };
let memoryTimer: NodeJS.Timeout | null = null;
export function startMemoryWatch() {
  if (memoryTimer) return;
  const read = async () => {
    try {
      const info = await stateRedis.info('memory');
      const num = (name: string) => Number(new RegExp(`${name}:(\\d+)`).exec(info)?.[1] ?? 0);
      stateMemory.used = num('used_memory');
      stateMemory.max = num('maxmemory');
    } catch {
      // keep the last reading
    }
  };
  // The app is built before the Redis connection is up, so a read right now would fail and the next one is 5 s away.
  if (stateRedis.status === 'ready') void read();
  else stateRedis.once('ready', () => void read());
  memoryTimer = setInterval(read, 5000);
  memoryTimer.unref();
}

export function waitStateReady(): Promise<void> {
  if (stateRedis.status === 'ready') return Promise.resolve();
  return new Promise((resolve) => stateRedis.once('ready', () => resolve()));
}

/**
 * Atomic bid check + apply. A Lua script runs on Redis's single thread with nothing interleaved, so there is
 * no lock and no waiting: two bids can never both win against the same price.
 * KEYS: state hash, stream, idempotency key.  ARGV: auctionId, bidderId, amount, maxBacklog, request fingerprint ('' = no key), key TTL seconds.
 * Returns {'OK', seq, tsMs} | {'NOT_LOADED'} | {'AUCTION_CLOSED'} | {'SELF_BID'} | {'BID_TOO_LOW', min} | {'BACKLOG'}
 * | {'REPLAY', <the earlier answer as JSON>} | {'KEY_REUSED'}.
 */
const PLACE_BID = `
-- Idempotency: if this key was already used, answer exactly as before (or refuse if the request is different).
local useIdem = ARGV[5] ~= ''
if useIdem then
  local prev = redis.call('GET', KEYS[3])
  if prev then
    local sep = string.find(prev, '|', 1, true)
    if string.sub(prev, 1, sep - 1) ~= ARGV[5] then return {'KEY_REUSED'} end
    return {'REPLAY', string.sub(prev, sep + 1)}
  end
end

-- Remember a definitive answer under the key. Temporary problems (not loaded yet, backlog full) are NOT remembered,
-- so the client can retry them with the same key.
local function done(res)
  if useIdem then
    redis.call('SET', KEYS[3], ARGV[5] .. '|' .. cjson.encode(res), 'EX', ARGV[6])
  end
  return res
end

local s = redis.call('HMGET', KEYS[1], 'status', 'seller', 'starting', 'price', 'seq', 'ends')
if not s[1] then return {'NOT_LOADED'} end
local t = redis.call('TIME')
local nowMs = t[1] * 1000 + math.floor(t[2] / 1000)
if s[1] ~= 'active' or nowMs >= tonumber(s[6]) then return done({'AUCTION_CLOSED'}) end
if s[2] == ARGV[2] then return done({'SELF_BID'}) end
local seq = tonumber(s[5])
local min = tonumber(s[3])
if seq > 0 then min = tonumber(s[4]) + 1 end
local amount = tonumber(ARGV[3])
if amount < min then return done({'BID_TOO_LOW', min}) end
if redis.call('XLEN', KEYS[2]) >= tonumber(ARGV[4]) then return {'BACKLOG'} end
seq = seq + 1
redis.call('HSET', KEYS[1], 'price', ARGV[3], 'bidder', ARGV[2], 'seq', seq)
redis.call('XADD', KEYS[2], '*', 'a', ARGV[1], 'b', ARGV[2], 'm', ARGV[3], 's', seq, 't', nowMs)
redis.call('PEXPIREAT', KEYS[1], tonumber(s[6]) + ${KEEP_AFTER_END_MS})
-- Tell live viewers in the SAME atomic step: the event exists if and only if the bid was accepted (no crash window).
if ARGV[8] == '1' then
  redis.call('PUBLISH', 'auction:' .. ARGV[1] .. ':events', '{"type":"bid","auctionId":' .. ARGV[1] .. ',"bidderId":' .. ARGV[2] .. ',"amount":' .. ARGV[3] .. ',"seq":' .. seq .. ',"at":"' .. ARGV[7] .. '"}')
end
return done({'OK', seq, nowMs})`;

/** Copy an auction from Postgres into Redis, only if Redis does not already have it (never overwrite newer state). */
const LOAD_STATE = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'seller', ARGV[2], 'starting', ARGV[3], 'price', ARGV[4], 'bidder', ARGV[5], 'seq', ARGV[6], 'ends', ARGV[7])
redis.call('PEXPIREAT', KEYS[1], tonumber(ARGV[7]) + ${KEEP_AFTER_END_MS})
return 1`;

stateRedis.defineCommand('placeBidLua', { numberOfKeys: 3, lua: PLACE_BID });

// ---- batching: bids that arrive in the same event-loop turn share one pipelined write to Redis ----
type Reply = (string | number)[];
type Pending = { args: (string | number)[]; resolve: (r: Reply) => void; reject: (e: unknown) => void };
let queue: Pending[] = [];
let flushScheduled = false;

async function flushQueue() {
  const batch = queue;
  queue = [];
  flushScheduled = false;
  try {
    const pipe = stateRedis.pipeline();
    for (const p of batch) (pipe as unknown as { placeBidLua(...a: (string | number)[]): unknown }).placeBidLua(...p.args);
    const results = (await pipe.exec()) ?? [];
    batch.forEach((p, i) => {
      const [err, res] = results[i] ?? [new Error('no reply'), null];
      if (err) p.reject(err);
      else p.resolve(res as Reply);
    });
  } catch (err) {
    batch.forEach((p) => p.reject(err));
  }
}

/** Run the bid script. Each command still runs on its own, in order, and atomically; only the network write is shared. */
function runBidScript(args: (string | number)[]): Promise<Reply> {
  if (config.BID_BATCH === 'false') return lua.placeBidLua(...args);
  return new Promise((resolve, reject) => {
    queue.push({ args, resolve, reject });
    if (!flushScheduled) {
      flushScheduled = true;
      setImmediate(flushQueue); // runs after every request read in this turn has queued its bid
    }
  });
}
stateRedis.defineCommand('loadStateLua', { numberOfKeys: 1, lua: LOAD_STATE });
const lua = stateRedis as unknown as {
  placeBidLua(...args: (string | number)[]): Promise<(string | number)[]>;
  loadStateLua(...args: (string | number)[]): Promise<number>;
};

async function loadState(auctionId: number): Promise<void> {
  const { rows } = await pool.query(
    `SELECT seller_id, status, starting_price, current_price, highest_bidder, bid_count,
            (extract(epoch from ends_at) * 1000)::bigint AS ends_ms
       FROM auctions WHERE id = $1`,
    [auctionId],
  );
  const a = rows[0];
  if (!a) throw new AppError(404, 'AUCTION_NOT_FOUND', 'auction not found');
  await lua.loadStateLua(
    stateKey(auctionId), a.status, a.seller_id, a.starting_price, a.current_price,
    a.highest_bidder ?? '', a.bid_count, a.ends_ms,
  );
}

export interface PlacedBid {
  seq: number;
  at: Date;
  replayed: boolean; // true when this is the stored answer to an earlier request with the same Idempotency-Key
}

/**
 * @param idempotencyKey optional client-chosen key. A retry with the same key, bidder and request returns the original
 *   answer without placing a second bid; the same key with a different request is refused (422).
 */
export async function placeBidInRedis(
  auctionId: number,
  bidderId: number,
  amount: number,
  idempotencyKey?: string,
): Promise<PlacedBid> {
  // Memory guard: refuse to create new keys when the (never-evicting) Redis is nearly full. An existing key is still
  // honoured by the script, but we cannot tell here whether it exists, so every keyed request waits until there is room.
  if (idempotencyKey && stateMemory.max > 0 && stateMemory.used / stateMemory.max > config.IDEMPOTENCY_MEMORY_LIMIT) {
    throw new AppError(503, 'IDEMPOTENCY_STORE_FULL', 'idempotency keys are temporarily not accepted, retry shortly or send without a key');
  }
  // The key is scoped to the bidder (two bidders may use the same string); the fingerprint is what must match on a retry.
  const keyName = idempotencyKey ? `idem:${bidderId}:${idempotencyKey}` : 'idem:none';
  const fingerprint = idempotencyKey ? `${auctionId}:${amount}` : '';
  const run = async () => {
    try {
      return await runBidScript([
        stateKey(auctionId), STREAM, keyName, auctionId, bidderId, amount, config.WB_MAX_BACKLOG, fingerprint, config.IDEMPOTENCY_TTL_SECONDS,
        new Date().toISOString(), config.PUBLISH_IN_SCRIPT === 'true' ? '1' : '0',
      ]);
    } catch (err) {
      // Never fall back to writing Postgres directly: that would create two competing authorities.
      // During an outage every bid would log this; once a second is enough (the counter says how many were skipped).
      const skipped = throttle('bid.store_unavailable');
      if (skipped !== null) logger.error({ event: 'bid.store_unavailable', err: (err as Error).message, suppressed: skipped }, 'state redis unavailable');
      throw new AppError(503, 'BID_STORE_UNAVAILABLE', 'bidding is temporarily unavailable');
    }
  };

  let r = await run();
  if (r[0] === 'NOT_LOADED') {
    await loadState(auctionId); // first bid since Redis started tracking this auction
    r = await run();
  }

  if (r[0] === 'KEY_REUSED') {
    throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'this Idempotency-Key was already used for a different request');
  }
  // A replay carries the earlier answer as JSON; handle it exactly like the original answer, flagged as a replay.
  const replayed = r[0] === 'REPLAY';
  if (replayed) r = JSON.parse(String(r[1])) as (string | number)[];

  switch (r[0]) {
    case 'OK':
      return { seq: Number(r[1]), at: new Date(Number(r[2])), replayed };
    case 'AUCTION_CLOSED':
      throw new AppError(409, 'AUCTION_CLOSED', 'auction has ended', replayed);
    case 'SELF_BID':
      throw new AppError(403, 'SELF_BID', 'seller cannot bid on own auction', replayed);
    case 'BID_TOO_LOW':
      throw new AppError(409, 'BID_TOO_LOW', `bid must be at least ${r[1]}`, replayed);
    case 'BACKLOG':
      throw new AppError(503, 'FLUSHER_BEHIND', 'too many bids are waiting to be saved, try again shortly');
    default:
      throw new AppError(503, 'BID_STORE_UNAVAILABLE', 'bidding is temporarily unavailable');
  }
}

/** Live fields of an auction, or null if Redis is not tracking it. Used to overlay fresh values on reads. */
export async function readLiveState(auctionId: number) {
  const [price, bidder, seq, status] = await stateRedis.hmget(stateKey(auctionId), 'price', 'bidder', 'seq', 'status');
  if (price === null || seq === null || status === null) return null;
  return { current_price: price, highest_bidder: bidder === '' ? null : bidder, bid_count: seq, status };
}

export async function writeBehindStats() {
  try {
    const [len, stats] = await Promise.all([stateRedis.xlen(STREAM), stateRedis.hgetall(FLUSHER_STATS)]);
    const heartbeat = Number(stats.heartbeat ?? 0);
    return {
      streamLength: len,
      flusherAlive: heartbeat > 0 && Date.now() - heartbeat < 3000,
      lastBatch: Number(stats.lastBatch ?? 0),
      lastLagMs: Number(stats.lastLagMs ?? 0),
      maxLagMs: Number(stats.maxLagMs ?? 0),
      flushedTotal: Number(stats.flushedTotal ?? 0),
      failedTotal: Number(stats.failedTotal ?? 0),
      conflictTotal: Number(stats.conflictTotal ?? 0),
    };
  } catch {
    return { error: 'state redis unreachable' };
  }
}
