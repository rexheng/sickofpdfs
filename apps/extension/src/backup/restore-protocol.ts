// What the Settings page and its restore worker say to each other (restore-client.ts, restore-worker.ts).
//
//   page   → worker { type: 'restore:open', folder }           read the backup in this folder and say what is in it
//   worker → page   { type: 'restore:preview', preview }       the answer (RestorePreview), or a refusal in plain words
//   page   → worker { type: 'restore:apply' }                  the owner said Restore
//   worker → page   { type: 'restore:progress', progress }     merging, then "Copying PDFs 3 of 9"
//   worker → page   { type: 'restore:done', outcome }          what it did (RestoreOutcome)
//   worker → page   { type: 'restore:failed', message }        it stopped; the message is plain words, fit to show
//   worker → page   { type: 'restore:port-request' }           "give me a new port to the store"
//   page   → worker { type: 'restore:port' } + the port         the answer (the service worker brokered it, store/transport.ts)
import type { RestoreOutcome, RestorePreview, RestoreProgress } from './restore';

export type ToRestoreWorker = { type: 'restore:open'; folder: FileSystemDirectoryHandle } | { type: 'restore:apply' } | { type: 'restore:port' };

export type FromRestoreWorker =
  | { type: 'restore:preview'; preview: RestorePreview }
  | { type: 'restore:progress'; progress: RestoreProgress }
  | { type: 'restore:done'; outcome: RestoreOutcome }
  | { type: 'restore:failed'; message: string }
  | { type: 'restore:port-request' };

export const isMessage = <T extends { type: string }>(x: unknown, type: T['type']): x is T =>
  typeof x === 'object' && x !== null && (x as { type?: unknown }).type === type;
