/** A SHA-256 as 64 lower-case hex characters. Made only by `createSha256` and `sha256Hex`. */
export type Sha256 = string & { readonly __sha256: unique symbol };

/** A document is the SHA-256 of its file's bytes. */
export type DocumentId = Sha256;

/** A location is the SHA-256 of `<kind>:<canonical link>` (see `locationId`). */
export type LocationId = string & { readonly __location: unique symbol };

/** Where a document was opened from: a web address, or a file on the computer. */
export type LocationKind = 'url' | 'file';
