// The offscreen document that owns the library database. Chrome allows one per extension, so every caller shares it.
import { OFFSCREEN_PATH } from '../store/transport';

const JUSTIFICATION = 'Owns the local library database';

async function offscreenExists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

let ensuring: Promise<void> | null = null;

/**
 * Makes sure the offscreen document exists. Callers at the same moment share one creation. If creating fails, the check
 * runs again: another caller may have created it in between (Chrome then refuses a second one), and that is success.
 */
export function ensureOffscreen(): Promise<void> {
  ensuring ??= (async () => {
    try {
      if (await offscreenExists()) return;
      try {
        await chrome.offscreen.createDocument({ url: OFFSCREEN_PATH, reasons: ['WORKERS'], justification: JUSTIFICATION });
      } catch (error) {
        if (await offscreenExists()) return;
        throw error;
      }
    } finally {
      ensuring = null;
    }
  })();
  return ensuring;
}
