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
  CLOUDFLARE_ACCOUNT_ID?: string;       // for SaaS custom hostnames
  CLOUDFLARE_API_TOKEN?: string;        // secret with Custom Hostnames Write
  TEMPO_RPC_URL?: string;               // EVM JSON-RPC endpoint
  TEMPO_USDC_CONTRACT?: string;
  TEMPO_USDT_CONTRACT?: string;
  TEMPO_USDC_DECIMALS?: string;
  TEMPO_USDT_DECIMALS?: string;
};

export type AuthCtx =
  | { kind: 'anonymous' }
  | { kind: 'user'; userId: string; apiKeyId: string };
