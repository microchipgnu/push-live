-- Per-site app opt-outs. NULL means "use defaults" (analytics on, others off
-- until explicitly enabled). Non-null is a JSON array of app ids the owner
-- has turned off, e.g. ["analytics"]. Sites table only — anonymous sites
-- and the apps platform never intersect, so no separate row.
ALTER TABLE sites ADD COLUMN apps_disabled TEXT;
