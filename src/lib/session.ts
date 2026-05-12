import type { Env } from '../types.ts';
import { hmacSign } from './hash.ts';

// Cookie value: <userId>.<expiry>.<hmac>
const COOKIE_NAME = 'sl_session';
const TTL_SECONDS = 30 * 24 * 60 * 60;

export async function issueSessionCookie(env: Env, userId: string): Promise<string> {
  const expiry = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = `${userId}.${expiry}`;
  const sig = await hmacSign(env.SIGNING_KEY, payload);
  return `${COOKIE_NAME}=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function readSession(env: Env, cookieHeader: string | null): Promise<string | null> {
  if (!cookieHeader) return null;
  const cookies = parseCookies(cookieHeader);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiryStr, sig] = parts;
  const expiry = parseInt(expiryStr, 10);
  if (!Number.isFinite(expiry) || expiry * 1000 < Date.now()) return null;
  const expected = await hmacSign(env.SIGNING_KEY, `${userId}.${expiryStr}`);
  if (expected !== sig) return null;
  return userId;
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}
