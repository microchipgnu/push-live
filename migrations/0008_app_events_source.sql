-- Two-channel analytics: beacon (browser JS) and server (HTML serve, for
-- agents that don't run JS). source distinguishes the channel; client_kind
-- classifies the UA so the dashboard can split agent vs browser traffic.
--
-- Older rows have NULL for both; readers treat NULL source as 'beacon' and
-- NULL client_kind as 'unknown' so the migration is backwards-compatible.
ALTER TABLE site_app_events ADD COLUMN source TEXT;
ALTER TABLE site_app_events ADD COLUMN client_kind TEXT;
