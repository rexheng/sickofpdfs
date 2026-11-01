import { sendRuntimeMessage } from '../shared/send-message';

const isJumpEntry = (state: unknown) => typeof state === 'object' && state !== null && (state as { sopJump?: unknown }).sopJump === true;

/**
 * The page a "Back to page" button may go to: the one the service worker saw embed this PDF in this tab
 * (takeover:prepare-fetch's `back`), and only a web or local page, never javascript: or another scheme. The `back` in
 * the viewer's own address is never used: any web page can write one, and the button would send the owner there.
 */
export function backTarget(back: string | null): string | null {
  if (back === null) return null;
  try {
    const { protocol } = new URL(back);
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:' ? back : null;
  } catch {
    return null;
  }
}

/**
 * "Back to page": the page that held the PDF is not to send the tab back here (its embedded PDFs are suppressed in
 * this tab until it goes elsewhere), then the tab goes back in its history to the step before the viewer. A tab that
 * has no earlier step (the viewer was opened on its own) loads the page.
 */
export async function goBackToPage(back: string): Promise<void> {
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
