// File → "Download with notes" and the toolbar's download menu (slice 8.3), as a viewer feature: App.tsx mounts it with
// one line. In Incognito there are no notes, so the command is not built and only "Download original file" shows.
//
// Pressing it downloads at once, with a snackbar. It asks first only when it must (ExportDialog): the owner's name, the
// first time; and before a signed PDF gets notes.
import { useSyncExternalStore } from 'react';
import { downloadOriginal } from '../actions/download';
import type { NotesHost, ViewerFeature } from '../annotations/wire';
import type { CommandBehaviour } from '../commands';
import { libraryStore } from '../use-store';
import { readAuthorName, writeAuthorName } from './author-name';
import { type ExportAnswer, type ExportAsk, ExportDialog } from './ExportDialog';
import { exportWithNotes, type ExportResult, hasNotes } from './export-pdf';

/** The question on screen, if any. One at a time, for this tab. */
let asking: { ask: ExportAsk; answer: (a: ExportAnswer) => void } | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of [...listeners]) l();
};

function askOwner(ask: ExportAsk): Promise<ExportAnswer> {
  return new Promise((resolve) => {
    asking = {
      ask,
      answer: (a) => {
        asking = null;
        changed();
        resolve(a);
      },
    };
    changed();
  });
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace('#', String(n)));

/** The snackbar once the copy is downloading: its name, and any note that is not where it was. */
export function doneText(r: Pick<ExportResult, 'fileName' | 'notPlaced' | 'skippedMarks'>): string {
  const parts = [`Downloaded “${r.fileName}”.`];
  if (r.notPlaced > 0) parts.push(`${plural(r.notPlaced, '1 comment', '# comments')} couldn’t be matched to ${plural(r.notPlaced, 'its', 'their')} words, so ${plural(r.notPlaced, 'it’s', 'they’re')} at the top of the page.`);
  if (r.skippedMarks > 0) parts.push(`${plural(r.skippedMarks, '1 mark', '# marks')} couldn’t be matched to ${plural(r.skippedMarks, 'its', 'their')} words and ${plural(r.skippedMarks, 'was', 'were')} left out.`);
  return parts.join(' ');
}

let running = false;

/** Makes the copy and downloads it. Never throws: a failure is told in the snackbar, and the notes are never touched. */
export async function downloadWithNotes(host: NotesHost): Promise<void> {
  if (running) return;
  if (!hasNotes(host)) {
    host.showNote('This PDF has no notes yet. Add a highlight or a comment first.');
    return;
  }
  running = true;
  try {
    const store = await libraryStore();
    let name = await readAuthorName(store);
    if (name === null) {
      const a = await askOwner({ kind: 'name' });
      if (a === null || a === true) return;
      name = a.name;
      await writeAuthorName(store, name);
    }
    const signatures = await host.backend.getSignatureCount(host.doc).catch(() => 0);
    if (signatures > 0 && (await askOwner({ kind: 'signed', signatures })) !== true) return;
    host.showNote('Adding your notes to a copy…');
    // the tags of a reading in the library (spec: they go in the copy's Keywords); an unsaved PDF has none
    const saved = host.save?.state.kind === 'saved' ? host.save.state.documentId : null;
    const tags = saved !== null && store !== null ? await store.tagsOf(saved).then((t) => t.map((x) => x.name), () => []) : [];
    const result = await exportWithNotes(host, { authorName: name, tags });
    downloadOriginal(result.blob, result.fileName);
    host.showNote(doneText(result));
  } catch (e) {
    console.warn('sickofpdfs: download with notes', e instanceof Error ? e.message : String(e));
    host.showNote('Couldn’t make the copy with your notes. Your notes are safe. Try again.');
  } finally {
    running = false;
  }
}

function ExportView() {
  const now = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => asking,
  );
  return now === null ? null : <ExportDialog ask={now.ask} onAnswer={now.answer} />;
}

export const exportPdfFeature: ViewerFeature = {
  id: 'export-pdf',
  commands: (host): Partial<Record<'file.downloadWithNotes', CommandBehaviour>> => ({
    // Always on: the menus and the toolbar are not drawn again when a note is added, so a row greyed out for "no notes
    // yet" would stay grey. With no notes, pressing it says so.
    'file.downloadWithNotes': { run: () => void downloadWithNotes(host), enabled: () => true },
  }),
  View: ExportView,
};
