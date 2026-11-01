/** A SHA-256 as 64 lower-case hex characters. Made only by `createSha256` and `sha256Hex`. */
export type Sha256 = string & { readonly __sha256: unique symbol };

/** A document is the SHA-256 of its file's bytes. */
export type DocumentId = Sha256;

/** A location is the SHA-256 of `<kind>:<canonical link>` (see `locationId`). */
export type LocationId = string & { readonly __location: unique symbol };

/** Where a document was opened from: a web address, or a file on the computer. */
export type LocationKind = 'url' | 'file';

/** A mark row (highlight, underline, bold, strikethrough or area). Made once by the writer, from `crypto.randomUUID()`. */
export type MarkId = string & { readonly __mark: unique symbol };

/** A comment thread. Made once by the writer, from `crypto.randomUUID()`. */
export type ThreadId = string & { readonly __thread: unique symbol };

/** A comment or reply. Made once by the writer, from `crypto.randomUUID()`. */
export type CommentId = string & { readonly __comment: unique symbol };

/** A viewer page load. Random per load; it owns the drafts it made. */
export type TabId = string & { readonly __tab: unique symbol };

/** Who wrote a row. These are the v1 CHECK values; MCP shows 'me' as 'user'. */
export type Author = 'me' | 'claude';
