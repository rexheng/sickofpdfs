// "+ New" → Open file: the PDF opens in the viewer in a new tab, and the viewer and its filter decide whether it is saved
// (plan S7, ruling R76). The library writes nothing here: the viewer reads the picked file itself, through a blob: link
// that lives only in this page's memory and points at the file on disk. (Upload PDF saves instead: data/upload.ts.)
import { buildViewerUrl } from '../../shared/viewer-url';

/** Every PDF starts with "%PDF-" in its first 1024 bytes (where PDF readers look for it). */
const SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d];
const HEAD = 1024;

export async function looksLikePdf(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, HEAD).arrayBuffer());
  for (let i = 0; i + SIGNATURE.length <= head.length; i++) {
    if (SIGNATURE.every((b, j) => head[i + j] === b)) return true;
  }
  return false;
}

/**
 * Opens a picked PDF in a new viewer tab. 'not-pdf' when the file is something else. The blob link stays valid while
 * this library tab is open (so the viewer can reload it); closing the library tab ends it.
 */
export async function openPickedPdf(file: File): Promise<'opened' | 'not-pdf'> {
  if (!(await looksLikePdf(file))) return 'not-pdf';
  const link = URL.createObjectURL(file);
  // The name goes with it, so the viewer can call the PDF by its file name (R76) when the PDF has no title of its own.
  await chrome.tabs.create({ url: buildViewerUrl({ source: link, back: null, page: null, name: file.name }) });
  return 'opened';
}

/**
 * "+ New" → Paste link: what was pasted as a link we can open, or null. A bare "www.example.org/paper.pdf" gets
 * https:// in front. Only web links and files on this computer are opened.
 */
export function linkToOpen(text: string): string | null {
  const t = text.trim();
  if (t === '' || /\s/.test(t)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : /^[\w-]+(\.[\w-]+)+(\/|$)/.test(t) ? `https://${t}` : null;
  if (withScheme === null) return null;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'file:' ? url.href : null;
  } catch {
    return null;
  }
}
