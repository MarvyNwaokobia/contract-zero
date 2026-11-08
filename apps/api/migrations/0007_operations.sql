-- Sabotage and recovery settle as one `settle_operation` on the controller.
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_kind_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_kind_check CHECK (kind IN ('genesis', 'flows', 'raid', 'trade', 'sell', 'operation'));
