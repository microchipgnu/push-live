export type CfEmailMessage = {
  to: string;
  from: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
};

export interface CfEmailBinding {
  send(message: CfEmailMessage): Promise<void>;
}

export type Env = {
  DB: D1Database;
  KV: KVNamespace;
  SITES: R2Bucket;
  EMAIL?: CfEmailBinding;          // Cloudflare Email Sending (beta) — preferred
  PUBLIC_APEX_HOST: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  SIGNING_KEY: string;
  RESEND_API_KEY?: string;
  MAILCHANNELS_API_KEY?: string;
  EMAIL_FROM?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;       // legacy; no longer read by cf-saas
  CLOUDFLARE_ZONE_ID?: string;          // push-live.com zone for SaaS custom hostnames
  // Runtime token for cf-saas only (Zone SSL & Certificates: Edit). Deliberately
  // NOT named CLOUDFLARE_API_TOKEN — that name is the GitHub Actions deploy token
  // (account-scoped) and the two must never be conflated.
  CF_SAAS_API_TOKEN?: string;
  TEMPO_RPC_URL?: string;               // EVM JSON-RPC endpoint
  TEMPO_USDC_CONTRACT?: string;
  TEMPO_USDT_CONTRACT?: string;
  TEMPO_USDC_DECIMALS?: string;
  TEMPO_USDT_DECIMALS?: string;
};

export type AuthCtx =
  | { kind: 'anonymous' }
  | { kind: 'user'; userId: string; apiKeyId: string };
