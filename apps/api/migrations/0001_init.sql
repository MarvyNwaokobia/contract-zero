-- CONTRACT ZERO base schema. Idempotent: safe to re-run.

-- The economy's full state after each committed change. The latest row is the
-- live world; older rows are an audit trail and make any moment replayable.
CREATE TABLE IF NOT EXISTS world_snapshots (
  id         BIGSERIAL PRIMARY KEY,
  tick       BIGINT      NOT NULL,
  version    BIGINT      NOT NULL,
  state      JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_world_snapshots_version ON world_snapshots (version DESC);

-- Append-only feed of what happened: agent decisions (with their reasoning and
-- whether the engine accepted them), economy events, mission outcomes.
CREATE TABLE IF NOT EXISTS world_events (
  seq        BIGSERIAL PRIMARY KEY,
  tick       BIGINT      NOT NULL,
  source     TEXT        NOT NULL,   -- 'ironveil' | 'vex' | 'system' | 'player:<id>'
  kind       TEXT        NOT NULL,   -- 'agent_decision' | 'economy' | 'mission'
  payload    JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_world_events_kind ON world_events (kind, seq DESC);

-- One row per deployment. The server issues it when the player accepts a contract
-- and is the only thing that can settle it.
CREATE TABLE IF NOT EXISTS mission_sessions (
  id           UUID PRIMARY KEY,
  player       TEXT        NOT NULL,
  contract_id  BIGINT      NOT NULL,
  min_secs     DOUBLE PRECISION NOT NULL,   -- fastest plausible clear for this mission
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  outcome      TEXT CHECK (outcome IN ('extracted', 'killed', 'expired', 'rejected')),
  result       JSONB
);
-- At most one open session per contract, enforced by the database as well as the economy.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_session_per_contract
  ON mission_sessions (contract_id) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mission_sessions_player ON mission_sessions (player, started_at DESC);
