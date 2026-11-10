// The real numbers on the home page (spec R111). Nothing here is ever typed in by hand.
//
//   GET /api/count -> { waitlist: number, users: number | null }
//
// `waitlist` is the number of addresses on the waitlist (the 'waitlist' row, kept exact by the database's triggers).
// `users` is the public user count on the Chrome Web Store listing. It stays null until CWS_ITEM_ID is set; after that, the
// daily job reads the number from the listing page and keeps it in the 'cws_users' row.

import type { Env } from './env';
import { json } from './http';

/** A Chrome Web Store item id: 32 letters from a to p. */
const ITEM_ID = /^[a-p]{32}$/;

export function storeItemId(env: Env): string | null {
  const id = env.CWS_ITEM_ID.trim();
  return ITEM_ID.test(id) ? id : null;
}

export async function countResponse(env: Env): Promise<Response> {
  try {
    const rows = await env.SITE_DB.prepare("SELECT name, value FROM counts WHERE name IN ('waitlist', 'cws_users')").all<{ name: string; value: number }>();
    const value = (name: string) => rows.results.find((r) => r.name === name)?.value ?? null;
    const users = storeItemId(env) === null ? null : value('cws_users');
    return json({ waitlist: value('waitlist') ?? 0, users }, 200, 'no-cache');
  } catch {
    return json({ error: 'unavailable' }, 503);
  }
}

/** The daily job: read the listing's user count and keep it. Does nothing while CWS_ITEM_ID is not set. */
export async function refreshStoreUsers(env: Env): Promise<void> {
  const id = storeItemId(env);
  if (id === null) return;
  const res = await fetch(`https://chromewebstore.google.com/detail/${id}?hl=en`, {
    headers: { 'accept-language': 'en', 'user-agent': 'Mozilla/5.0 (compatible; sickofpdfs-site)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Chrome Web Store listing answered ${res.status}`);
  const users = parseStoreUsers(await res.text());
  if (users === null) throw new Error('no user count on the Chrome Web Store listing');
  await env.SITE_DB.prepare(
    "INSERT INTO counts (name, value, updated_at) VALUES ('cws_users', ?1, ?2) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(users, Date.now())
    .run();
}

/**
 * The user count from a listing page, as the store shows it in the line under the title ("22,000,000 users", "1 user").
 * The first such text is taken; the description, which can mention "users" too, comes later in the page.
 */
export function parseStoreUsers(html: string): number | null {
  const m = />\s*(\d{1,3}(?:,\d{3})*|\d+)\+?\s+users?\s*</.exec(html);
  if (!m?.[1]) return null;
  const n = Number(m[1].replaceAll(',', ''));
  return Number.isSafeInteger(n) ? n : null;
}
