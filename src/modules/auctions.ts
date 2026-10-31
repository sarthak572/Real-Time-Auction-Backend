import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { AppError } from '../errors.js';
import { cached, invalidate, auctionKey, listKey } from '../cache.js';
import { config } from '../config.js';
import { getAuction } from './auction-queries.js';
import { hub } from '../realtime/hub.js';
import { sampled } from '../logger.js';
import { bidsTotal, bidDecisionDuration, bidResultOf } from '../metrics.js';
import { placeBid } from './bids.js';

const createSchema = z.object({
  sellerId: z.number().int().positive(),
  title: z.string().min(1).max(200),
  startingPrice: z.number().int().positive(),
  durationSeconds: z.number().int().min(10).max(7 * 24 * 3600),
});

const bidSchema = z.object({
  bidderId: z.number().int().positive(),
  amount: z.number().int().positive(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

// Optional header. Letters, digits and _ - : . only, so it is safe to use inside a Redis key.
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_:.-]{1,128}$/, 'Idempotency-Key must be 1-128 characters: letters, digits, _ - : .').optional();

export async function auctionRoutes(app: FastifyInstance) {
  app.post('/auctions', async (req, reply) => {
    const b = createSchema.parse(req.body);
    const { rows } = await pool.query(
      `INSERT INTO auctions(seller_id, title, starting_price, current_price, ends_at)
       VALUES($1,$2,$3,$3, now() + make_interval(secs => $4)) RETURNING *`,
      [b.sellerId, b.title, b.startingPrice, b.durationSeconds],
    );
    req.log.info({ event: 'auction.created', auctionId: rows[0].id, sellerId: b.sellerId }, 'auction created');
    return reply.code(201).send(rows[0]);
  });

  app.get('/auctions', async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
    // Short TTL only: the list changes whenever any auction gets a bid, so we accept slight staleness here.
    return cached(
      listKey(limit),
      config.LIST_CACHE_TTL_SECONDS,
      async () =>
        (
          await pool.query(
            `SELECT * FROM auctions WHERE status='active' AND ends_at > now() ORDER BY ends_at LIMIT $1`,
            [limit],
          )
        ).rows,
      req.log,
    );
  });

  app.get('/auctions/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const auction = await getAuction(id, req.log);
    if (!auction) throw new AppError(404, 'AUCTION_NOT_FOUND', 'auction not found');
    return auction;
  });

  app.post('/auctions/:id/bids', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { bidderId, amount } = bidSchema.parse(req.body);
    const idempotencyKey = idempotencyKeySchema.parse(req.headers['idempotency-key']);
    const started = process.hrtime.bigint();

    try {
      const decisionTimer = bidDecisionDuration.startTimer();
      let bid;
      try {
        bid = await placeBid(id, bidderId, amount, idempotencyKey);
      } finally {
        decisionTimer(); // time spent deciding, whether the bid was accepted or refused
      }
      if (bid.replayed) {
        // A retry of a bid we already accepted: same answer, no second bid, no second event to viewers.
        bidsTotal.inc({ result: 'replayed' });
        reply.header('idempotent-replayed', 'true');
        const { replayed: _replayed, ...stored } = bid;
        return reply.code(201).send(stored);
      }
      bidsTotal.inc({ result: 'accepted' });
      // Postgres has committed. Order matters:
      // 1) drop the stale cache entry, so anyone who reacts to the event reads fresh data;
      // 2) then tell every viewer (on every server instance) through Redis pub/sub.
      // (write-behind reads overlay live state from Redis, so there is nothing stale to invalidate)
      if (config.BID_IMPL !== 'redis') await invalidate(auctionKey(id));
      if (config.BID_IMPL === 'redis' && config.PUBLISH_IN_SCRIPT === 'true') {
        hub.counters.published++; // the bid script already published it
      } else await hub.publishBid({
        type: 'bid',
        auctionId: id,
        bidId: bid.id === null ? undefined : Number(bid.id),
        bidderId,
        amount,
        seq: Number(bid.seq),
        at: new Date(bid.created_at).toISOString(),
      });
      // Routine and high-volume: log a sample. sampleRate lets a reader multiply counts back up.
      if (sampled()) {
        req.log.info(
          { event: 'bid.accepted', auctionId: id, bidderId, amount, bidId: bid.id, seq: bid.seq, durationMs: elapsed(started), sampleRate: config.LOG_SAMPLE_RATE },
          'bid accepted',
        );
      }
      const { replayed: _fresh, ...body } = bid; // `replayed` is internal bookkeeping, not part of the API response
      return reply.code(201).send(body);
    } catch (err) {
      bidsTotal.inc({ result: err instanceof AppError ? (err.replayed ? 'replayed' : bidResultOf(err.code)) : 'error' });
      if (err instanceof AppError) {
        // 'too low' and 'ended' are everyday answers on a busy auction, so they are sampled; anything else is logged every time.
        const routine = err.code === 'BID_TOO_LOW' || err.code === 'AUCTION_CLOSED';
        if (!routine || sampled()) {
          req.log.warn(
            { event: 'bid.rejected', auctionId: id, bidderId, amount, reason: err.code, durationMs: elapsed(started), ...(routine && { sampleRate: config.LOG_SAMPLE_RATE }) },
            'bid rejected',
          );
        }
      }
      throw err;
    }
  });
}

const elapsed = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;
