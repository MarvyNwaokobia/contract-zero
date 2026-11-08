-- Operator profiles: the callsign a player chooses after first sign-in, keyed by the
-- account their session proved.
CREATE TABLE IF NOT EXISTS player_profiles (
    account    TEXT PRIMARY KEY,
    callsign   TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_profile_callsign ON player_profiles (lower(callsign));
