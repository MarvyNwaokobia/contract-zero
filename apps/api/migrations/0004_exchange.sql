-- Player quotes on the Exchange. The economy holds each quote (and the merchant's
-- side in escrow); this table tracks its on-chain counterpart on the controller.
CREATE TABLE IF NOT EXISTS player_quotes (
    quote_id    BIGINT PRIMARY KEY,           -- the economy's quote id
    contract    TEXT,                         -- the controller it was posted to (NULL: off-chain)
    chain_quote TEXT,                         -- e.g. 'offer:px-7-1a2b3c4d' (NULL: off-chain)
    player      TEXT NOT NULL,
    side        TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'released')),
    expires_at  TIMESTAMPTZ NOT NULL,
    tx_hashes   TEXT[] NOT NULL DEFAULT '{}',
    detail      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_player_quotes_open ON player_quotes (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_player_quotes_player ON player_quotes (player, created_at DESC);
