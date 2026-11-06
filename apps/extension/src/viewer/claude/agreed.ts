// R105b: the owner's Send to "Send … to Anthropic?" is remembered per reading, on this computer only.
//
// A reading the owner never chose to save (a first note or a first mark saved it) asks before Claude reads it, in every tab and
// after every reload, until the owner presses Send once for it. That Send is kept here, in the local-only store (`sop-local`): a
// salted fingerprint of the reading's id with the reading's `createdAt`, nothing else. The backup, restore, export and sync cannot
// reach that store (eslint.config.mjs, ruling R14), so the Send never leaves this computer. Undo and Forget remove it
// (`forgetLocalTraces`). The Trash purge runs in the store worker, which cannot reach the store: a purged reading saved again has a
// new `createdAt`, so the old Send does not count for it, and the next Send the owner gives drops the Sends of readings the library
// no longer holds (`keepOnly`).
//
// Reads never create the database: until the owner has said Send (or kept a key), there is nothing to read.
import type { DocumentId } from '@sop/core';
import { LOCAL_ONLY_DB, openLocalOnlyStore, type LocalOnlyStore } from '../../local-only/secrets-store';
import { isIncognito } from '../incognito';

export interface ClaudeAgreements {
  /** Whether the owner said Send for this reading, saved at `createdAt`. False when it cannot be read: then Claude asks. */
  has(documentId: DocumentId, createdAt: number): Promise<boolean>;
  /** Keeps the owner's Send for this reading. */
  add(documentId: DocumentId, createdAt: number): Promise<void>;
  /** The reading was undone or forgotten: its Send goes too. */
  clear(documentId: DocumentId): Promise<void>;
  /** Keeps the Sends of these readings only (all the library holds, Trash included): a reading the Trash purge removed loses its. */
  keepOnly(documentIds: readonly DocumentId[]): Promise<void>;
}

let opened: Promise<LocalOnlyStore> | null = null;
const open = (): Promise<LocalOnlyStore> => {
  opened ??= openLocalOnlyStore().catch((e: unknown) => {
    opened = null;
    throw e;
  });
  return opened;
};

/** Whether the local-only database exists, without creating it. */
async function exists(): Promise<boolean> {
  try {
    return (await indexedDB.databases()).some((db) => db.name === LOCAL_ONLY_DB);
  } catch {
    return true; // cannot tell: opening it is harmless (a new one holds nothing)
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/** This computer's agreements. In Incognito nothing is kept, and nothing is read. */
export const claudeAgreements: ClaudeAgreements = {
  async has(documentId, createdAt) {
    if (isIncognito() || !HEX64.test(documentId) || !(await exists())) return false;
    try {
      return await (await open()).isClaudeAgreed(documentId, createdAt);
    } catch {
      return false;
    }
  },
  async add(documentId, createdAt) {
    if (isIncognito() || !HEX64.test(documentId)) return;
    await (await open()).addClaudeAgreed(documentId, createdAt);
  },
  async clear(documentId) {
    if (isIncognito() || !HEX64.test(documentId) || !(await exists())) return;
    await (await open()).removeClaudeAgreed(documentId);
  },
  async keepOnly(documentIds) {
    if (isIncognito() || !(await exists())) return;
    await (await open()).keepClaudeAgreedOnly(documentIds.filter((id) => HEX64.test(id)));
  },
};
