// The light half of the chips' jumps: the one jumper of the open document, where the chips find it, and the web-source and
// figure-page helpers. It imports nothing of the viewer, so the library's Notes page and Home can draw replies with the
// chips (ClaudeReplyView's LibraryClaudeReply) without loading the viewer's figure and page code. The jumper itself is
// made in jump.ts.
import type { PageCitation, ThreadRow } from '@sop/core';

export interface ClaudeJumper {
  /**
   * Goes to the passage and lights the cited sentence. `also`: other passages of the same page the chip stands for;
   * `sentence`: the reply's sentence the chip ends; `from`: the chip, whose thread stays open in view. False when the page
   * does not exist here.
   */
  toCitation(c: PageCitation, o?: { also?: readonly PageCitation[]; sentence?: string; from?: HTMLElement }): Promise<boolean>;
  /** Goes to the figure and selects it. False when no such figure is found. */
  toFigure(f: { label: string | null; pageIndex: number | null }): Promise<boolean>;
  /** The page of a figure by its label ("Figure 3"), from the figures found so far; null when not known yet. */
  figurePage(label: string): number | null;
}

/** The one jumper of the open document. The feature sets it; the chips read it when pressed. */
let current: ClaudeJumper | null = null;
export const claudeJump = {
  set(j: ClaudeJumper | null): void {
    current = j;
  },
  get(): ClaudeJumper | null {
    return current;
  },
};

/**
 * Opens a web source in a new tab. Only https addresses open (plan §4 F: reply links are allow-listed); the tab gets no
 * opener and no referrer, so the page cannot reach back into the viewer or learn which PDF was open.
 */
export function openWebSource(url: string): boolean {
  if (!isHttps(url)) return false;
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

export function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Words are compared without case, spacing or a line-end hyphen. */
export const norm = (s: string): string => s.toLowerCase().replace(/-\s+/gu, '').replace(/\s+/gu, ' ').trim();

/** The page of a figure a reply is about: the thread's own figure when it carries that label, else one found by label. */
export function figurePageOf(label: string, thread: Pick<ThreadRow, 'anchor'> | null): number | null {
  const a = thread?.anchor;
  if (a?.kind === 'figure') {
    const own = a.figure.label;
    if (own === null || norm(own) === norm(label)) return a.page;
  }
  return claudeJump.get()?.figurePage(label) ?? null;
}
