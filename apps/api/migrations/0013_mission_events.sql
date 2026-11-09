-- Server-authoritative mission progression. Sessions started from here on use the
-- event protocol (protocol = 2): the client streams events, the server folds them into
-- field_state (services/protocol.rs), and completion settles from field_state alone.
-- Every event and the server's verdict on it are kept for audit; (session, seq) is
-- unique, so a replayed event is stored once and never re-applied.
ALTER TABLE mission_sessions ADD COLUMN IF NOT EXISTS protocol INT NOT NULL DEFAULT 1;
ALTER TABLE mission_sessions ADD COLUMN IF NOT EXISTS layout TEXT;
ALTER TABLE mission_sessions ADD COLUMN IF NOT EXISTS field_state JSONB;
CREATE TABLE IF NOT EXISTS mission_events (
    session UUID NOT NULL,
    seq BIGINT NOT NULL,
    t BIGINT NOT NULL,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL,
    verdict TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session, seq)
);
