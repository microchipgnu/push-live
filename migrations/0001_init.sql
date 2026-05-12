-- sloop schema (Phase 1: sites + auth)

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  plan        TEXT NOT NULL DEFAULT 'free',
  wallet      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  label       TEXT,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS sites (
  slug                TEXT PRIMARY KEY,
  owner_user_id       TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',     -- pending|active|deleted
  current_version_id  TEXT,
  anonymous           INTEGER NOT NULL DEFAULT 0,
  expires_at          INTEGER,
  spa_mode            INTEGER NOT NULL DEFAULT 0,
  forkable            INTEGER NOT NULL DEFAULT 0,
  password_hash       TEXT,
  price_amount        TEXT,
  price_currency      TEXT,
  price_recipient     TEXT,
  viewer_title        TEXT,
  viewer_description  TEXT,
  viewer_og_image     TEXT,
  client_header       TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_sites_owner  ON sites(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);
CREATE INDEX IF NOT EXISTS idx_sites_expiry ON sites(expires_at);

CREATE TABLE IF NOT EXISTS site_versions (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL,
  status        TEXT NOT NULL,                              -- pending|live|superseded
  created_at    INTEGER NOT NULL,
  finalized_at  INTEGER,
  FOREIGN KEY (slug) REFERENCES sites(slug) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_versions_slug ON site_versions(slug);

CREATE TABLE IF NOT EXISTS site_files (
  version_id    TEXT NOT NULL,
  path          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  content_type  TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  PRIMARY KEY (version_id, path),
  FOREIGN KEY (version_id) REFERENCES site_versions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_site_files_sha ON site_files(sha256);

CREATE TABLE IF NOT EXISTS claim_tokens (
  slug        TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  FOREIGN KEY (slug) REFERENCES sites(slug) ON DELETE CASCADE
);
