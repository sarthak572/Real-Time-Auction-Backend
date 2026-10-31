import { pool, withTx } from '../db.js';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import { placeBidInRedis } from '../state.js';

export interface BidRow {
  id: string | null; // null for write-behind bids: Postgres assigns the id later, when the flusher saves the bid
  auction_id: string;
  bidder_id: string;
  amount: string;
  seq: string;
  created_at: Date;
  replayed?: boolean; // write-behind only: this is a stored answer to a retried request
}

export function placeBid(auctionId: number, bidderId: number, amount: number, idempotencyKey?: string): Promise<BidRow> {
  // Idempotency keys are honoured by the write-behind path only (the Postgres paths ignore them).
  if (config.BID_IMPL === 'redis') return placeBidWriteBehind(auctionId, bidderId, amount, idempotencyKey);
  return config.BID_IMPL === 'legacy'
    ? placeBidLegacy(auctionId, bidderId, amount)
    : placeBidSingle(auctionId, bidderId, amount);
}

/** Write-behind: Redis decides atomically and records the bid; the flusher saves it to Postgres shortly after. */
async function placeBidWriteBehind(auctionId: number, bidderId: number, amount: number, idempotencyKey?: string): Promise<BidRow> {
  const { seq, at, replayed } = await placeBidInRedis(auctionId, bidderId, amount, idempotencyKey);
  return { id: null, auction_id: String(auctionId), bidder_id: String(bidderId), amount: String(amount), seq: String(seq), created_at: at, replayed };
}

/**
 * One statement, one round trip. The UPDATE takes the row lock itself; if another bid holds it,
 * Postgres waits and then re-checks the WHERE clause against the newly committed row (READ COMMITTED),
 * so a bid that is no longer high enough updates nothing. The bid is inserted only if the UPDATE
 * changed a row, in the same statement, so the lock is held for one statement instead of five round trips.
 */
const SINGLE_STATEMENT = `
  WITH bump AS (
    UPDATE auctions
       SET current_price = $2::bigint, highest_bidder = $3::bigint, bid_count = bid_count + 1
     WHERE id = $1::bigint
       AND status = 'active'
       AND ends_at > now()
       AND seller_id <> $3::bigint
       AND $2::bigint >= CASE WHEN highest_bidder IS NULL THEN starting_price ELSE current_price + 1 END
    RETURNING bid_count
  )
  INSERT INTO bids (auction_id, bidder_id, amount, seq)
  SELECT $1::bigint, $3::bigint, $2::bigint, bid_count FROM bump
  RETURNING id, auction_id, bidder_id, amount, seq, created_at`;

async function placeBidSingle(auctionId: number, bidderId: number, amount: number): Promise<BidRow> {
  const { rows } = await pool.query(SINGLE_STATEMENT, [auctionId, amount, bidderId]);
  if (rows[0]) return rows[0];

  // Nothing was updated, so the bid was rejected. A second, rejection-only query finds out why.
  // State can only move toward "more rejected" (price rises, auctions do not reopen), so the reason stays true.
  const { rows: a } = await pool.query(
    `SELECT seller_id, status, (ends_at > now()) AS open, highest_bidder, current_price, starting_price
       FROM auctions WHERE id = $1`,
    [auctionId],
  );
  throw rejection(a[0], bidderId);
}

function rejection(a: any, bidderId: number): AppError {
  if (!a) return new AppError(404, 'AUCTION_NOT_FOUND', 'auction not found');
  if (a.status !== 'active' || !a.open) return new AppError(409, 'AUCTION_CLOSED', 'auction has ended');
  if (Number(a.seller_id) === bidderId) return new AppError(403, 'SELF_BID', 'seller cannot bid on own auction');
  const minimum = a.highest_bidder !== null ? Number(a.current_price) + 1 : Number(a.starting_price);
  return new AppError(409, 'BID_TOO_LOW', `bid must be at least ${minimum}`);
}

/** The original implementation: BEGIN, SELECT FOR UPDATE, UPDATE, INSERT, COMMIT (5 round trips under the lock). */
async function placeBidLegacy(auctionId: number, bidderId: number, amount: number): Promise<BidRow> {
  return withTx(async (c) => {
    const { rows } = await c.query(`SELECT *, (ends_at > now()) AS open FROM auctions WHERE id=$1 FOR UPDATE`, [auctionId]);
    const a = rows[0];
    if (!a) throw new AppError(404, 'AUCTION_NOT_FOUND', 'auction not found');
    if (a.status !== 'active' || !a.open) throw new AppError(409, 'AUCTION_CLOSED', 'auction has ended');
    if (Number(a.seller_id) === bidderId) throw new AppError(403, 'SELF_BID', 'seller cannot bid on own auction');
    const minimum = a.highest_bidder !== null ? Number(a.current_price) + 1 : Number(a.starting_price);
    if (amount < minimum) throw new AppError(409, 'BID_TOO_LOW', `bid must be at least ${minimum}`);
    const upd = await c.query(
      'UPDATE auctions SET current_price=$2, highest_bidder=$3, bid_count=bid_count+1 WHERE id=$1 RETURNING bid_count',
      [auctionId, amount, bidderId],
    );
    const ins = await c.query(
      `INSERT INTO bids(auction_id, bidder_id, amount, seq) VALUES($1,$2,$3,$4)
       RETURNING id, auction_id, bidder_id, amount, seq, created_at`,
      [auctionId, bidderId, amount, upd.rows[0].bid_count],
    );
    return ins.rows[0];
  });
}
