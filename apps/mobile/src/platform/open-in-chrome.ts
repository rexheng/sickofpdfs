// The app's version of apps/extension/src/viewer/open-in-chrome.ts (swapped in by vite.config.ts). The phone has no Chrome
// viewer to hand a PDF to, so the escape hatch says no and the viewer offers what it offers when Chrome refuses.
export { atPage } from '@ext/viewer/open-in-chrome';

export function openInChrome(source: string): Promise<boolean> {
  void source;
  return Promise.resolve(false);
}
