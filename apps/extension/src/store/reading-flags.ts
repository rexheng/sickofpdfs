// What a reading's row says about the meaning features (spec R102, extended by the controller's ruling of Nov 6).
//
// A reading the owner saved after the filter judged it "not learning" (a receipt, a bank statement, a payslip, a CV saved on
// purpose) stays in the library and stays searchable, unless D9 applies (then its text is kept out of search too). But it is
// never understood: it never appears in Related readings, in either direction, and never gets topics or auto tags. It never goes
// online either: the online lookups never ask about it (controller ruling, Nov 6).
//
// The flag is one of the reading's save reasons, written by the save itself (`saveDocument`, one transaction). Save reasons are
// reading data: they travel with the document row in the backup, a restore and (Release 2) sync, so the flag does too, with no
// change to the row's shape. It is never shown: the saved chip says why it was saved from the reasons of that save, not this one.

/** The save reason that marks a reading the owner saved although the filter judged it not learning. */
export const SAVED_THOUGH_NOT_LEARNING = 'not-learning:saved-by-owner';

/** SQL: the reading is understood and may go online. The reason is a fixed word with no `%`, `_` or quote, so it is safe in the pattern. */
const understood = (column: (name: string) => string): string => `${column('index_text')} = 1 AND ${column('save_reasons')} NOT LIKE '%"${SAVED_THOUGH_NOT_LEARNING}"%'`;

/**
 * SQL, over `documents` as `d`: a reading the categoriser may read and understand. Its text is in the library (not D9) and it was
 * not saved against the filter's "not learning".
 */
export const UNDERSTOOD = understood((name) => `d.${name}`);

/**
 * The same, over `documents` with no alias: a reading the online lookups may ask about (store/lookups-api.ts). A reading judged
 * "not learning" never goes online, D9 or not (controller ruling, Nov 6).
 */
export const MAY_GO_ONLINE = understood((name) => name);

// ---- R103: a reading made from a web page ("Save this page to library") ----
//
// Three save reasons mark it, written by its save like the flag above, so they go with the reading into backups, a restore and
// sync, with no change to the row's shape. None is ever shown as words:
// - `web-page`: it is a web page saved as a PDF. The library shows a small "Web page" kind beside its title.
// - `web-page:text:<sha256>`: a fingerprint of the article's words. Saving the same link again compares it: the same words open
//   this reading; changed words make a new version.
// - `web-page:earlier:<document id>`: the earlier version of the same page, which About this PDF links to.

/** The save reason of every reading made from a web page. */
export const WEB_PAGE = 'web-page';
const WEB_TEXT = 'web-page:text:';
const WEB_EARLIER = 'web-page:earlier:';
const HEX64 = /^[0-9a-f]{64}$/u;

/** The save reasons a web page's reading is saved with. */
export function webPageReasons(o: { textHash: string; earlier: string | null }): string[] {
  return [WEB_PAGE, `${WEB_TEXT}${o.textHash}`, ...(o.earlier !== null ? [`${WEB_EARLIER}${o.earlier}`] : [])];
}

/** What a reading's save reasons say about the web page it was made from; null when it was not made from one. */
export function webPageOf(saveReasons: readonly string[] | null | undefined): { textHash: string | null; earlier: string | null } | null {
  if (!Array.isArray(saveReasons) || !saveReasons.includes(WEB_PAGE)) return null;
  const reasons: readonly unknown[] = saveReasons;
  const pick = (prefix: string): string | null => {
    const found = reasons.find((r): r is string => typeof r === 'string' && r.startsWith(prefix));
    const value = found === undefined ? null : found.slice(prefix.length);
    return value !== null && HEX64.test(value) ? value : null;
  };
  return { textHash: pick(WEB_TEXT), earlier: pick(WEB_EARLIER) };
}
