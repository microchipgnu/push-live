import type { Env } from '../types.ts';

export async function sendCodeEmail(env: Env, to: string, code: string): Promise<void> {
  const subject = `Your sign-in code: ${code}`;
  const text = `Your one-time sign-in code is: ${code}\n\nThis code expires in 10 minutes.\nIf you didn't request this, ignore this email.`;
  const from = env.EMAIL_FROM ?? `push-live <noreply@${env.PUBLIC_APEX_HOST}>`;

  // Preferred: Cloudflare Email Sending binding (env.EMAIL.send).
  // We try it and fall back to other transports only if the binding throws —
  // useful when running locally with `wrangler dev` where the binding may not
  // be wired up or the sender domain isn't verified.
  if (env.EMAIL) {
    try {
      await env.EMAIL.send({ to, from, subject, text });
      return;
    } catch (e) {
      console.error('[email] cloudflare EMAIL.send failed, falling back', e);
    }
  }
  if (env.MAILCHANNELS_API_KEY) {
    await sendViaMailChannels(env.MAILCHANNELS_API_KEY, from, to, subject, text);
    return;
  }
  if (env.RESEND_API_KEY) {
    await sendViaResend(env.RESEND_API_KEY, from, to, subject, text);
    return;
  }
  // Dev fallback — also returned inline on the request-code response as `devCode`.
  console.log(`[email] sign-in code for ${to}: ${code}`);
}

async function sendViaMailChannels(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const { name, email } = splitFrom(from);
  const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email, name },
      subject,
      content: [{ type: 'text/plain', value: text }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('[email] mailchannels failed', res.status, body);
    throw new Error(`mailchannels send failed: ${res.status}`);
  }
}

async function sendViaResend(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('[email] resend failed', res.status, body);
    throw new Error(`resend send failed: ${res.status}`);
  }
}

function splitFrom(s: string): { name?: string; email: string } {
  const m = /^(.*?)\s*<([^>]+)>$/.exec(s);
  if (m) return { name: m[1].trim() || undefined, email: m[2].trim() };
  return { email: s.trim() };
}
