import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './db.js';
import { stateRedis, STREAM, GROUP, FLUSHER_STATS } from './state.js';
import client from 'prom-client';
import { registry } from './metrics.js';

const flushedBids = new client.Counter({ name: 'flusher_bids_total', help: 'Bids saved to Postgres', registers: [registry] });
const flushFailures = new client.Counter({ name: 'flusher_failures_total', help: 'Flush attempts that failed (entries stay pending and are retried)', registers: [registry] });
const flushConflicts = new client.Counter({ name: 'flusher_conflicts_total', help: 'Bids that clashed with a DIFFERENT bid already in Postgres under the same sequence number', registers: [registry] });
const batchSize = new client.Histogram({ name: 'flusher_batch_size', help: 'Bids per flush', buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000], registers: [registry] });
const flushDuration = new client.Histogram({ name: 'flusher_flush_duration_seconds', help: 'Time to read, save and acknowledge one batch', buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], registers: [registry] });
const lagSeconds = new client.Gauge({ name: 'flusher_lag_seconds', help: 'Age of the oldest bid in the last batch when it was saved', registers: [registry] });
const lastFlush = new client.Gauge({ name: 'flusher_last_flush_timestamp_seconds', help: 'When the flusher last completed a loop (a heartbeat; stale means dead or stuck)', registers: [registry] });

/** One accepted bid, as stored in the Redis stream. */
export interface StreamBid {
  streamId: string;
  auctionId: number;
  bidderId: number;
  amount: number;
  seq: number;
  ts: number; // ms, taken from the Redis clock when the bid was accepted
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parse(entries: [string, string[]][]): StreamBid[] {
  return entries.map(([streamId, f]) => {
    const m: Record<string, string> = {};
    for (let i = 0; i < f.length; i += 2) m[f[i]] = f[i + 1];
    return { streamId, auctionId: Number(m.a), bidderId: Number(m.b), amount: Number(m.m), seq: Number(m.s), ts: Number(m.t) };
  });
}

/**
 * Writes a batch to Postgres in ONE statement. Safe to run any number of times with the same bids:
 *  - bids: ON CONFLICT (auction_id, seq) DO NOTHING, so a replayed bid is ignored
 *  - auctions: only moves forward (bid_count < seq), so a late or replayed batch cannot roll an auction back
 * That makes "write to Postgres, then crash before acknowledging" harmless: the batch is simply processed again.
 */
export async function applyBatch(bids: StreamBid[]): Promise<number> {
  if (bids.length === 0) return 0;
  const params = [
    bids.map((b) => b.auctionId),
    bids.map((b) => b.bidderId),
    bids.map((b) => b.amount),
    bids.map((b) => b.seq),
    bids.map((b) => new Date(b.ts).toISOString()),
  ];
  await pool.query(
    `WITH data AS (
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::bigint[], $5::timestamptz[])
         AS t(auction_id, bidder_id, amount, seq, created_at)
     ), ins AS (
       INSERT INTO bids (auction_id, bidder_id, amount, seq, created_at)
       SELECT auction_id, bidder_id, amount, seq, created_at FROM data
       ON CONFLICT (auction_id, seq) DO NOTHING
       RETURNING 1
     ), latest AS (
       SELECT DISTINCT ON (auction_id) auction_id, bidder_id, amount, seq FROM data ORDER BY auction_id, seq DESC
     )
     UPDATE auctions a
        SET current_price = l.amount, highest_bidder = l.bidder_id, bid_count = l.seq
       FROM latest l
      WHERE a.id = l.auction_id AND a.bid_count < l.seq`,
    params,
  );

  // ON CONFLICT DO NOTHING is right for a replayed bid, but it would also silently drop a DIFFERENT bid that
  // reuses a seq Postgres already holds. That can only happen if Redis lost recent writes while Postgres kept them.
  // Count those so the loss is loud instead of silent.
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::bigint[]) AS t(auction_id, bidder_id, amount, seq)
       JOIN bids b ON b.auction_id = t.auction_id AND b.seq = t.seq
      WHERE b.amount <> t.amount OR b.bidder_id <> t.bidder_id`,
    params.slice(0, 4),
  );
  return rows[0].n as number;
}

export class Flusher {
  private stopped = false;
  private loopDone: Promise<void> | null = null;

  constructor(private consumer = `flusher-${process.pid}`) {}

  /** Create the consumer group (and the stream if the API has not written to it yet). */
  async init() {
    try {
      await stateRedis.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if (!String(err).includes('BUSYGROUP')) throw err; // group already exists: fine
    }
  }

  start() {
    this.stopped = false;
    this.loopDone = this.loop();
  }

  /** Stop after the batch in progress, then flush what is left so a clean shutdown leaves nothing behind. */
  async stop() {
    this.stopped = true;
    await this.loopDone;
    await this.drain();
  }

  private async loop() {
    while (!this.stopped) {
      let n = 0;
      try {
        n = await this.flushOnce();
      } catch (err) {
        flushFailures.inc();
        await stateRedis.hincrby(FLUSHER_STATS, 'failedTotal', 1).catch(() => undefined);
        logger.error({ event: 'flush.failed', err: (err as Error).message }, 'flush failed, entries stay pending and are retried');
      }
      if (n < config.FLUSH_BATCH_SIZE) await sleep(config.FLUSH_INTERVAL_MS); // a full batch means there is more: keep going
    }
  }

  /**
   * One flush: take entries (first any a dead flusher left unacknowledged, then new ones), write them to
   * Postgres, then acknowledge and delete them from the stream. Returns how many entries were handled.
   */
  async flushOnce(opts: { claimIdleMs?: number } = {}): Promise<number> {
    const started = Date.now();
    const max = config.FLUSH_BATCH_SIZE;
    const claimIdle = opts.claimIdleMs ?? config.FLUSH_RECLAIM_IDLE_MS;

    const claimed = (await stateRedis.xautoclaim(STREAM, GROUP, this.consumer, claimIdle, '0-0', 'COUNT', max)) as unknown as [
      string,
      [string, string[]][],
    ];
    let entries = claimed[1] ?? [];
    if (entries.length < max) {
      const res = (await stateRedis.xreadgroup('GROUP', GROUP, this.consumer, 'COUNT', max - entries.length, 'STREAMS', STREAM, '>')) as
        | [string, [string, string[]][]][]
        | null;
      if (res) entries = entries.concat(res[0][1]);
    }

    await stateRedis.hset(FLUSHER_STATS, 'heartbeat', Date.now());
    lastFlush.set(Date.now() / 1000);
    if (entries.length === 0) return 0;

    const bids = parse(entries);
    const conflicts = await applyBatch(bids); // throws on failure: nothing is acknowledged, so the entries are retried
    if (conflicts > 0) {
      flushConflicts.inc(conflicts);
      await stateRedis.hincrby(FLUSHER_STATS, 'conflictTotal', conflicts).catch(() => undefined);
      logger.error({ event: 'flush.conflict', conflicts }, 'bids conflict with different bids already in postgres: acknowledged bids were NOT saved');
    }
    const ids = bids.map((b) => b.streamId);
    await stateRedis.multi().xack(STREAM, GROUP, ...ids).xdel(STREAM, ...ids).exec();

    const lagMs = Date.now() - Math.min(...bids.map((b) => b.ts));
    flushedBids.inc(bids.length);
    batchSize.observe(bids.length);
    flushDuration.observe((Date.now() - started) / 1000);
    lagSeconds.set(lagMs / 1000);
    const tx = stateRedis.multi();
    tx.hset(FLUSHER_STATS, 'lastBatch', bids.length, 'lastLagMs', lagMs);
    tx.hincrby(FLUSHER_STATS, 'flushedTotal', bids.length);
    await tx.exec();
    const max0 = Number((await stateRedis.hget(FLUSHER_STATS, 'maxLagMs')) ?? 0);
    if (lagMs > max0) await stateRedis.hset(FLUSHER_STATS, 'maxLagMs', lagMs);

    logger.info(
      { event: 'flush.completed', batch: bids.length, auctions: new Set(bids.map((b) => b.auctionId)).size, durationMs: Date.now() - started, lagMs },
      'flushed bids to postgres',
    );
    return bids.length;
  }

  /** Flush until nothing is left (also takes over entries other flushers have read but not acknowledged). */
  async drain() {
    for (let i = 0; i < 10_000; i++) {
      const n = await this.flushOnce({ claimIdleMs: 0 });
      if (n === 0 && (await stateRedis.xlen(STREAM)) === 0) return;
    }
  }
}
