import { AwsClient } from 'aws4fetch';
import type { Env } from '../types.ts';
import { signTicket } from './upload-ticket.ts';

export type PresignOpts = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function hasR2Credentials(env: Env): boolean {
  return Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ACCOUNT_ID && env.R2_ACCOUNT_ID !== 'REPLACE_ME');
}

export async function uploadUrlFor(
  env: Env,
  origin: string,
  key: string,
  contentType: string,
  maxSize = 5 * 1024 * 1024 * 1024,
  expiresSeconds = 3600,
): Promise<string> {
  if (hasR2Credentials(env)) {
    return presignPut(
      {
        accountId: env.R2_ACCOUNT_ID,
        bucket: env.R2_BUCKET,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
      key,
      contentType,
      expiresSeconds,
    );
  }
  const ticket = await signTicket(env.SIGNING_KEY, {
    key,
    contentType,
    maxSize,
    exp: Math.floor(Date.now() / 1000) + expiresSeconds,
  });
  return `${origin}/__upload/${encodeURIComponent(ticket)}`;
}

export function r2Endpoint(o: PresignOpts): string {
  return `https://${o.accountId}.r2.cloudflarestorage.com/${o.bucket}`;
}

export async function presignPut(
  o: PresignOpts,
  key: string,
  contentType: string,
  expiresSeconds = 3600,
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: o.accessKeyId,
    secretAccessKey: o.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  const url = new URL(`${r2Endpoint(o)}/${encodePath(key)}`);
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  const req = await client.sign(
    new Request(url, { method: 'PUT', headers: { 'content-type': contentType } }),
    { aws: { signQuery: true } },
  );
  return req.url;
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}
