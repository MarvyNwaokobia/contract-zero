-- Operations are bound to a site, and carry the physical objects the player can act
-- on (cargo cases, charges, loose supplies). `record` is what the client reported
-- doing, checked against `field` at completion. Sessions started before this
-- migration have no field and complete under the old rules.
ALTER TABLE mission_sessions ADD COLUMN IF NOT EXISTS site TEXT;
ALTER TABLE mission_sessions ADD COLUMN IF NOT EXISTS field JSONB;
ALTER TABLE mission_sessions ADD COLUMN IF NOT EXISTS record JSONB;
ALTER TABLE mission_sessions ADD COLUMN IF NOT EXISTS gun TEXT;
