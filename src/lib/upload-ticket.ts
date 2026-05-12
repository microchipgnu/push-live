import { hmacSign } from './hash.ts';

// A signed upload ticket lets a client PUT bytes through the worker without
// needing R2 presigned URLs (useful for local dev or accounts without R2 keys).

export type Ticket = {
  key: string;              // R2 destination key
  contentType: string;
  exp: number;              // unix seconds
  maxSize: number;
};

export async function signTicket(secret: string, t: Ticket): Promise<string> {
  const payload = JSON.stringify(t);
  const b64 = b64urlEncode(new TextEncoder().encode(payload));
  const sig = await hmacSign(secret, b64);
  return `${b64}.${sig}`;
}

export async function verifyTicket(secret: string, token: string): Promise<Ticket | null> {
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const b64 = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = await hmacSign(secret, b64);
  if (expected !== sig) return null;
  try {
    const payload = new TextDecoder().decode(b64urlDecode(b64));
    const t = JSON.parse(payload) as Ticket;
    if (t.exp < Math.floor(Date.now() / 1000)) return null;
    return t;
  } catch {
    return null;
  }
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
