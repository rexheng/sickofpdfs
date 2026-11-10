// Unsent note text, kept in this browser's own storage (plan CL13: "Drafts stay in the browser's own storage and are sent only
// on send"). A draft is never synced and never reaches the cloud. Sending clears it; signing out clears them all.
const PREFIX = 'sop-web-draft:';

const key = (documentId: string, slot: string) => `${PREFIX}${documentId}:${slot}`;

export function readDraft(documentId: string, slot: string): string {
  try {
    return localStorage.getItem(key(documentId, slot)) ?? '';
  } catch {
    return '';
  }
}

export function writeDraft(documentId: string, slot: string, body: string): void {
  try {
    if (body.trim() === '') localStorage.removeItem(key(documentId, slot));
    else localStorage.setItem(key(documentId, slot), body);
  } catch {
    // no storage (a private window): the text stays in the box until the page closes
  }
}

export const clearDraft = (documentId: string, slot: string): void => writeDraft(documentId, slot, '');

export function forgetAllDrafts(): void {
  try {
    const gone: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) gone.push(k);
    }
    for (const k of gone) localStorage.removeItem(k);
  } catch {
    // nothing kept
  }
}
