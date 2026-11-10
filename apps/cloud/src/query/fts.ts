// Search input becomes a safe FTS5 expression: a few quoted words, never raw `MATCH` text. Whatever the person (or Claude)
// types, no FTS5 operator, column filter, NEAR or quote can get through.
const MAX_TERMS = 12;
const MAX_TERM_LENGTH = 64;

/** `"word" "word" "last"*`, or null when there is nothing to search for. Words are letters and digits, as the index sees them. */
export function ftsQuery(text: string): string | null {
  const words = text.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = words.slice(0, MAX_TERMS).map((w) => w.slice(0, MAX_TERM_LENGTH));
  if (terms.length === 0) return null;
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 && t.length >= 2 ? '*' : ''}`).join(' ');
}

/** An opaque cursor: a small JSON object. A bad or foreign cursor reads as "from the start". */
export function encodeCursor(value: Record<string, number>): string {
  return btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string | undefined, keys: string[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  if (!cursor || cursor.length > 200) return out;
  try {
    const parsed = JSON.parse(atob(cursor.replaceAll('-', '+').replaceAll('_', '/'))) as Record<string, unknown>;
    for (const k of keys) {
      const v = parsed[k];
      if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000) out[k] = v;
    }
  } catch {
    /* from the start */
  }
  return out;
}

/** `%` and `_` in a LIKE pattern are plain characters. Use with `ESCAPE '\'`. */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}
