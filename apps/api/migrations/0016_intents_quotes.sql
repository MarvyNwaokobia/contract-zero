-- Official NEAR Intents (1Click) quotes the game requested: the protocol's own
-- references (correlation id, signature), the exact request and response, and whether
-- it was a dry quote (prices only, no deposit address) or a real one. Kept as evidence
-- of what the protocol actually returned; nothing here is a settled trade.
CREATE TABLE IF NOT EXISTS intents_quotes (
    id             BIGSERIAL PRIMARY KEY,
    correlation_id TEXT NOT NULL,
    dry            BOOLEAN NOT NULL,
    origin_asset   TEXT NOT NULL,
    destination_asset TEXT NOT NULL,
    amount_in      TEXT NOT NULL,
    amount_out     TEXT,
    min_amount_out TEXT,
    deadline       TIMESTAMPTZ,
    signature      TEXT,
    deposit_address TEXT,
    request        JSONB NOT NULL,
    response       JSONB NOT NULL,
    requested_by   TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_intents_quotes_created ON intents_quotes (created_at DESC);
