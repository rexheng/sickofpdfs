// The web's version of apps/extension/src/viewer/open-in-chrome.ts (swapped in by vite.config.ts). A web page cannot hand a PDF
// to Chrome's own viewer, so the escape hatch says no (the header offers Download instead).
export { atPage } from '@ext/viewer/open-in-chrome';

export function openInChrome(source: string): Promise<boolean> {
  void source;
  return Promise.resolve(false);
}
