-- One row per world tick: prices and actor holdings, for the War Room's history.
CREATE TABLE IF NOT EXISTS market_history (
    tick       BIGINT PRIMARY KEY,
    prices     JSONB NOT NULL,
    holdings   JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
