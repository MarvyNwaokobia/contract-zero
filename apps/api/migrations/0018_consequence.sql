-- The recorded consequence of an operation: the target faction before it started, what
-- the player faced, and (once it settles) the faction after and what the next such
-- operation would face. Written by the server from the world's own state; never
-- reconstructed. Sessions from before this migration have NULL and the game says so.
ALTER TABLE mission_sessions ADD COLUMN IF NOT EXISTS consequence JSONB;
