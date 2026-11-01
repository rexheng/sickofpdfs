/** How long the object URL lives: long enough for Chrome to start writing the file, however slow the disk. */
const REVOKE_AFTER_MS = 60_000;

/**
 * Ctrl+S, File → Download and the toolbar's Download: saves the original bytes, unchanged, under the PDF's own name.
 * An `<a download>` on an object URL, so it needs no "downloads" permission and the bytes never leave the tab. The URL
 * is revoked after 60 s.
 */
export function downloadOriginal(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
