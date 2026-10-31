CREATE TABLE users (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auctions (
  id             BIGSERIAL PRIMARY KEY,
  seller_id      BIGINT NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL,
  starting_price BIGINT NOT NULL CHECK (starting_price > 0),   -- minor units (cents)
  current_price  BIGINT NOT NULL,
  highest_bidder BIGINT REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  ends_at        TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_auctions_status_ends ON auctions (status, ends_at);

CREATE TABLE bids (
  id         BIGSERIAL PRIMARY KEY,
  auction_id BIGINT NOT NULL REFERENCES auctions(id),
  bidder_id  BIGINT NOT NULL REFERENCES users(id),
  amount     BIGINT NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bids_auction_amount ON bids (auction_id, amount DESC);
