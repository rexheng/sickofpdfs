// Claude in the thread as a viewer feature (plan §4 F): App.tsx mounts it with one line, registerViewerFeature(claudeUiFeature).
//
// For the open document it sets up:
// - the chips' jumps (jump.ts): "Page 4" to the passage, "Figure 3 · Page 5" to the figure;
// - the @Claude suggestion in every note and reply box, and the watch that asks Claude when such a note is sent;
// - the confirm dialog the runner waits on (ClaudeConfirmDialog.tsx);
// - the commands "Ask Claude", "Explain this figure" and "Ask Claude about the whole document", and the menu rows that
//   run them (the mark-up menu, the figure menu, the Tools menu), and the figure toolbar on a selected figure.
//
// Everything here waits for the turn runner (slice D) to set the host (host.ts). Until then no Claude item shows, no
// command is built, and a note with "@Claude" in it is only a note.
//
// R105: on a private PDF (not learning, D9 or R102) every Claude item is greyed out with "Claude doesn't read private files",
// the figure toolbar's Ask Claude and Explain included.
import type { CommentId, ThreadRow } from '@sop/core';
import type { CommentView, MenuItemDef } from '@sop/ui';
import { type ReactNode, useCallback, useEffect } from 'react';
import type { NotesHost, ViewerFeature } from '../../annotations/wire';
import type { CommandBehaviour, ViewerCommandId } from '../../commands';
import type { FigureController, Region } from '../../figures/controller';
import { controllerOf } from '../../figures/registry';
import { noteCommands } from '../../notes/notes-host';
import { ClaudeConfirmHost } from './ClaudeConfirmDialog';
import { claudeReplyDismiss, ClaudeReplyView } from './ClaudeReplyView';
import { FigureToolbar } from './FigureToolbar';
import { claudeUi, useClaudeUi, useClaudePrivateHint } from './host';
import { claudeJump, createClaudeJumper } from './jump';
import { CLAUDE_MENTION, ClaudeMentions, type MentionPlace, placeOf, prefillNoteBox, presetFor, watchClaudeMentions } from './MentionItem';

/** The words "Explain this figure" puts in the note before it is sent; the turn asks the fixed question (A3 preset). */
const EXPLAIN_NOTE = `${CLAUDE_MENTION} Explain this figure.`;

/** The thread a note box belongs to: its card's id ends with it (the margin's `note-card-…`, the panel's `sop-panel-note-…`). */
function threadOfBox(box: HTMLElement, host: NotesHost): ThreadRow | null {
  const card = box.closest('[id^="note-card-"], [id^="sop-panel-note-"]');
  const id = card?.id.replace(/^(note-card-|sop-panel-note-)/u, '') ?? null;
  return id === null ? null : (host.session.state().threads.find((t) => t.id === id) ?? null);
}

function ClaudeUiView({ host }: { host: NotesHost }) {
  const ui = useClaudeUi();
  const privateHint = useClaudePrivateHint(ui);

  // The chips of this document jump within it.
  useEffect(() => {
    const jumper = createClaudeJumper(host);
    claudeJump.set(jumper);
    // R105: OK on a private PDF's refusal takes the row away, as ⋮ → Delete reply does.
    const dismiss = (id: CommentId) => void host.session.removeComment(id);
    claudeReplyDismiss.set(dismiss);
    return () => {
      if (claudeJump.get() === jumper) claudeJump.set(null);
      if (claudeReplyDismiss.get() === dismiss) claudeReplyDismiss.set(null);
    };
  }, [host]);

  // A note or reply sent with @Claude in it asks Claude, in its thread.
  useEffect(() => (ui === null ? undefined : watchClaudeMentions(host.session, claudeUi.get)), [host, ui]);
  // The reply view tells this tab's replies from another tab's by the row's `draftOfTab`.
  useEffect(() => {
    claudeUi.setTab(host.session.tabId);
    return () => claudeUi.setTab(null);
  }, [host]);

  const placeOfBox = useCallback((box: HTMLTextAreaElement): MentionPlace => placeOf(threadOfBox(box, host)?.anchor), [host]);
  if (ui === null) return null;
  const figures = controllerOf(host);
  const selected = (): Region | null => {
    const f = figures.state().selected;
    return f === null ? null : { kind: 'figure', found: f };
  };
  return (
    <>
      <ClaudeMentions placeOfBox={placeOfBox} />
      <ClaudeConfirmHost />
      <FigureToolbar
        controller={figures}
        disabledReason={privateHint}
        onAsk={() => {
          const r = selected();
          if (r !== null && privateHint === null) askOnRegion(figures, r);
        }}
        onExplain={() => {
          const r = selected();
          if (r !== null && privateHint === null) explainRegion(host, figures, r);
        }}
      />
    </>
  );
}

/** Whether notes can be written here (not a view-only PDF). */
const editable = (host: NotesHost) => host.session.state().mode !== 'view-only';
/** R105: the hint while this PDF is private; null when Claude may be asked. */
const privateHint = (): string | null => claudeUi.get()?.privateHint?.() ?? null;
/** The greyed-out item's reason: the private hint, when that is why. */
const whyOff = (): string | undefined => privateHint() ?? undefined;

/** Ask Claude about the selected figure or area: its note opens (or the note it has), with "@Claude " in the box. */
function askOnRegion(c: FigureController, region: Region): void {
  c.comment(region);
  void prefillNoteBox(CLAUDE_MENTION);
}

/** Explain this figure: its note is sent at once with the fixed question, and Claude answers in it. */
function explainRegion(host: NotesHost, c: FigureController, region: Region): void {
  c.comment(region);
  void prefillNoteBox(EXPLAIN_NOTE, {
    send: true,
    beforeSend: () => {
      const t = host.session.state().active;
      if (t !== null) presetFor(t, 'explain-figure');
    },
  });
}

function commands(host: NotesHost): Partial<Record<ViewerCommandId, CommandBehaviour>> {
  if (claudeUi.get() === null) return {};
  const figures = () => controllerOf(host);
  return {
    // The selected words (as Comment), or the selected figure: a note with "@Claude " ready for the question.
    'claude.ask': {
      run: () => {
        const region = figures().region();
        if (region !== null) return askOnRegion(figures(), region);
        noteCommands()?.['marks.comment'].run();
        void prefillNoteBox(CLAUDE_MENTION);
      },
      enabled: () => privateHint() === null && editable(host) && (host.selection().length > 0 || figures().region() !== null),
      disabledReason: whyOff,
    },
    'claude.explainFigure': {
      run: () => {
        const region = figures().region();
        if (region !== null) explainRegion(host, figures(), region);
      },
      enabled: () => privateHint() === null && editable(host) && figures().region() !== null,
      disabledReason: whyOff,
    },
    // A note on the whole document, with "@Claude " in it; the cost is shown before anything is sent.
    'claude.wholeDocument': {
      run: () => {
        noteCommands()?.['marks.documentNote'].run();
        void prefillNoteBox(CLAUDE_MENTION, {
          onBox: () => {
            const t = host.session.state().active;
            if (t !== null) presetFor(t, 'whole-document');
          },
        });
      },
      enabled: () => privateHint() === null && editable(host),
      disabledReason: whyOff,
    },
  };
}

/** The figure menu's Claude rows (FigureMenu.tsx): Ask Claude and Explain this figure, after Comment. */
export function claudeFigureItems(c: FigureController, region: Extract<Region, { kind: 'figure' }>): MenuItemDef[] {
  if (claudeUi.get() === null) return [];
  const hint = privateHint();
  const off = !c.editable() || hint !== null;
  const why = hint !== null ? { disabledReason: hint } : {};
  return [
    { kind: 'item', id: 'claude.ask', label: 'Ask Claude', icon: 'auto_awesome', disabled: off, ...why, onSelect: () => askOnRegion(c, region) },
    { kind: 'item', id: 'claude.explainFigure', label: 'Explain this figure', icon: 'insert_chart', disabled: off, ...why, onSelect: () => explainRegion(c.host, c, region) },
  ];
}

/** The note and reply boxes say @Claude can be asked, as Docs' box says "Reply or add others with @". */
export function claudePlaceholders(): { notePlaceholder?: string; replyPlaceholder?: string } {
  const host = claudeUi.get();
  if (host === null || host.status() === 'incognito') return {};
  return { notePlaceholder: 'Add a note, or ask @Claude', replyPlaceholder: 'Reply, or ask @Claude' };
}

/** Draws each reply from Claude in a card (ThreadCard's `renderClaudeReply`, plan §8 A4). */
export function claudeReplyRenderer(thread: Pick<ThreadRow, 'id' | 'anchor'>, comments: readonly CommentView[]): (comment: CommentView) => ReactNode {
  return (comment) => <ClaudeReplyView thread={thread} comment={comment} comments={comments} />;
}

export const claudeUiFeature: ViewerFeature = {
  id: 'claude-ui',
  commands,
  View: ClaudeUiView,
};
