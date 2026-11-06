// @Claude in the note box (spec "Start a comment with @Claude, picked from autocomplete"; plan §4 F and §8 A4).
//
// - Typing "@" at the start of a word in a note or reply box shows one suggestion under the caret, as Google Docs shows
//   people: Claude's avatar, "Claude" and what it will do ("Ask about this passage"). Enter, Tab or a click puts
//   "@Claude " in the box; Esc or typing on closes it. The rest of the box's keys are untouched.
// - Sending a note or reply that mentions @Claude asks Claude in that thread (ClaudeEntry.ask({ threadId })). Typing
//   "@Claude" by hand does the same as picking it. Only a note sent from this tab asks, once: a note sent earlier, an
//   edit, an undo or a reload never asks again.
// - "Ask Claude" in the menus opens the same note box with "@Claude " already in it (`prefillNoteBox`), so a question
//   from the menu is the same thread and the same request as one typed by hand (plan §6 walkthrough 2).
// - R105 and TB6: a box holding only "@Claude" says "Type your question after @Claude" under it, and Enter there keeps the box
//   open (nothing is sent, no empty note is made). A reply that starts with @Claude says "Claude reads the notes in this thread
//   too": the earlier notes go with the question. On a private PDF the suggestion is greyed out with "Claude doesn't read
//   private files", and so is the line under the box.
//
// The suggestion is drawn by one host for the whole tab (`ClaudeMentions`), so the note box itself needs no change: it
// listens for typing in any note box and leaves every key it does not use to the box.
import type { Anchor, CommentId, ThreadId } from '@sop/core';
import { CommentAvatar } from '@sop/ui';
import { type MouseEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AnnotationSession } from '../../annotations/session';
import { type ClaudePreset, type ClaudeUiHost, useClaudeUi } from './host';
import styles from './MentionItem.module.css';

/** What a mention item puts in the box. */
export const CLAUDE_MENTION = '@Claude';

/** A note or reply mentions Claude: "@Claude" as a word of its own, anywhere in it (the start is the usual place). */
export function mentionsClaude(body: string): boolean {
  return /(^|[\s(“"'])@claude(?![\p{L}\p{N}_])/iu.test(body);
}

/** One suggestion of the note box's @ list. */
export interface MentionOption {
  id: string;
  /** What goes into the box, with a space after it. */
  insert: string;
  label: string;
  /** One quiet line under the name. */
  detail: string;
  /** R105: greyed out (a private PDF); `detail` says why. Choosing it does nothing. */
  disabled?: boolean;
}

/** What a note is about, for the suggestion's words. */
export type MentionPlace = 'passage' | 'figure' | 'area' | 'page' | 'document';

export function placeOf(anchor: Anchor | null | undefined): MentionPlace {
  switch (anchor?.kind) {
    case 'figure':
      return 'figure';
    case 'area':
      return 'area';
    case 'point':
    case 'page':
      return 'page';
    case 'document':
      return 'document';
    default:
      return 'passage';
  }
}

const ABOUT: Record<MentionPlace, string> = {
  passage: 'Ask about this passage',
  figure: 'Ask about this figure',
  area: 'Ask about this part of the page',
  page: 'Ask about this page',
  document: 'Ask about this PDF',
};

/**
 * The mention source of the note box (A4): Claude, while this tab has a Claude host. With no key yet it still shows, and
 * says so; the reply then explains how to add one (plan §6 walkthrough 7).
 */
export function claudeMentionItems(o: { place?: MentionPlace; host?: Pick<ClaudeUiHost, 'status' | 'privateHint'> | null } = {}): MentionOption[] {
  const status = o.host?.status() ?? null;
  if (status === null || status === 'incognito') return [];
  const hint = o.host?.privateHint?.() ?? null;
  return [
    {
      id: 'claude',
      insert: `${CLAUDE_MENTION} `,
      label: 'Claude',
      detail: hint ?? (status === 'no-key' ? 'Add your key in Settings first' : ABOUT[o.place ?? 'passage']),
      ...(hint !== null ? { disabled: true } : {}),
    },
  ];
}

/** A box that holds only the mention, with no question yet ("@Claude", "@Claude ,"). */
const ONLY_MENTION = /^\s*@claude[\s,:]*$/iu;
/** A note that starts with the mention. */
const STARTS_WITH_MENTION = /^\s*@claude(?![\p{L}\p{N}_])/iu;

/** The quiet line under a note or reply box that asks Claude (R105, TB6). */
export const ASK_HINT = 'Type your question after @Claude';
export const THREAD_HINT = 'Claude reads the notes in this thread too';

/**
 * What the line under a box says, or null: the private hint (R105) on a private PDF; "Type your question after @Claude" while the
 * box holds only the mention; "Claude reads the notes in this thread too" in a reply box that starts with @Claude.
 */
export function boxHint(value: string, variant: 'note' | 'reply', privateHint: string | null): string | null {
  if (!STARTS_WITH_MENTION.test(value)) return null;
  if (privateHint !== null) return privateHint;
  if (ONLY_MENTION.test(value)) return ASK_HINT;
  return variant === 'reply' ? THREAD_HINT : null;
}

export interface MentionItemProps {
  option: MentionOption;
  id: string;
  selected: boolean;
  onChoose(this: void): void;
}

/** One row of the @ list: Claude's 32 px avatar, its name and one quiet line, as Docs lists people. */
export function MentionItem({ option, id, selected, onChoose }: MentionItemProps) {
  const off = option.disabled === true;
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={off ? 'true' : undefined}
      className={styles.item}
      data-selected={selected && !off ? 'true' : 'false'}
      // The caret stays in the note box while the row is pressed.
      onMouseDown={(event: MouseEvent) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        if (!off) onChoose();
      }}
    >
      <CommentAvatar author="claude" />
      <span className={styles.text}>
        <span className={styles.name}>{option.label}</span>
        <span className={styles.detail}>{option.detail}</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The @ list under the caret
// ---------------------------------------------------------------------------------------------------------------------

/** The note and reply boxes (NoteBox marks its box with `data-variant`). An edit of a sent note never asks Claude. */
const BOX = '[data-variant="note"], [data-variant="reply"]';

function noteBoxOf(target: EventTarget | null): HTMLTextAreaElement | null {
  return target instanceof HTMLTextAreaElement && target.closest(BOX) !== null ? target : null;
}

/** The "@cl" being typed just before the caret, when it could become "@Claude". */
export function mentionQuery(value: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(“"'])@([\p{L}]{0,6})$/u.exec(value.slice(0, caret));
  if (m === null) return null;
  const query = m[2] ?? '';
  if (!'claude'.startsWith(query.toLowerCase())) return null;
  return { start: caret - query.length - 1, query };
}

/** Where the caret is on screen (client px): the line it is on, measured with a copy of the box's text. */
function caretPoint(el: HTMLTextAreaElement, at: number): { x: number; y: number; line: number } {
  const cs = getComputedStyle(el);
  const copy = document.createElement('div');
  for (const p of [
    'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight',
    'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariationSettings', 'lineHeight',
    'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'tabSize',
  ] as const) {
    copy.style[p] = cs[p];
  }
  copy.style.position = 'fixed';
  copy.style.visibility = 'hidden';
  copy.style.whiteSpace = 'pre-wrap';
  copy.style.overflowWrap = 'break-word';
  copy.style.top = '0';
  copy.style.left = '0';
  copy.textContent = el.value.slice(0, at);
  const mark = document.createElement('span');
  mark.textContent = '​';
  copy.append(mark);
  document.body.append(copy);
  const box = el.getBoundingClientRect();
  const line = Number.parseFloat(cs.lineHeight) || mark.offsetHeight;
  const point = { x: box.left + mark.offsetLeft - el.scrollLeft, y: box.top + mark.offsetTop - el.scrollTop, line };
  copy.remove();
  return point;
}

/** The line under a box (`boxHint`), while the box has the caret. */
interface Hint {
  box: HTMLTextAreaElement;
  text: string;
  at: { x: number; width: number; bottom: number };
  light: boolean;
  /** Enter was pressed on a box with no question: the line is said to a screen reader too. */
  nudged: boolean;
}

interface Open {
  box: HTMLTextAreaElement;
  start: number;
  caret: number;
  options: MentionOption[];
  /** Where the list goes: the box's left edge and width, and the top and bottom of the caret's line (client px). */
  at: { x: number; width: number; top: number; bottom: number };
  light: boolean;
}

/** The list's distance below the caret's line, and how close it may come to the window's edge (CSS px). */
const GAP = 4;
const EDGE = 8;

/** Puts text in the box the way typing would (the box's own undo history keeps it), replacing [from, to). */
function typeInto(box: HTMLTextAreaElement, from: number, to: number, text: string): void {
  box.focus({ preventScroll: true });
  box.setSelectionRange(from, to);
  if (!document.execCommand('insertText', false, text)) {
    // execCommand is refused: change the text in place and tell React, as typing would.
    box.setRangeText(text, from, to, 'end');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/**
 * The @ list of the tab: mounted once by the Claude feature. `placeOfBox` says what the note in a box is about (its
 * thread's anchor), for the suggestion's words.
 */
export function ClaudeMentions({ placeOfBox }: { placeOfBox(this: void, box: HTMLTextAreaElement): MentionPlace }) {
  const host = useClaudeUi();
  const [open, setOpen] = useState<Open | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  const listId = useId();
  const optionId = `${listId}-claude`;
  const current = useRef<Open | null>(null);
  current.current = open;

  const close = useCallback(() => setOpen(null), []);

  /** The line under the box, from what it holds now (or none). */
  const hintFor = useCallback(
    (box: HTMLTextAreaElement, nudged = false) => {
      const variant = box.closest('[data-variant="reply"]') !== null ? 'reply' : 'note';
      const text = document.activeElement === box ? boxHint(box.value, variant, host?.privateHint?.() ?? null) : null;
      if (text === null) return setHint(null);
      const field = (box.closest(BOX) ?? box).getBoundingClientRect();
      const light = (box.closest('[data-theme]')?.getAttribute('data-theme') ?? 'light') === 'light';
      setHint({ box, text, at: { x: field.left + EDGE, width: field.width, bottom: field.bottom }, light, nudged });
    },
    [host],
  );

  const look = useCallback(
    (box: HTMLTextAreaElement) => {
      const caret = box.selectionStart;
      if (box.selectionEnd !== caret) return close();
      const q = mentionQuery(box.value, caret);
      const options = q === null ? [] : claudeMentionItems({ place: placeOfBox(box), host });
      if (q === null || options.length === 0) return close();
      // Under the box, lined up with its left edge, as Docs shows people to mention; the box stays in view above it.
      const field = (box.closest(BOX) ?? box).getBoundingClientRect();
      const p = caretPoint(box, q.start);
      const light = (box.closest('[data-theme]')?.getAttribute('data-theme') ?? 'light') === 'light';
      setOpen({ box, start: q.start, caret, options, at: { x: field.left + EDGE, width: field.width, top: p.y, bottom: Math.max(p.y + p.line, box.getBoundingClientRect().bottom) }, light });
    },
    [close, host, placeOfBox],
  );

  const choose = useCallback((o: Open) => {
    const option = o.options[0];
    if (option === undefined || option.disabled === true) return setOpen(null);
    typeInto(o.box, o.start, o.caret, option.insert);
    setOpen(null);
  }, []);

  useEffect(() => {
    if (host === null) return;
    const onInput = (e: Event) => {
      const box = noteBoxOf(e.target);
      if (box === null) return;
      look(box);
      hintFor(box);
    };
    // Capture: the list's keys are taken before the box sees them (Enter would send, Esc would close the box).
    const onKey = (e: KeyboardEvent) => {
      const o = current.current;
      // A box holding only "@Claude": Enter keeps it open and says what to do (no empty note, no question with no words).
      if (o === null && e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) {
        const box = noteBoxOf(e.target);
        if (box !== null && ONLY_MENTION.test(box.value)) {
          e.preventDefault();
          e.stopPropagation();
          hintFor(box, true);
        }
        return;
      }
      if (o === null || e.target !== o.box || e.isComposing) return;
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return close();
        e.preventDefault();
        e.stopPropagation();
        choose(o);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); // one suggestion: it stays chosen
        e.stopPropagation();
      }
    };
    const onCaret = () => {
      const o = current.current;
      if (o === null) return;
      if (document.activeElement !== o.box) return close();
      if (o.box.selectionStart !== o.caret) look(o.box);
    };
    const onLeave = (e: FocusEvent) => {
      if (current.current !== null && e.target === current.current.box) close();
      if (noteBoxOf(e.target) !== null) setHint(null);
    };
    // A box that opens with "@Claude " in it ("Ask Claude" in a menu) says what to type as it takes the caret.
    const onEnter = (e: FocusEvent) => {
      const box = noteBoxOf(e.target);
      if (box !== null) requestAnimationFrame(() => hintFor(box));
    };
    // Bubble, not capture: React's own input handler (the box's onChange, which keeps the text in the draft) must run first. A
    // state change here before it makes React draw the box again with its old value, and the letter just typed is lost (TB6
    // gate: the first AltGr "@" in a new reply box).
    document.addEventListener('input', onInput);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('selectionchange', onCaret);
    document.addEventListener('focusout', onLeave, true);
    document.addEventListener('focusin', onEnter, true);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('input', onInput);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('selectionchange', onCaret);
      document.removeEventListener('focusout', onLeave, true);
      document.removeEventListener('focusin', onEnter, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [host, look, choose, close, hintFor]);

  // The line follows the box when the page moves under it (a scroll, the window's size), and goes with the box.
  useEffect(() => {
    if (hint === null) return;
    const follow = () => (hint.box.isConnected ? hintFor(hint.box, hint.nudged) : setHint(null));
    window.addEventListener('resize', follow);
    document.addEventListener('scroll', follow, true);
    return () => {
      window.removeEventListener('resize', follow);
      document.removeEventListener('scroll', follow, true);
    };
  }, [hint, hintFor]);

  // The box tells assistive technology about the list while it is open.
  useEffect(() => {
    if (open === null) return;
    const { box } = open;
    box.setAttribute('aria-controls', listId);
    box.setAttribute('aria-activedescendant', optionId);
    return () => {
      box.removeAttribute('aria-controls');
      box.removeAttribute('aria-activedescendant');
    };
  }, [open, listId, optionId]);

  // Kept inside the window: under the line, or above it when there is no room below.
  const list = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = list.current;
    if (open === null || el === null) {
      setPlace(null);
      return;
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(EDGE, Math.min(open.at.x - EDGE, window.innerWidth - w - EDGE));
    const below = open.at.bottom + GAP;
    const top = below + h + EDGE <= window.innerHeight ? below : Math.max(EDGE, open.at.top - GAP - h);
    setPlace({ left, top });
  }, [open]);

  if (open === null) {
    if (hint === null) return null;
    return createPortal(
      <div
        className={styles.boxHint}
        data-theme={hint.light ? 'light' : 'dark'}
        data-claude-hint=""
        data-nudged={hint.nudged ? 'true' : 'false'}
        role={hint.nudged ? 'status' : undefined}
        style={{ left: hint.at.x, top: hint.at.bottom + GAP, maxInlineSize: Math.max(hint.at.width - 2 * EDGE, 160) }}
      >
        {hint.text}
      </div>,
      document.body,
    );
  }
  return createPortal(
    <div
      ref={list}
      id={listId}
      role="listbox"
      aria-label="Suggestions"
      className={styles.list}
      data-theme={open.light ? 'light' : 'dark'}
      data-claude-mentions=""
      style={{ left: place?.left ?? open.at.x, top: place?.top ?? open.at.bottom, inlineSize: open.at.width, visibility: place === null ? 'hidden' : 'visible' }}
    >
      {open.options.map((option) => (
        <MentionItem key={option.id} id={optionId} option={option} selected onChoose={() => choose(open)} />
      ))}
      <span className={styles.hint} aria-hidden="true">
        Enter to add
      </span>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Sending a note that mentions @Claude
// ---------------------------------------------------------------------------------------------------------------------

/** Fixed questions waiting for their note to be sent ("Explain this figure", "the whole document"), by thread. */
const presets = new Map<ThreadId, ClaudePreset>();

/** The next @Claude note sent in this thread asks with this preset. */
export function presetFor(threadId: ThreadId, preset: ClaudePreset): void {
  presets.set(threadId, preset);
}

/**
 * Asks Claude when a note or reply typed in this tab is sent with @Claude in it. Every draft this tab holds is noted;
 * when the same comment comes back as a sent row from the owner, it asks once, in its thread.
 */
export function watchClaudeMentions(session: AnnotationSession, host: () => ClaudeUiHost | null): () => void {
  const drafts = new Set<CommentId>();
  const note = () => {
    const st = session.state();
    for (const d of st.drafts) drafts.add(d.id);
    for (const c of st.comments) {
      if (!drafts.has(c.id)) continue;
      drafts.delete(c.id);
      const h = host();
      if (c.author !== 'me' || c.draftOfTab !== null || h === null || !mentionsClaude(c.body)) continue;
      const preset = presets.get(c.threadId);
      presets.delete(c.threadId);
      void h.ask({ threadId: c.threadId }, preset === undefined ? undefined : { preset }).catch(() => {});
    }
  };
  note();
  return session.subscribe(note);
}

/** The note box that has the caret, when it is one (not an edit box). */
export function focusedNoteBox(): HTMLTextAreaElement | null {
  return noteBoxOf(document.activeElement);
}

/**
 * Waits for a note or reply box to take the caret (the comment flow opens it a moment after the command), then puts
 * `text` at its start, unless it mentions Claude already. With `send`, the note is then sent as Enter would send it.
 * `onBox` is told the box once it has the caret (its thread is then the active one). Resolves with the box, or null
 * when none opened within `timeoutMs`.
 */
export function prefillNoteBox(
  text: string,
  o: { send?: boolean; timeoutMs?: number; onBox?: (box: HTMLTextAreaElement) => void; beforeSend?: () => void } = {},
): Promise<HTMLTextAreaElement | null> {
  const until = performance.now() + (o.timeoutMs ?? 2000);
  return new Promise((resolve) => {
    const tryNow = () => {
      const box = focusedNoteBox();
      if (box === null) {
        if (performance.now() > until) resolve(null);
        else requestAnimationFrame(tryNow);
        return;
      }
      o.onBox?.(box);
      if (!mentionsClaude(box.value)) {
        // "@Claude " before the words already there, and the caret after everything, ready for the question.
        const words = text.trimEnd();
        typeInto(box, 0, 0, box.value === '' && o.send === true ? words : `${words} `);
        box.setSelectionRange(box.value.length, box.value.length);
      }
      if (o.send === true) {
        o.beforeSend?.();
        // The box's own Enter: it sends through the same steps as the owner's key (saving the PDF first, as a note does).
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      }
      resolve(box);
    };
    requestAnimationFrame(tryNow);
  });
}
