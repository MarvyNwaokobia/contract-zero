-- Official NEAR Intents swaps actually executed (mainnet, explicitly approved): the
-- quote they came from, the deposit, and every status 1Click reported, in order.
CREATE TABLE IF NOT EXISTS intents_executions (
    id              BIGSERIAL PRIMARY KEY,
    correlation_id  TEXT NOT NULL,
    deposit_address TEXT NOT NULL UNIQUE,
    origin_asset    TEXT NOT NULL,
    destination_asset TEXT NOT NULL,
    amount_in       TEXT NOT NULL,
    min_amount_out  TEXT,
    recipient       TEXT NOT NULL,
    deposit_tx      TEXT,
    status          TEXT NOT NULL DEFAULT 'QUOTED',
    history         JSONB NOT NULL DEFAULT '[]',
    last_response   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
