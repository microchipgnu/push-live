// Structured one-line JSON request logger. Pipes to whatever consumes
// `wrangler tail` (or your own log ingest via Logpush).

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function logLine(level: 'info' | 'warn' | 'error', fields: LogFields): void {
  const out: LogFields = { ts: new Date().toISOString(), level, ...fields };
  // Drop undefineds for compact lines.
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  try {
    fn(JSON.stringify(out));
  } catch {
    fn(`[log] (failed to stringify) ${level} ${fields.msg ?? ''}`);
  }
}

export async function withRequestLog<T>(
  req: Request,
  handler: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const url = new URL(req.url);
  let status = 0;
  let err: unknown = null;
  try {
    const res = (await handler()) as unknown;
    if (res instanceof Response) status = res.status;
    return res as T;
  } catch (e) {
    err = e;
    throw e;
  } finally {
    logLine(err ? 'error' : status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', {
      method: req.method,
      host: url.hostname,
      path: url.pathname,
      status,
      ms: Date.now() - start,
      cf_ip: req.headers.get('cf-connecting-ip') ?? undefined,
      ua: req.headers.get('user-agent')?.slice(0, 120) ?? undefined,
      err: err instanceof Error ? err.message : err ? String(err) : undefined,
    });
  }
}
