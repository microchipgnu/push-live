import type { Env } from '../types.ts';

export type FeedItem = {
  slug: string;
  title: string | null;
  description: string | null;
  ogImagePath: string | null;
  forkable: boolean;
  handle: string | null;
  createdAt: number;
  url: string;
};

export type Feed = {
  items: FeedItem[];
  cachedAt: number;
  ttlSeconds: number;
};

const CACHE_KEY = 'feed:public:v1';
const CACHE_TTL_SECONDS = 60;
// Hide sites for the first 5 minutes so abuse has a moderation buffer.
const MIN_AGE_MS = 5 * 60 * 1000;
const FEED_LIMIT = 24;

export async function loadPublicFeed(env: Env): Promise<Feed> {
  const cached = await env.KV.get(CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached) as Feed; } catch { /* fall through */ }
  }
  const cutoff = Date.now() - MIN_AGE_MS;
  const rows = await env.DB.prepare(
    `SELECT s.slug, s.viewer_title, s.viewer_description, s.viewer_og_image,
            s.forkable, s.created_at, h.handle
       FROM sites s
       LEFT JOIN handles h ON h.owner_user_id = s.owner_user_id
      WHERE s.status = 'active'
        AND s.listed = 1
        AND s.anonymous = 0
        AND s.password_hash IS NULL
        AND s.price_amount IS NULL
        AND s.current_version_id IS NOT NULL
        AND s.created_at <= ?1
      ORDER BY s.created_at DESC
      LIMIT ?2`,
  ).bind(cutoff, FEED_LIMIT).all<{
    slug: string;
    viewer_title: string | null;
    viewer_description: string | null;
    viewer_og_image: string | null;
    forkable: number;
    created_at: number;
    handle: string | null;
  }>();

  const items: FeedItem[] = (rows.results ?? []).map((r) => ({
    slug: r.slug,
    title: r.viewer_title,
    description: r.viewer_description,
    ogImagePath: r.viewer_og_image,
    forkable: r.forkable === 1,
    handle: r.handle,
    createdAt: r.created_at,
    url: `https://${r.slug}.${env.PUBLIC_APEX_HOST}/`,
  }));

  const feed: Feed = { items, cachedAt: Date.now(), ttlSeconds: CACHE_TTL_SECONDS };
  await env.KV.put(CACHE_KEY, JSON.stringify(feed), { expirationTtl: CACHE_TTL_SECONDS });
  return feed;
}
