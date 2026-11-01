/**
 * The name to show for a PDF, as Chrome would name its download:
 * 1. the Content-Disposition `filename*` (RFC 6266 / 5987, e.g. `UTF-8''caf%C3%A9.pdf`), then its `filename`;
 * 2. otherwise the last non-empty segment of the address's path, percent-decoded (the query is ignored);
 * 3. otherwise `fallback`.
 * A name from 1 or 2 that does not end in ".pdf" (any case) gets ".pdf" added, so arXiv's `/pdf/1706.03762` shows as
 * "1706.03762.pdf". Folders in a name and control characters are dropped.
 */
export function displayNameFor(url: string | null, contentDisposition: string | null, fallback = 'document.pdf'): string {
  const name = (contentDisposition !== null ? fromContentDisposition(contentDisposition) : null) ?? (url !== null ? fromUrl(url) : null);
  if (name === null) return fallback;
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

/** `;\s*name=value`, where value is a quoted string (with backslash escapes) or runs to the next `;`. */
const PARAM = /;\s*([^\s=;]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;

function fromContentDisposition(header: string): string | null {
  const params = new Map<string, string>();
  for (const m of header.matchAll(PARAM)) {
    const key = m[1].toLowerCase();
    if (!params.has(key)) params.set(key, m[2].trim());
  }
  const extended = params.get('filename*');
  const fromExtended = extended !== undefined ? decodeExtended(unquote(extended)) : null;
  if (fromExtended !== null) return clean(fromExtended);
  const plain = params.get('filename');
  if (plain === undefined) return null;
  const value = unquote(plain);
  // Some servers percent-encode a plain filename; Chrome decodes it when it is valid UTF-8.
  return clean(/%[0-9a-f]{2}/i.test(value) ? (tryDecode(value) ?? value) : value);
}

/** RFC 5987 ext-value: `charset'language'pct-encoded`. UTF-8 and ISO-8859-1 are understood. */
function decodeExtended(value: string): string | null {
  const m = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (!m) return null;
  const charset = m[1].toLowerCase();
  if (charset === 'utf-8' || charset === 'utf8') return tryDecode(m[2]);
  if (charset === 'iso-8859-1' || charset === 'latin1') {
    return m[2].replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  return null;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value;
}

function fromUrl(url: string): string | null {
  let path: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return null;
    path = parsed.pathname;
  } catch {
    return null;
  }
  const segment = path.split('/').filter((s) => s !== '').pop();
  if (segment === undefined) return null;
  return clean(tryDecode(segment) ?? segment);
}

function tryDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** The last path part of `name`, without control characters and surrounding space; null when nothing is left. */
function clean(name: string): string | null {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const base = (name.split(/[/\\]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base === '' ? null : base;
}
