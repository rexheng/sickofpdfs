// Cloudflare Turnstile's server check. Only the token and our secret are sent; the visitor's IP address is not.

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileResult = 'passed' | 'failed' | 'unreachable';

export async function verifyTurnstile(secret: string, token: unknown): Promise<TurnstileResult> {
  // Turnstile tokens are at most 2048 characters
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return 'failed';
  try {
    const res = await fetch(SITEVERIFY, {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return 'unreachable';
    const out: { success?: unknown } = await res.json();
    return out.success === true ? 'passed' : 'failed';
  } catch {
    return 'unreachable';
  }
}
