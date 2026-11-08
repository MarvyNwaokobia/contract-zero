-- Settlement after the split into cz-assets + cz-world v2. Idempotent.

-- Every settlement row belongs to exactly one controller contract. Rows created before
-- the migration belong to v1; the worker only ever submits rows for the configured
-- controller, so v1 and v2 can never settle the same economic event.
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS contract TEXT NOT NULL DEFAULT 'world.contract-zero.testnet';
CREATE INDEX IF NOT EXISTS idx_settlements_contract_status ON settlements (contract, status, id);

-- Merchant bids (the merchant buys) settle as kind 'sell'.
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_kind_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_kind_check CHECK (kind IN ('genesis', 'flows', 'raid', 'trade', 'sell'));

-- The ledger cursor is per controller (v1's single-row chain_sync stays as history).
CREATE TABLE IF NOT EXISTS chain_cursor (
  contract   TEXT PRIMARY KEY,
  ledger_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Operation ids are unique per contract, not globally: v1's 'raid:1' must not stop
-- v2's 'raid:1' from being queued.
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_op_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_settlement_contract_op ON settlements (contract, op_id);
