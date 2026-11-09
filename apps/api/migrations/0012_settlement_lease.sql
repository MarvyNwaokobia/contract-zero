-- Settlement worker safety.
--  claimed_by / lease_until: a row is claimed atomically with a lease, so two workers
--    (or two API instances) never submit the same operation; an expired lease (a
--    crashed worker) is reclaimable.
--  next_attempt_at / defer_reason: a batch the ledger refused for its epoch issuance
--    budget waits for the epoch to reset instead of retrying every minute.
--  Each attempt's outcome (not_sent / failed / unknown, with its transaction hash) is
--    appended to `evidence`, so an ambiguous submission is never compensated blind.
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS defer_reason TEXT;
