// What every page of the app listens for: a PDF Android hands the app while it runs ("Open with", Share), and the Back button.
import { buildViewerUrl } from '@ext/shared/viewer-url';
import { navigate } from './chrome-shim';
import { isNativeApp, SopPlatform } from './native';

/** The viewer page for a PDF Android handed the app (viewer-main.tsx reads it, then removes the copy). */
export const incomingViewerUrl = (id: string): string => `${location.origin}/viewer.html?incoming=${encodeURIComponent(id)}`;

/** The library's first page. */
export const homeUrl = (): string => `${location.origin}/library.html#/home`;

/** The viewer page for a saved reading. */
export const readingUrl = (doc: string, name: string): string => buildViewerUrl({ source: null, back: null, page: null, name, doc });

/** Takes a waiting PDF, if there is one, and opens it. Pages call this when they start, so none is missed between pages. */
export async function openWaitingPdf(o: { replace?: boolean } = {}): Promise<boolean> {
  if (!isNativeApp()) return false;
  const { pdf } = await SopPlatform.takeIncoming().catch(() => ({ pdf: null }));
  if (pdf === null) return false;
  navigate(incomingViewerUrl(pdf.id), o);
  return true;
}

/** The menus, dialogs and panels that Back closes before it leaves the page (Radix's and the viewer's own). */
const OPEN_LAYERS = ['[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', '[role="listbox"]', '[data-radix-popper-content-wrapper]'].join(',');

/** Closes the top menu or dialog the way Escape does. False when nothing was open. */
function closeTopLayer(): boolean {
  if (document.querySelector(OPEN_LAYERS) === null) return false;
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  return true;
}

/** Starts listening. Call once per page, after the chrome shim. */
export function listenForAppEvents(): void {
  if (!isNativeApp()) return;
  void SopPlatform.addListener('incoming', () => void openWaitingPdf());
  void SopPlatform.addListener('back', () => {
    if (closeTopLayer()) return;
    void SopPlatform.goBack();
  });
}
