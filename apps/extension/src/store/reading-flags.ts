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
