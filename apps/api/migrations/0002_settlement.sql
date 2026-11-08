-- On-chain settlement queue. A row is created when the economy commits something
-- that must settle on NEAR; a worker submits it and only marks it 'confirmed' after
-- independently verifying the final transaction outcome. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS settlements (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT        NOT NULL CHECK (kind IN ('genesis', 'flows', 'raid', 'trade')),
  -- The contract-side operation id (raid id, flow batch id, offer id). Unique, so the
  -- same economic event can never be queued twice.
  op_id        TEXT        NOT NULL UNIQUE,
  tick         BIGINT      NOT NULL,
  payload      JSONB       NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed', 'compensated')),
  attempts     INT         NOT NULL DEFAULT 0,
  tx_hashes    TEXT[]      NOT NULL DEFAULT '{}',
  -- Verified evidence: receipt statuses and the NEP-245 events emitted.
  evidence     JSONB,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements (status, id);

-- Single-row cursor: the economy ledger has been mirrored on chain up to this entry.
CREATE TABLE IF NOT EXISTS chain_sync (
  id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ledger_seq     BIGINT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO chain_sync (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
