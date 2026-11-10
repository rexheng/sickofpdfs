// The waitlist's email rule: trimmed and lowercased, then a plain shape check. It does not try to accept every address the
// standard allows (quoted local parts, IP-literal domains); it refuses what is clearly a typo.

const MAX_LENGTH = 254;
const LOCAL = /^[^\s@"(),:;<>[\\\]]{1,64}$/u;
// a domain label: letters (any script), digits and inner hyphens
const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
// the last label: letters only, or a punycode name (xn--…)
const TOP = /^(?:\p{L}{2,63}|xn--[a-z0-9-]{1,59})$/u;

/** The address as it is stored, or null when it does not look like an email address. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const email = input.normalize('NFC').trim().toLowerCase();
  if (email.length > MAX_LENGTH) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0) return null;
  const local = email.slice(0, at);
  const labels = email.slice(at + 1).split('.');
  if (!LOCAL.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !TOP.test(labels.at(-1) ?? '')) return null;
  return email;
}
