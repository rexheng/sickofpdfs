// The errors PdfBackend calls reject with (see the PdfBackend comment in types.ts). The engine worker sends them as
// { name, message, wrongPassword?, reason? } and rpc.ts makes them again by name, so `instanceof` works on the page.

/** The PDF needs a password. `wrongPassword` is true when one was given and it was wrong, false when none was given. */
export class PdfPasswordError extends Error {
  override readonly name = 'PdfPasswordError';
  readonly wrongPassword: boolean;
  constructor(wrongPassword: boolean, message = wrongPassword ? 'The password is wrong.' : 'This PDF needs a password.') {
    super(message);
    this.wrongPassword = wrongPassword;
  }
}

/** The file is not a PDF, or is damaged beyond repair (PDFium's FPDF_ERR_FILE or FPDF_ERR_FORMAT). */
export class PdfFormatError extends Error {
  override readonly name = 'PdfFormatError';
  constructor(message = 'This file is not a PDF, or it is damaged.') {
    super(message);
  }
}

/** Why the engine stopped. */
export type EngineFailure = 'crashed' | 'hung' | 'out-of-memory';

/**
 * The engine stopped: it crashed, gave no answer within the watchdog time, or ran out of memory. Documents that were
 * open in it are lost; open them again (the next `open` starts a fresh engine).
 */
export class PdfEngineCrashedError extends Error {
  override readonly name = 'PdfEngineCrashedError';
  readonly reason: EngineFailure;
  constructor(reason: EngineFailure, detail?: string) {
    const what = reason === 'hung' ? 'stopped answering' : reason === 'out-of-memory' ? 'ran out of memory' : 'crashed';
    super(`The PDF engine ${what}${detail ? ` (${detail})` : ''}. Open the document again.`);
    this.reason = reason;
  }
}
