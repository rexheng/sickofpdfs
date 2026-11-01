import type { LocationId, LocationKind } from '../ids';
import { canonicalLink } from './canonical-link';
import { sha256Hex } from './fingerprint';

/** Decodes every `%XX` run that is valid UTF-8 and leaves a run that is not (a lone `%` is left too). */
function decodePercent(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * The one spelling of a `file:` URL: readable (decoded once, so spaces, `#`, `%` and non-ASCII letters are plain
 * text), accents precomposed (NFC), a drive letter in upper case, `//` collapsed, and no query or fragment.
 * `localhost` is the same as no host. The case of the rest of the path is kept. Not a `file:` URL: returned unchanged.
 * The result is for comparing and hashing, not for opening.
 */
export function canonicalFileLocation(fileUrl: string): string {
  let url: URL;
  try {
    url = new URL(fileUrl);
  } catch {
    return fileUrl;
  }
  if (url.protocol !== 'file:') return fileUrl;
  const host = url.hostname === 'localhost' ? '' : url.hostname;
  let path = decodePercent(url.pathname).normalize('NFC').replace(/\/{2,}/g, '/');
  // a leading "//" (as in file:////server/share/a.pdf) marks a network path: it stays, so it is never taken for a local path
  if (url.pathname.startsWith('//')) path = `/${path}`;
  path = path.replace(/^\/([a-zA-Z]):(?=\/|$)/, (_, drive: string) => `/${drive.toUpperCase()}:`);
  return `file://${host}${path}`;
}

/** The canonical form of a location: web links by `canonicalLink`, files by `canonicalFileLocation`. */
export function canonicalLocation(kind: LocationKind, raw: string): string {
  return kind === 'file' ? canonicalFileLocation(raw) : canonicalLink(raw);
}

/**
 * A location's id: the SHA-256 of `<kind>:<canonical>`.
 *
 * Note (ruling R16): the spec says "a location's id is a hash of its canonical link". This is that, with the kind
 * as a prefix, so a `url` and a `file` location that happen to have the same text can never collide. The prefix
 * is part of the id format: changing it changes every stored id, so the test pins one value.
 */
export async function locationId(kind: LocationKind, canonical: string): Promise<LocationId> {
  return (await sha256Hex(`${kind}:${canonical}`)) as string as LocationId;
}
