import { sendRuntimeMessage } from '../shared/send-message';
import { stripFragment } from '../shared/urls';

/**
 * The address to show in Chrome's viewer so it opens where the reader was: `#page=N` (a PDF open parameter Chrome's
 * viewer follows) for any page after the first, in place of any fragment the address had. Page 1 needs none, so the
 * address is then left exactly as it was.
 */
export function atPage(source: string, page: number | undefined): string {
  if (page === undefined || !Number.isInteger(page) || page <= 1) return source;
  return `${stripFragment(source)}#page=${page}`;
}

/**
 * The escape hatch: shows this PDF in Chrome's own viewer, once. It must work whatever state the viewer is in (the
 * PDF failed to load, it is too big, the person just prefers Chrome's), so it depends on nothing but the address.
 * Returns false when Chrome would not open it (a local file without "Allow access to file URLs").
 */
export async function openInChrome(source: string): Promise<boolean> {
  try {
    return (await sendRuntimeMessage({ type: 'takeover:open-in-chrome', url: source })).ok;
  } catch {
    return false;
  }
}
