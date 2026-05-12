ALTER TABLE domains ADD COLUMN cf_hostname_id TEXT;
ALTER TABLE domains ADD COLUMN cf_ownership_records TEXT;   -- JSON: array of {type,name,value}
ALTER TABLE domains ADD COLUMN cf_last_synced INTEGER;
