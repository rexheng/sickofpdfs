import { sendRuntimeMessage } from '../shared/send-message';
import type { ViewerParams } from '../shared/viewer-url';

const isJumpEntry = (state: unknown) => typeof state === 'object' && state !== null && (state as { sopJump?: unknown }).sopJump === true;

/** The page a "Back to page" button may go to: a web or local page, never javascript: or another scheme. */
export function backTarget(p: ViewerParams): string | null {
  if (p.back === null) return null;
  try {
    const { protocol } = new URL(p.back);
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:' ? p.back : null;
  } catch {
    return null;
  }
}

/**
 * "Back to page": the page that held the PDF is not to send the tab back here (its embedded PDFs are suppressed in
 * this tab until it goes elsewhere), then the tab goes back in its history to the step before the viewer. A tab that
 * has no earlier step (the viewer was opened on its own) loads the page.
 */
export async function goBackToPage(p: ViewerParams): Promise<void> {
  const back = backTarget(p);
  if (back === null) return;
  try {
    await sendRuntimeMessage({ type: 'takeover:suppress-embeds', pageUrl: back });
  } catch {
    // The worker did not answer; going back still works, the page may just send the tab here again.
  }
  // A jump inside the PDF (a link) added one entry of its own (jump-history.ts): step over it too.
  const steps = isJumpEntry(history.state) ? 2 : 1;
  if (history.length > steps) history.go(-steps);
  else location.assign(back);
}
