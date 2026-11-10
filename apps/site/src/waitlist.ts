// The cloud sync waitlist (spec R109, R111).
//
//   GET  /api/waitlist  -> { siteKey: string | null }   the public Turnstile key the form needs; null while it is not set up
//   POST /api/waitlist  { email, turnstileToken } -> { ok: true } | { ok: false, reason }
//
// A sign-up keeps only the email address (trimmed, lowercased) and the day. A duplicate is not stored again and still gets
// { ok: true }, so the page says thanks either way and nobody can use the form to find out who has joined.
// Each connection gets 5 tries a minute. The key for that counter is a hash of the IP address (an IPv6 address by its /64,
// so one home network is one key), held in Cloudflare's rate limiter for the minute; the address itself is never written down.

import { normalizeEmail } from './email';
import type { Env } from './env';
import { json, siteOrigin } from './http';
import { verifyTurnstile } from './turnstile';

export type JoinReason = 'bad_request' | 'origin' | 'rate_limited' | 'invalid_email' | 'bot_check' | 'unavailable';

const MAX_BODY = 4096;
const DAY_MS = 86_400_000;

const refuse = (reason: JoinReason, status: number) => json({ ok: false, reason }, status);

export function waitlistConfig(env: Env): Response {
  return json({ siteKey: env.TURNSTILE_SITE_KEY?.trim() || null }, 200, 'public, max-age=300');
}

export async function joinWaitlist(request: Request, env: Env): Promise<Response> {
  // Browsers always send Origin on a POST from a page. A form on another site may not post here.
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== siteOrigin(env.SITE_ORIGIN, request)) return refuse('origin', 403);

  const { success } = await env.RL_WAITLIST.limit({ key: await connectionKey(request) });
  if (!success) return refuse('rate_limited', 429);

  const body = await readJson(request);
  if (body === null) return refuse('bad_request', 400);

  // The email is checked before the bot check, so a typo can be fixed and sent again with the same Turnstile token.
  const email = normalizeEmail(body.email);
  if (email === null) return refuse('invalid_email', 400);

  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return refuse('unavailable', 503);
  const check = await verifyTurnstile(secret, body.turnstileToken);
  if (check === 'unreachable') return refuse('unavailable', 503);
  if (check !== 'passed') return refuse('bot_check', 403);

  const day = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  try {
    await env.SITE_DB.prepare('INSERT INTO waitlist (email, created_at) VALUES (?1, ?2) ON CONFLICT (email) DO NOTHING').bind(email, day).run();
  } catch {
    return refuse('unavailable', 503);
  }
  return json({ ok: true });
}

/** The rate limiter's key for this connection: a hash, so the IP address is not handed on as it is. */
async function connectionKey(request: Request): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  // an IPv6 address counts by its first four groups (its /64): one household or phone is one key, not 2^64 of them
  const scope = ip.includes(':') ? expandIpv6(ip).slice(0, 4).join(':') : ip;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`sop-waitlist:${scope}`));
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function expandIpv6(ip: string): string[] {
  const [head = '', tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''));
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_BODY) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return null;
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
