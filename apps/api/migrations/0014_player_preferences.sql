-- Account-level player preferences (controls, interface, accessibility, audio levels):
-- the portable part of Settings, so a player's bindings follow them to another
-- device. Device-specific settings (graphics quality, resolution, FPS cap) never come
-- here. The server stores an allow-listed, size-limited JSON document and nothing
-- else; it never holds keys, tokens or other secrets.
CREATE TABLE IF NOT EXISTS player_preferences (
    account    TEXT PRIMARY KEY,
    version    INT NOT NULL,
    prefs      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
