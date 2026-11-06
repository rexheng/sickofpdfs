// R105 (TB6): a note that asks Claude gets no save question for Claude's sake. Claude never reads a PDF judged not learning, so
// saving it would not help the question, and the owner should not have to answer a question about a receipt to ask one.
//
// The Claude side (viewer/claude/entry.ts) says here when a sent "@Claude" note is waiting for this PDF's save: the save question
// (SaveAskDialog.tsx) then answers No by itself, unseen, and the thread says why Claude does not answer. Nothing is saved, as after
// No. The question for a note still being typed is handled in SaveAskDialog from the note box's own words.

let waiting = 0;
const listeners = new Set<() => void>();

const tell = (): void => {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      /* one listener must not stop the others */
    }
  }
};

export const claudeNoteWaiting = {
  /** A sent @Claude note waits for the save from now on. Call the function it returns when it no longer does. */
  begin(): () => void {
    waiting += 1;
    tell();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      waiting -= 1;
      tell();
    };
  },
  /** Whether an @Claude note waits for the save now. */
  active: (): boolean => waiting > 0,
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  },
};
