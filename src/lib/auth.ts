import type { Context, MiddlewareHandler } from 'hono';
import type { Env, AuthCtx } from '../types.ts';
import { sha256Hex } from './hash.ts';

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthCtx;
  }
}

export const auth = (opts: { required?: boolean } = {}): MiddlewareHandler<{ Bindings: Env }> =>
  async (c, next) => {
    const header = c.req.header('authorization');
    if (!header) {
      if (opts.required) return c.json(errBody('unauthorized', 'API key required'), 401);
      c.set('auth', { kind: 'anonymous' });
      return next();
    }
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return c.json(errBody('unauthorized', 'Malformed Authorization header'), 401);
    const token = m[1].trim();
    const hash = await sha256Hex(token);
    const row = await c.env.DB.prepare(
      'SELECT id, user_id FROM api_keys WHERE token_hash = ?1',
    )
      .bind(hash)
      .first<{ id: string; user_id: string }>();
    if (!row) return c.json(errBody('unauthorized', 'Invalid API key'), 401);
    c.executionCtx.waitUntil(
      c.env.DB.prepare('UPDATE api_keys SET last_used = ?1 WHERE id = ?2')
        .bind(Date.now(), row.id)
        .run(),
    );
    c.set('auth', { kind: 'user', userId: row.user_id, apiKeyId: row.id });
    return next();
  };

export function requireUser(c: Context<{ Bindings: Env }>): { userId: string } | Response {
  const a = c.get('auth') as AuthCtx | undefined;
  if (!a || a.kind !== 'user') {
    return c.json(errBody('unauthorized', 'Authenticated request required'), 401);
  }
  return { userId: a.userId };
}

// Stable error envelope. Every error gets a docs_url pointing at the
// relevant /docs anchor so a caller can route a fix from the response alone.
// The URL is relative so it follows whatever host the worker is serving on
// (apex, dev, custom domain) without threading env through every call site.
const DOCS_ANCHOR: Record<string, string> = {
  unauthorized: 'auth',
  invalid_request: 'errors',
  not_found: 'errors',
  conflict: 'errors',
  gone: 'errors',
  precondition_failed: 'errors',
  payload_too_large: 'limits',
  quota_exceeded: 'limits',
  rate_limit_exceeded: 'limits',
  payment_required: 'payments',
};

export function errBody(code: string, message: string, extra: Record<string, unknown> = {}) {
  const docs_url = `/docs#${DOCS_ANCHOR[code] ?? 'errors'}`;
  return { error: message, code, message, docs_url, ...extra };
}
