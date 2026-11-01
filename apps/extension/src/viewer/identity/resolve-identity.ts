// Which library document the open PDF is, if any (Task 30). It only reads, with one exception: a stamped re-download of
// a saved paper (the same text once the download stamp is removed) is recorded as an alias of it, because that PDF is
// already in the library. It never records an open or a location: the save controller does that, once, for a PDF
// that turns out to be known.
import type { DocumentId, Sha256 } from '@sop/core';
import type { StoreApi } from '../../store/store-api';

export type IdentityResult = { kind: 'known'; documentId: DocumentId; via: 'fingerprint' | 'alias' } | { kind: 'unknown' };

type IdentityStore = Pick<StoreApi, 'resolveFingerprint' | 'countDocumentsWithPageCount' | 'findStampAlias' | 'addAlias'>;

/**
 * 1. The fingerprint (the file's SHA-256): a library document, or a stamped copy already recorded as its alias.
 * 2. Otherwise, only if some library document has the same page count, the page text is read and compared with
 *    theirs once stamps, IP addresses and dates are removed (`findStampAlias`, 99.5% and the alias rule R59).
 */
export async function resolveIdentity(i: { sha256: Sha256; pageCount: number; pageTexts(): Promise<string[]> }, store: IdentityStore): Promise<IdentityResult> {
  const known = await store.resolveFingerprint(i.sha256);
  if (known !== null) return { kind: 'known', documentId: known, via: 'fingerprint' };
  if ((await store.countDocumentsWithPageCount(i.pageCount)) === 0) return { kind: 'unknown' };
  const match = await store.findStampAlias(i.pageCount, await i.pageTexts());
  if (match === null) return { kind: 'unknown' };
  await store.addAlias(i.sha256, match.documentId, match.similarity);
  return { kind: 'known', documentId: match.documentId, via: 'alias' };
}
