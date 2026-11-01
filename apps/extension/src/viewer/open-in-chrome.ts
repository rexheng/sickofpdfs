import { sendRuntimeMessage } from '../shared/send-message';

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
