-- Public feed: owners can opt a site out of the landing-page feed without
-- giving up forkability. Default 1 so existing sites stay listed; the
-- landing page query also filters by anonymous=0, password_hash IS NULL,
-- and price_amount IS NULL, so anonymous/gated sites are already excluded.
ALTER TABLE sites ADD COLUMN listed INTEGER NOT NULL DEFAULT 1;

-- Index supports the feed query: status='active' AND listed=1 ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_sites_feed ON sites(status, listed, created_at);
