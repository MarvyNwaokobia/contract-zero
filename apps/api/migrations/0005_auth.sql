-- Player authentication. A session is created only after the player proves control
-- of an account on chain (a NEP-413 signature by a full-access key, or a NEAR Auth
-- identity token whose MPC-derived key controls the account). The cookie carries a
-- random token; only its SHA-256 is stored.
CREATE TABLE IF NOT EXISTS auth_challenges (
    nonce      TEXT PRIMARY KEY,               -- hex of 32 random bytes
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    account    TEXT NOT NULL,                  -- the on-chain account the player proved
    method     TEXT NOT NULL CHECK (method IN ('wallet', 'near_auth', 'dev')),
    provider   TEXT,                           -- google | apple | email | wallet | dev
    subject    TEXT,                           -- identity-provider subject (NEAR Auth)
    public_key TEXT,                           -- the key that proved control
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_account ON auth_sessions (account);

-- NEAR Auth identities and the account provisioned for each (implicit account of the
-- derived key). Sponsorship happens at most once per identity.
CREATE TABLE IF NOT EXISTS auth_identities (
    subject     TEXT PRIMARY KEY,
    provider    TEXT NOT NULL,
    public_key  TEXT NOT NULL,
    account     TEXT NOT NULL UNIQUE,
    sponsor_tx  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
