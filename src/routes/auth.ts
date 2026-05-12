import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types.ts';
import { errBody } from '../lib/auth.ts';
import { newId, newToken } from '../lib/ids.ts';
import { sha256Hex } from '../lib/hash.ts';
import { sendCodeEmail } from '../lib/email.ts';
import { checkPublishRate, rateLimitResponse } from '../lib/quotas.ts';

const CODE_TTL_SECONDS = 600;
const CODE_ATTEMPT_MAX = 5;
const IP_AUTH_LIMIT_PER_HOUR = 30;

const EmailSchema = z.object({ email: z.string().email().max(254) });
const VerifySchema = z.object({
  email: z.string().email().max(254),
  code: z.string().min(4).max(16),
});

export const authRouter = new Hono<{ Bindings: Env }>();

authRouter.post('/api/auth/agent/request-code', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = EmailSchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', 'Valid email required'), 400);
  const email = parsed.data.email.toLowerCase();
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const wait = await checkPublishRate(c.env, `auth:ip:${ip}`, IP_AUTH_LIMIT_PER_HOUR);
  if (wait > 0) return rateLimitResponse(wait);
  const code = generateCode();
  const codeHash = await sha256Hex(code);
  await c.env.KV.put(
    `auth:code:${email}`,
    JSON.stringify({ hash: codeHash, attempts: 0, createdAt: Date.now() }),
    { expirationTtl: CODE_TTL_SECONDS },
  );
  c.executionCtx.waitUntil(sendCodeEmail(c.env, email, code));
  const resp: Record<string, unknown> = { success: true, expiresInSeconds: CODE_TTL_SECONDS };
  // Dev-only: surface the code when no real fallback email transport is configured
  // OR when running against a local dev host (Wrangler binds env.EMAIL even
  // in dev, but its local impl logs instead of sending — useless for tests).
  const host = new URL(c.req.url).hostname;
  const isLocal = host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost');
  const noRealTransport = !c.env.MAILCHANNELS_API_KEY && !c.env.RESEND_API_KEY;
  if (isLocal || (!c.env.EMAIL && noRealTransport)) {
    resp.devCode = code;
    resp.devWarning = 'Dev mode: code returned inline. Configure email transport for production.';
  }
  return c.json(resp);
});

authRouter.post('/api/auth/agent/verify-code', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = VerifySchema.safeParse(body);
  if (!parsed.success) return c.json(errBody('invalid_request', parsed.error.message), 400);
  const email = parsed.data.email.toLowerCase();
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const wait = await checkPublishRate(c.env, `auth:ip:${ip}`, IP_AUTH_LIMIT_PER_HOUR);
  if (wait > 0) return rateLimitResponse(wait);
  const submitted = parsed.data.code.replace(/\s+/g, '').toUpperCase();

  const raw = await c.env.KV.get(`auth:code:${email}`);
  if (!raw) return c.json(errBody('unauthorized', 'Invalid or expired code'), 401);
  const rec = JSON.parse(raw) as { hash: string; attempts: number; createdAt: number };
  if (rec.attempts >= CODE_ATTEMPT_MAX) {
    await c.env.KV.delete(`auth:code:${email}`);
    return c.json(errBody('unauthorized', 'Too many attempts'), 401);
  }
  if ((await sha256Hex(submitted)) !== rec.hash) {
    rec.attempts += 1;
    await c.env.KV.put(`auth:code:${email}`, JSON.stringify(rec), {
      expirationTtl: CODE_TTL_SECONDS,
    });
    return c.json(errBody('unauthorized', 'Invalid or expired code'), 401);
  }
  await c.env.KV.delete(`auth:code:${email}`);

  // Upsert user
  let user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?1')
    .bind(email)
    .first<{ id: string }>();
  if (!user) {
    const id = newId('usr');
    await c.env.DB.prepare(
      'INSERT INTO users (id, email, plan, created_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(id, email, 'free', Date.now())
      .run();
    user = { id };
  }

  // Mint API key
  const token = `slp_${newToken(28)}`;
  const tokenHash = await sha256Hex(token);
  const keyId = newId('key');
  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, user_id, token_hash, prefix, label, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(keyId, user.id, tokenHash, token.slice(0, 12), 'agent', Date.now())
    .run();

  return c.json({
    apiKey: token,
    userId: user.id,
    keyId,
    warning: 'Save this API key now. It is shown only once.',
  });
});

function generateCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 8; i++) {
    s += alphabet[bytes[i] % alphabet.length];
    if (i === 3) s += '-';
  }
  return s;
}
