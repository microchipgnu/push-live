-- Replace the misnamed drive_versions table with a proper file-history log.
DROP TABLE IF EXISTS drive_versions;

CREATE TABLE IF NOT EXISTS drive_file_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  drive_id      TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  path          TEXT NOT NULL,
  size          INTEGER,
  content_type  TEXT,
  sha256        TEXT,                              -- nullable for delete tombstones
  etag          TEXT,
  modified_by   TEXT,
  modified_at   INTEGER NOT NULL,                  -- when this row was *recorded*
  op            TEXT NOT NULL,                     -- 'put' | 'delete' | 'move_out' | 'move_in' | 'copy_in'
  FOREIGN KEY (drive_id) REFERENCES drives(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dfh_drive_path     ON drive_file_history(drive_id, path, modified_at DESC);
CREATE INDEX IF NOT EXISTS idx_dfh_owner_modified ON drive_file_history(owner_user_id, modified_at);
