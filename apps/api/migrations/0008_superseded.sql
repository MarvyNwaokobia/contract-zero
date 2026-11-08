-- Flow batches replaced by a realignment batch (see settlement::align).
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_status_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_status_check CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed', 'compensated', 'superseded'));
