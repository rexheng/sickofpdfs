import { cleanLink } from '@sop/core/canonical-link';

/**
 * The link File → Copy link puts on the clipboard. A web link loses its fragment and its tracking and signing
 * parameters, and the rest are sorted (cleanLink); a file: link, or anything else, is copied as it is.
 */
export function linkForCopy(source: string): string {
  return /^https?:/i.test(source) ? cleanLink(source) : source;
}

/** Writes `linkForCopy(source)` to the clipboard. Resolves false when the browser refused (the tab lost focus). */
export async function copyLink(source: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(linkForCopy(source));
    return true;
  } catch {
    return false;
  }
}
