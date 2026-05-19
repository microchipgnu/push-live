// Thin wrapper around Cloudflare's "for SaaS" custom-hostnames API.
// Docs: developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/

import type { Env } from '../types.ts';

type CFEnv = Env & {
  CLOUDFLARE_ZONE_ID?: string;
  CF_SAAS_API_TOKEN?: string;
};

export type CustomHostnameStatus =
  | 'active'
  | 'pending'
  | 'active_redeploying'
  | 'moved'
  | 'pending_deletion'
  | 'deleted'
  | 'pending_blocked'
  | 'pending_migration'
  | 'provisioned'
  | 'test_pending'
  | 'test_active'
  | 'test_active_apex'
  | 'test_blocked'
  | 'test_failed'
  | 'failed'
  | 'blocked';

export type CustomHostnameRow = {
  id: string;
  hostname: string;
  status: CustomHostnameStatus;
  ssl_status?: string;
  ownership_records: Array<{ type: string; name: string; value: string }>;
  verification_errors: string[];
};

const API = 'https://api.cloudflare.com/client/v4';

function requireCfCreds(env: CFEnv): { zoneId: string; token: string } {
  if (!env.CLOUDFLARE_ZONE_ID || !env.CF_SAAS_API_TOKEN) {
    throw new Error('CLOUDFLARE_ZONE_ID and CF_SAAS_API_TOKEN must be configured');
  }
  return { zoneId: env.CLOUDFLARE_ZONE_ID, token: env.CF_SAAS_API_TOKEN };
}

async function cfFetch(env: CFEnv, path: string, init: RequestInit = {}): Promise<unknown> {
  // Cloudflare for SaaS custom hostnames are zone-scoped, not account-scoped.
  const { zoneId, token } = requireCfCreds(env);
  const url = `${API}/zones/${zoneId}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const json = (await res.json()) as { success: boolean; result?: unknown; errors?: Array<{ message: string }> };
  if (!json.success) {
    const msg = json.errors?.map((e) => e.message).join('; ') ?? 'cloudflare api error';
    throw new Error(`cloudflare api: ${msg}`);
  }
  return json.result;
}

export async function addCustomHostname(env: CFEnv, hostname: string): Promise<CustomHostnameRow> {
  const r = await cfFetch(env, '/custom_hostnames', {
    method: 'POST',
    body: JSON.stringify({
      hostname,
      ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
    }),
  }) as Record<string, unknown>;
  return mapHostname(r);
}

export async function getCustomHostname(env: CFEnv, id: string): Promise<CustomHostnameRow> {
  const r = await cfFetch(env, `/custom_hostnames/${id}`) as Record<string, unknown>;
  return mapHostname(r);
}

export async function deleteCustomHostname(env: CFEnv, id: string): Promise<void> {
  await cfFetch(env, `/custom_hostnames/${id}`, { method: 'DELETE' });
}

function mapHostname(r: Record<string, unknown>): CustomHostnameRow {
  const ssl = (r.ssl as { status?: string; validation_records?: Array<{ txt_name?: string; txt_value?: string; http_url?: string; http_body?: string }> } | undefined) ?? {};
  const ownership = (r.ownership_verification as { type?: string; name?: string; value?: string } | undefined) ?? {};
  const httpOwnership = (r.ownership_verification_http as { http_url?: string; http_body?: string } | undefined) ?? {};
  const records: Array<{ type: string; name: string; value: string }> = [];
  if (ownership.type && ownership.name && ownership.value) {
    records.push({ type: ownership.type, name: ownership.name, value: ownership.value });
  }
  if (httpOwnership.http_url && httpOwnership.http_body) {
    records.push({ type: 'http', name: httpOwnership.http_url, value: httpOwnership.http_body });
  }
  for (const v of ssl.validation_records ?? []) {
    if (v.txt_name && v.txt_value) records.push({ type: 'TXT', name: v.txt_name, value: v.txt_value });
    if (v.http_url && v.http_body) records.push({ type: 'http', name: v.http_url, value: v.http_body });
  }
  return {
    id: String(r.id),
    hostname: String(r.hostname),
    status: (r.status as CustomHostnameStatus) ?? 'pending',
    ssl_status: ssl.status,
    ownership_records: records,
    verification_errors: (r.verification_errors as string[] | undefined) ?? [],
  };
}
