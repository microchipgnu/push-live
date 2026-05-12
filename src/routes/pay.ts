import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types.ts';
import { errBody } from '../lib/auth.ts';
import { newId } from '../lib/ids.ts';
import { hmacSign, sha256Hex } from '../lib/hash.ts';
import { verifyChainPayment } from '../lib/chain-verify.ts';

// 30 minutes
const SESSION_TTL_SECONDS = 30 * 60;
// 7 days
const GRANT_TTL_SECONDS = 7 * 24 * 60 * 60;

type PriceRow = {
  price_amount: string | null;
  price_currency: string | null;
  price_recipient: string | null;
  owner_wallet: string | null;
  owner_user_id: string | null;
};

type PaymentSession = {
  id: string;
  slug: string;
  amount: string;
  currency: string;
  recipient: string;
  depositAddress: string;
  status: 'pending' | 'granted' | 'expired';
  txHash?: string;
  createdAt: number;
};

export const payRouter = new Hono<{ Bindings: Env }>();

// Create a new payment session.
payRouter.post('/api/pay/:slug/session', async (c) => {
  const slug = c.req.param('slug');
  const price = await loadPriceFor(c.env, slug);
  if (!price) return c.json(errBody('not_found', 'Site has no price'), 404);

  const id = newId('pay');
  const sess: PaymentSession = {
    id,
    slug,
    amount: price.amount,
    currency: price.currency,
    recipient: price.recipient,
    // In a real Tempo integration this would be a unique deposit address
    // derived per-session so we can attribute payments. For now we route
    // directly to the owner's address and tag using the session id.
    depositAddress: price.recipient,
    status: 'pending',
    createdAt: Date.now(),
  };
  await c.env.KV.put(`pay:session:${id}`, JSON.stringify(sess), { expirationTtl: SESSION_TTL_SECONDS });
  return c.json({
    sessionId: id,
    depositAddress: sess.depositAddress,
    amount: sess.amount,
    currency: sess.currency,
    memo: `push-live:${slug}:${id}`,
    expiresInSeconds: SESSION_TTL_SECONDS,
    pollUrl: `${new URL(c.req.url).origin}/api/pay/${slug}/poll?session=${id}`,
    grantUrl: `${new URL(c.req.url).origin}/api/pay/${slug}/grant`,
  });
});

// Poll session status. Agents call this every few seconds.
payRouter.get('/api/pay/:slug/poll', async (c) => {
  const slug = c.req.param('slug');
  const sessId = c.req.query('session');
  if (!sessId) return c.json(errBody('invalid_request', 'session required'), 400);
  const raw = await c.env.KV.get(`pay:session:${sessId}`);
  if (!raw) return c.json({ status: 'expired' });
  const sess = JSON.parse(raw) as PaymentSession;
  if (sess.slug !== slug) return c.json(errBody('not_found', 'Session does not match slug'), 404);
  return c.json({
    status: sess.status,
    txHash: sess.txHash,
    grantUrl: `${new URL(c.req.url).origin}/api/pay/${slug}/grant`,
  });
});

// Grant: agent or webhook claims a payment was made. Verifies on-chain (stubbed
// in dev) and returns a signed grant token.
const GrantSchema = z.object({
  sessionId: z.string().min(1),
  txHash: z.string().min(8).max(200).optional(),
});

payRouter.post('/api/pay/:slug/grant', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json().catch(() => null);
  const parsed = GrantSchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', parsed.error.message), 400);

  const key = `pay:session:${parsed.data.sessionId}`;
  const raw = await c.env.KV.get(key);
  if (!raw) return c.json(errBody('gone', 'Session expired or not found'), 410);
  const sess = JSON.parse(raw) as PaymentSession;
  if (sess.slug !== slug) return c.json(errBody('not_found', 'Session does not match slug'), 404);
  if (sess.status === 'granted') return successResponse(c.env, sess);

  // On-chain verification when TEMPO_RPC_URL is configured; auto-grant in dev.
  const v = await verifyPayment(c.env, sess, parsed.data.txHash);
  if (!v.ok) return c.json(errBody('precondition_failed', `Payment not confirmed: ${v.reason ?? 'unknown'}`), 412);

  sess.status = 'granted';
  sess.txHash = parsed.data.txHash;
  await c.env.KV.put(key, JSON.stringify(sess), { expirationTtl: SESSION_TTL_SECONDS });

  return successResponse(c.env, sess);
});

// Convenience: GET /api/pay/:slug/confirm?session=<id>&tx=<hash>
// Same as POST /grant but URL-form for browser flow.
payRouter.get('/api/pay/:slug/confirm', async (c) => {
  const slug = c.req.param('slug');
  const sessId = c.req.query('session');
  if (!sessId) return c.json(errBody('invalid_request', 'session required'), 400);
  const raw = await c.env.KV.get(`pay:session:${sessId}`);
  if (!raw) return c.json(errBody('gone', 'Session expired'), 410);
  const sess = JSON.parse(raw) as PaymentSession;
  if (sess.slug !== slug) return c.json(errBody('not_found', 'Mismatch'), 404);
  const v = await verifyPayment(c.env, sess, c.req.query('tx') ?? undefined);
  if (!v.ok) {
    return c.html(`<h1>Payment not yet confirmed</h1><p>${v.reason ?? 'Reload in a few seconds.'}</p>`, 412);
  }
  sess.status = 'granted';
  sess.txHash = c.req.query('tx') ?? sess.txHash;
  await c.env.KV.put(`pay:session:${sessId}`, JSON.stringify(sess), { expirationTtl: SESSION_TTL_SECONDS });
  const token = await issueGrantToken(c.env, slug, sess.id);
  const headers = new Headers({
    location: `/`,
    'set-cookie': `sl_pay_${slug}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${GRANT_TTL_SECONDS}`,
  });
  return new Response(null, { status: 302, headers });
});

async function successResponse(env: Env, sess: PaymentSession): Promise<Response> {
  const token = await issueGrantToken(env, sess.slug, sess.id);
  return Response.json({
    status: 'granted',
    grantToken: token,
    grantUrl: `?__sl_grant=${token}`,
    expiresInSeconds: GRANT_TTL_SECONDS,
  });
}

export async function issueGrantToken(env: Env, slug: string, sessionId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + GRANT_TTL_SECONDS;
  const payload = `${slug}.${sessionId}.${exp}`;
  const sig = await hmacSign(env.SIGNING_KEY, payload);
  return `${payload}.${sig}`;
}

export async function verifyGrantToken(env: Env, slug: string, token: string): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 4) return false;
  const [tokenSlug, sessionId, expStr, sig] = parts;
  if (tokenSlug !== slug) return false;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = await hmacSign(env.SIGNING_KEY, `${tokenSlug}.${sessionId}.${expStr}`);
  return expected === sig;
}

async function loadPriceFor(env: Env, slug: string): Promise<{ amount: string; currency: string; recipient: string } | null> {
  const row = await env.DB.prepare(
    `SELECT s.price_amount, s.price_currency, s.price_recipient, u.wallet AS owner_wallet, s.owner_user_id
     FROM sites s LEFT JOIN users u ON u.id = s.owner_user_id
     WHERE s.slug = ?1 AND s.status != 'deleted'`,
  ).bind(slug).first<PriceRow>();
  if (!row || !row.price_amount || !row.price_currency) return null;
  const recipient = row.price_recipient ?? row.owner_wallet;
  if (!recipient) return null;
  return { amount: row.price_amount, currency: row.price_currency, recipient };
}

async function verifyPayment(env: Env, sess: PaymentSession, txHash: string | undefined): Promise<{ ok: boolean; reason?: string }> {
  if (!env.TEMPO_RPC_URL) {
    // Dev mode: no RPC configured. Trust caller. Production deploys MUST set
    // TEMPO_RPC_URL (and TEMPO_<CURRENCY>_CONTRACT for ERC20 tokens) or all
    // payment gates degrade to "any client claim is honored".
    return { ok: true };
  }
  if (!txHash) return { ok: false, reason: 'txHash required' };
  const result = await verifyChainPayment(env, {
    txHash,
    recipient: sess.recipient,
    amount: sess.amount,
    currency: sess.currency,
  });
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.reason };
}

export async function loadSitePrice(env: Env, slug: string): Promise<{ amount: string; currency: string; recipient: string } | null> {
  return loadPriceFor(env, slug);
}
