import { pool } from '../db.js';
import { cached, auctionKey } from '../cache.js';
import { config } from '../config.js';
import { readLiveState } from '../state.js';

// Row as it comes back from pg (BIGINT columns are strings) or from the JSON cache.
export interface AuctionRow {
  id: string;
  seller_id: string;
  title: string;
  starting_price: string;
  current_price: string;
  highest_bidder: string | null;
  status: string;
  ends_at: string;
  bid_count: string;
}

/**
 * Cache-aside read of one auction; shared by the REST route and the WebSocket snapshot.
 *
 * With write-behind bidding, Postgres can be a few hundred ms behind, so the cached row is only trusted for
 * fields that never change (title, seller, ...). The fields that change with every bid (price, bidder, bid_count,
 * status) are overlaid from the live state in Redis when it exists. If that Redis is down, reads fall back to the
 * database row (possibly slightly old) instead of failing.
 */
export async function getAuction(id: number, log: { debug: (o: object, m: string) => void }) {
  const row = await cached<AuctionRow>(
    auctionKey(id),
    config.AUCTION_CACHE_TTL_SECONDS,
    async () => (await pool.query('SELECT * FROM auctions WHERE id=$1', [id])).rows[0],
    log,
  );
  if (!row || config.BID_IMPL !== 'redis') return row;
  try {
    const live = await readLiveState(id);
    return live ? { ...row, ...live } : row;
  } catch {
    return row;
  }
}
