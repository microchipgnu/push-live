-- Apps platform: events table shared across server-side apps.
-- Each row is one event ("hit" for analytics, more later). Slug-scoped so
-- one query never reads another site's data.
CREATE TABLE IF NOT EXISTS site_app_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL,
  app          TEXT NOT NULL,           -- e.g. 'analytics'
  event        TEXT NOT NULL,           -- e.g. 'hit'
  ts           INTEGER NOT NULL,        -- ms epoch
  path         TEXT,                    -- request path on the site
  referrer     TEXT,
  country      TEXT,                    -- from cf-ipcountry
  ua_hash      TEXT,                    -- short sha256 of UA (no raw UA stored)
  visitor_hash TEXT                     -- short sha256 of (day-salt, slug, ip); rotates daily
);

CREATE INDEX IF NOT EXISTS idx_app_events_slug_ts ON site_app_events(slug, app, ts);
