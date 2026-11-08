-- The story a mission was briefed with: the facts captured at start, the authored
-- (or checked, model-voiced) lines, and the debrief written at completion.
ALTER TABLE mission_sessions ADD COLUMN IF NOT EXISTS story JSONB;
