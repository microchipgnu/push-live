CREATE TABLE IF NOT EXISTS domains (
  domain          TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending|active|failed
  verification    TEXT,                              -- nullable token for TXT verification
  ssl_status      TEXT,                              -- pending|active|failed
  created_at      INTEGER NOT NULL,
  verified_at     INTEGER,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_domains_owner ON domains(owner_user_id);

CREATE TABLE IF NOT EXISTS handles (
  handle          TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS links (
  id              TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL,
  location        TEXT NOT NULL,                     -- "handle/" or "handle/path" or "domain.com/path"
  domain          TEXT,                              -- nullable; null => handle-based
  mount_path      TEXT NOT NULL DEFAULT '/',
  slug            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (location),
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (slug) REFERENCES sites(slug) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_links_owner  ON links(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_links_slug   ON links(slug);

CREATE TABLE IF NOT EXISTS variables (
  owner_user_id   TEXT NOT NULL,
  name            TEXT NOT NULL,
  value_encrypted TEXT NOT NULL,
  pin_origin      TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, name),
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);
