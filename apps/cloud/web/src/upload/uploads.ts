// The uploads of this tab: a queue of picked or dropped PDFs, one at a time, and what the panel shows for each.
// While one is running, closing the tab asks first.
import { webLibrary } from '../sync/engine';
import { type UploadStep, uploadPdf } from './upload';

export interface UploadItem {
  id: number;
  name: string;
  size: number;
  step: UploadStep | { kind: 'queued' };
}

export interface Question {
  id: number;
  name: string;
  reason: string | null;
  answer(this: void, add: boolean): void;
}

let items: UploadItem[] = [];
let question: Question | null = null;
let nextId = 1;
const files = new Map<number, File>();
const listeners = new Set<() => void>();
let running = false;
const abort = new AbortController();

function emit(): void {
  for (const l of [...listeners]) l();
}

function update(id: number, step: UploadItem['step']): void {
  items = items.map((i) => (i.id === id ? { ...i, step } : i));
  emit();
}

export const uploads = {
  items: (): UploadItem[] => items,
  question: (): Question | null => question,
  subscribe: (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  /** Adds PDFs to the queue and starts it. */
  add(list: Iterable<File>): void {
    for (const file of list) {
      const id = nextId++;
      files.set(id, file);
      items = [...items, { id, name: file.name || 'PDF', size: file.size, step: { kind: 'queued' } }];
    }
    emit();
    void run();
  },
  /** Closes the panel: finished rows go. Rows still running stay. */
  clearFinished(): void {
    items = items.filter((i) => !finished(i));
    emit();
  },
  busy: (): boolean => items.some((i) => !finished(i)),
};

export const finished = (i: UploadItem): boolean => ['done', 'refused', 'failed'].includes(i.step.kind);

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = items.find((i) => i.step.kind === 'queued');
      if (next === undefined) return;
      const file = files.get(next.id);
      files.delete(next.id);
      if (file === undefined) continue;
      let lib: ReturnType<typeof webLibrary>;
      try {
        lib = webLibrary();
      } catch {
        update(next.id, { kind: 'failed', why: 'Your library isn’t open yet. Try again in a moment.' });
        continue;
      }
      await uploadPdf(file, {
        step: (s) => update(next.id, s),
        ask: (reason) =>
          new Promise<boolean>((resolve) => {
            question = {
              id: next.id,
              name: next.name,
              reason,
              answer: (add) => {
                question = null;
                emit();
                resolve(add);
              },
            };
            emit();
          }),
        store: lib.store,
        sync: lib.sync,
        signal: abort.signal,
      }).catch(() => update(next.id, { kind: 'failed', why: 'Something went wrong. Try again.' }));
    }
  } finally {
    running = false;
  }
}

addEventListener('beforeunload', (e) => {
  if (uploads.busy()) e.preventDefault();
});
