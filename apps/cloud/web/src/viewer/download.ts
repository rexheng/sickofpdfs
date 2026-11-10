// "Download this PDF": the cloud's copy, saved by the browser under the reading's file name. It is the fallback for a PDF too
// big to open here, and for anyone who wants the file itself. Same origin, with the session cookie, like every other call.
import { parseViewerUrl } from '@ext/shared/viewer-url';

/** The cloud address of a reading's PDF. */
export const blobHref = (sha: string): string => `/api/blobs/${sha}`;

/** A file name for the download: the reading's name, ending in .pdf. */
export function downloadName(name: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const base = (name ?? '').replace(/[\u0000-\u001f\u007f/\\]/gu, ' ').trim().slice(0, 200) || 'Reading';
  return /\.pdf$/iu.test(base) ? base : `${base}.pdf`;
}

/** Starts the browser's download of `sha` (the PDF this viewer shows, when not given). */
export function downloadPdf(o: { sha?: string; name?: string | null } = {}): void {
  const p = parseViewerUrl(location.href);
  const sha = o.sha ?? p.doc ?? '';
  if (!/^[0-9a-f]{64}$/.test(sha)) return;
  const a = document.createElement('a');
  a.href = blobHref(sha);
  a.download = downloadName(o.name ?? document.title.replace(/ - sickofpdfs$/u, ''));
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}
