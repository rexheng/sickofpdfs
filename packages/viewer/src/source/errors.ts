/**
 * Why a PDF could not be loaded (before the engine sees it).
 * - `http`: the server answered with an error status (`detail.status`).
 * - `network`: the request failed or broke off.
 * - `not-pdf`: the bytes do not start with `%PDF-` within the first 1024 bytes (a login page served as a PDF).
 *   `detail.size` is the bytes read so far, so 0 means the file was empty.
 * - `too-large`: more than the limit (`detail.size`: the announced or the counted size).
 * - `file-access`: a `file://` address could not be read (Chrome's "Allow access to file URLs" is off, or the file
 *   is gone).
 * - `aborted`: the caller's AbortSignal fired, or the person cancelled.
 */
export type PdfLoadErrorCode = 'http' | 'network' | 'not-pdf' | 'too-large' | 'file-access' | 'aborted';

export class PdfLoadError extends Error {
  override readonly name = 'PdfLoadError';
  constructor(
    readonly code: PdfLoadErrorCode,
    readonly detail: { status?: number; size?: number } = {},
  ) {
    super(describe(code, detail));
  }
}

function describe(code: PdfLoadErrorCode, detail: { status?: number; size?: number }): string {
  switch (code) {
    case 'http':
      return `The server answered with HTTP ${detail.status ?? '?'}.`;
    case 'network':
      return 'The download failed.';
    case 'not-pdf':
      return 'The address did not return a PDF.';
    case 'too-large':
      return `The file is ${detail.size ?? '?'} bytes, more than this viewer opens.`;
    case 'file-access':
      return 'The file could not be read.';
    case 'aborted':
      return 'Loading was cancelled.';
  }
}
