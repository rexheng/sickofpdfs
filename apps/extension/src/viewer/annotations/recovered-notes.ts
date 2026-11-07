// R77 with R67 tightened (4): notes this computer keeps that no open PDF will bring back. The library's Notes page (S14)
// lists them under "Recovered notes", each with its text, when it was typed, and Copy and Delete. Nothing here is ever
// deleted except by that Delete.
//
// Two kinds:
// - A journal entry that cannot be placed: no document id (Test build 2 could write those, the bug R67 fixed), or any
//   other entry the journal cannot read but that still holds text. No clear ever removes one (R77).
//   Words the journal set aside (`keepAside`: a crash draft older than its note, R101; a note held after "Never save this file")
//   are such entries too. One a tab still holds names that tab (`heldBy`): the Notes page shows it once the tab has gone.
// - A save-pending record (save-pending.ts) whose PDF has not been opened for RECOVER_AFTER_MS. Opening that PDF again
//   still finishes its save and puts the notes back in place; until then, after 7 days, they show here too. The date is
//   the record's `at`.
// Only extension pages can read these (localStorage is per origin). Incognito keeps none.
import type { KeyValueStorage } from './draft-journal';
import { canPlace, JOURNAL_PREFIX } from './draft-journal';
import { localPendingMirror, PENDING_PREFIX, type PendingMirror, type PendingSave } from './save-pending';

/** A save-pending record shows as recovered once its PDF has not been opened for this long. */
export const RECOVER_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecoveredNote {
  /** Pass it to `deleteRecoveredNote`. */
  key: string;
  /** What the owner wrote; for a highlight with no words of its own, the words it marks. */
  text: string;
  kind: 'note' | 'edit' | 'highlight';
  /** When it was typed or last kept (ms). */
  at: number;
  /** The tab that still holds this note in memory, if one may: it is a recovered note only once that tab has gone. */
  heldBy?: string;
}

const fields = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);

function readRaw(storage: KeyValueStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function readJson(storage: KeyValueStorage, key: string): Record<string, unknown> | null {
  try {
    return fields(JSON.parse(storage.getItem(key) ?? 'null'));
  } catch {
    return null;
  }
}

function keysWith(storage: KeyValueStorage, prefix: string): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(prefix)) out.push(k);
    }
  } catch {
    // storage that cannot be read has nothing to show
  }
  return out;
}

/** The notes of one save-pending record, each with the key that deletes it. */
function notesOf(storageKey: string, rec: PendingSave): RecoveredNote[] {
  const out: RecoveredNote[] = [];
  for (const d of rec.drafts) if (typeof d.body === 'string' && d.body.trim() !== '') out.push({ key: `${storageKey}#d:${d.id}`, text: d.body, kind: 'note', at: rec.at });
  for (const e of rec.edits) if (typeof e.body === 'string' && e.body.trim() !== '') out.push({ key: `${storageKey}#e:${e.commentId}`, text: e.body, kind: 'edit', at: rec.at });
  for (const op of rec.ops) {
    if (op.op === 'soft-delete') continue;
    const row = fields(op.row);
    if (!row || typeof row.id !== 'string') continue;
    if (op.table === 'comments' && typeof row.body === 'string' && row.body.trim() !== '') {
      out.push({ key: `${storageKey}#c:${row.id}`, text: row.body, kind: 'note', at: rec.at });
    } else if (op.table === 'marks') {
      const quote = fields(fields(row.anchor)?.quote)?.quote;
      out.push({ key: `${storageKey}#m:${row.id}`, text: typeof quote === 'string' ? quote : '', kind: 'highlight', at: rec.at });
    }
  }
  return out;
}

/** Every recovered note, newest first. */
export function listRecoveredNotes(now: number = Date.now(), storage: KeyValueStorage | null = localStorageOrNull()): RecoveredNote[] {
  if (!storage) return [];
  const out: RecoveredNote[] = [];
  for (const k of keysWith(storage, JOURNAL_PREFIX)) {
    if (canPlace(readRaw(storage, k))) continue; // the journal brings it back when its PDF is opened
    const e = readJson(storage, k);
    if (!e || typeof e.body !== 'string' || e.body.trim() === '') continue;
    const held = fields(e.held)?.tab;
    out.push({ key: k, text: e.body, kind: e.kind === 'edit' ? 'edit' : 'note', at: typeof e.at === 'number' ? e.at : 0, ...(typeof held === 'string' ? { heldBy: held } : {}) });
  }
  for (const k of keysWith(storage, PENDING_PREFIX)) {
    const rec = readJson(storage, k) as unknown as PendingSave | null;
    if (!rec || typeof rec.at !== 'number' || !Array.isArray(rec.ops) || !Array.isArray(rec.drafts) || !Array.isArray(rec.edits)) continue;
    if (now - rec.at < RECOVER_AFTER_MS) continue; // its PDF may still be opened again and take them back in place
    out.push(...notesOf(k, rec));
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Deletes one recovered note: the owner's own choice. A save-pending record with nothing left in it goes. Its IndexedDB copy
 * follows (save-pending.ts, draft-journal.ts), so a crash cannot bring the deleted note back.
 */
export function deleteRecoveredNote(
  key: string,
  storage: KeyValueStorage | null = localStorageOrNull(),
  mirror: PendingMirror | null = storage !== null && storage === localStorageOrNull() ? localPendingMirror() : null,
): void {
  if (!storage) return;
  const hash = key.indexOf('#');
  try {
    if (hash < 0) {
      if (key.startsWith(JOURNAL_PREFIX)) {
        storage.removeItem(key);
        mirror?.remove(key);
      }
      return;
    }
    const storageKey = key.slice(0, hash);
    const [what, id] = [key.slice(hash + 1, hash + 2), key.slice(hash + 3)];
    const rec = readJson(storage, storageKey) as unknown as PendingSave | null;
    if (!rec || !storageKey.startsWith(PENDING_PREFIX)) return;
    let ops = what === 'c' || what === 'm' ? rec.ops.filter((op) => fields(op.row)?.id !== id) : rec.ops;
    if (what === 'c') {
      // A sent note's thread goes with its last comment.
      const gone = rec.ops.find((op) => op.table === 'comments' && fields(op.row)?.id === id);
      const thread = fields(gone?.row)?.threadId;
      const kept = ops.some((op) => op.table === 'comments' && fields(op.row)?.threadId === thread);
      if (typeof thread === 'string' && !kept) ops = ops.filter((op) => !(op.table === 'threads' && fields(op.row)?.id === thread));
    }
    const next: PendingSave = {
      ...rec,
      drafts: what === 'd' ? rec.drafts.filter((d) => d.id !== id) : rec.drafts,
      edits: what === 'e' ? rec.edits.filter((e) => e.commentId !== id) : rec.edits,
      ops,
    };
    if (next.drafts.length === 0 && next.edits.length === 0 && next.ops.length === 0) {
      storage.removeItem(storageKey);
      mirror?.remove(storageKey);
    } else {
      const raw = JSON.stringify(next);
      storage.setItem(storageKey, raw);
      mirror?.put(storageKey, raw);
    }
  } catch {
    // storage refused: the note stays, and shows again
  }
}

function localStorageOrNull(): KeyValueStorage | null {
  try {
    if (typeof chrome !== 'undefined' && chrome.extension?.inIncognitoContext) return null;
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
