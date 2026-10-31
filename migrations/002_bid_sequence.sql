-- Per-auction sequence number for bids (1, 2, 3, ...). Real-time clients use it to
-- detect missed events and to ask for a catch-up after reconnecting.
ALTER TABLE auctions ADD COLUMN bid_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE bids ADD COLUMN seq BIGINT;

UPDATE bids b SET seq = r.rn
FROM (SELECT id, row_number() OVER (PARTITION BY auction_id ORDER BY id) AS rn FROM bids) r
WHERE r.id = b.id;

UPDATE auctions a SET bid_count = COALESCE((SELECT count(*) FROM bids WHERE auction_id = a.id), 0);

ALTER TABLE bids ALTER COLUMN seq SET NOT NULL;
CREATE UNIQUE INDEX idx_bids_auction_seq ON bids (auction_id, seq);
