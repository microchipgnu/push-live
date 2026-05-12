CREATE TABLE IF NOT EXISTS drives (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  deleted_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drives_owner ON drives(owner_user_id);

CREATE TABLE IF NOT EXISTS drive_files (
  drive_id      TEXT NOT NULL,
  path          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  content_type  TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  etag          TEXT NOT NULL,
  modified_by   TEXT,
  modified_at   INTEGER NOT NULL,
  PRIMARY KEY (drive_id, path),
  FOREIGN KEY (drive_id) REFERENCES drives(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drive_files_sha ON drive_files(sha256);

CREATE TABLE IF NOT EXISTS drive_versions (
  id          TEXT PRIMARY KEY,
  drive_id    TEXT NOT NULL,
  base_id     TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (drive_id) REFERENCES drives(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drive_versions_drive ON drive_versions(drive_id);

CREATE TABLE IF NOT EXISTS drive_tokens (
  id            TEXT PRIMARY KEY,
  drive_id      TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  prefix        TEXT NOT NULL,
  perms         TEXT NOT NULL,                -- 'read' | 'write'
  path_prefix   TEXT,
  manage_tokens INTEGER NOT NULL DEFAULT 0,
  label         TEXT,
  expires_at    INTEGER,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  FOREIGN KEY (drive_id) REFERENCES drives(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drive_tokens_drive ON drive_tokens(drive_id);

CREATE TABLE IF NOT EXISTS drive_uploads (
  id            TEXT PRIMARY KEY,
  drive_id      TEXT NOT NULL,
  path          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  content_type  TEXT NOT NULL,
  sha256        TEXT,
  if_match      TEXT,
  if_none_match TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (drive_id) REFERENCES drives(id) ON DELETE CASCADE
);
