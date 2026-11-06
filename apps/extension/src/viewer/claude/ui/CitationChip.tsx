// "Page 4" in a reply from Claude (plan §4 F; R74: "Page N" everywhere): a small tonal pill at the end of the sentence it
// cites. Pressing it goes to the cited passage and lights the sentence there for a moment (jump.ts), and the thread stays
// open. Hovering it shows the cited words, so the owner can check a claim without leaving the thread. The stored body
// writes "[Page 4](cite:n)" (slice D, 6 Nov; older replies "[p. 4]"); the chip always says "Page".
//
// The pill itself (ReplyChip) is shared by the page, web source and figure chips: Drive's chip shape at the size of a
// line of comment text (20 px, 12/16 500), one colour per kind.
//
// In the library (the Notes page and Home) there is no PDF to jump in: a page or figure chip opens the note's reading
// instead (ReplyChipPlace). Chips never go anywhere else.
import type { PageCitation } from '@sop/core';
import { Icon, type IconName, Tooltip } from '@sop/ui';
import { createContext, useContext } from 'react';
import styles from './CitationChip.module.css';
import { claudeJump } from './jump-target';

/** Where the chips are drawn. Empty in the viewer, where they jump in the open PDF. */
export interface ReplyChipPlaceValue {
  /** The library: a page or figure chip opens the note's reading, at the note. */
  openReading?(this: void): void;
  /** The library: Open Settings goes to Settings → Claude in the same tab. */
  openSettings?(this: void): void;
}
export const ReplyChipPlace = createContext<ReplyChipPlaceValue>({});

export interface ReplyChipProps {
  kind: 'page' | 'web' | 'figure';
  label: string;
  /** What a screen reader hears: "Go to page 4", "Open source: example.org". */
  name: string;
  /** Shown on hover and keyboard focus: the cited words, or the page title and address. */
  tooltip?: string | null;
  icon?: IconName;
  /** A cited passage that is not in this copy of the PDF: shown, greyed, and pressing it does nothing. */
  missing?: boolean;
  /** Pressed; `el` is the chip, so a jump knows which card it came from. */
  onPress(this: void, el: HTMLButtonElement): void;
}

export function ReplyChip({ kind, label, name, tooltip, icon, missing = false, onPress }: ReplyChipProps) {
  const chip = (
    <button
      type="button"
      className={[styles.chip, styles[kind], icon !== undefined && styles.withIcon, missing && styles.missing].filter(Boolean).join(' ')}
      aria-label={name}
      aria-disabled={missing ? 'true' : undefined}
      data-chip={kind}
      onClick={(event) => {
        // The card would take the click as "activate"; a chip does its own thing.
        event.stopPropagation();
        if (!missing) onPress(event.currentTarget);
      }}
    >
      {icon !== undefined && <Icon name={icon} size={20} className={styles.icon} />}
      <span className={styles.label}>{label}</span>
    </button>
  );
  return tooltip ? (
    <Tooltip label={tooltip} side="bottom">
      {chip}
    </Tooltip>
  ) : (
    chip
  );
}

/** The cited words as the tooltip shows them: in quotes, cut to about two lines. */
export function quoteTip(quote: string): string | null {
  const q = quote.replace(/\s+/gu, ' ').trim();
  if (q === '') return null;
  return `“${q.length > 140 ? `${q.slice(0, 139).trimEnd()}…` : q}”`;
}

/** "Page 4" for the chip: from the citation's page, else from the body's link text ("p. 4" becomes "Page 4"). */
export function pageChipLabel(label: string, citation: PageCitation | null): string {
  if (citation !== null) return `Page ${citation.pageIndex + 1}`;
  const n = /^\s*p(?:age|\.)?\s*(\d+)\s*$/iu.exec(label)?.[1];
  return n === undefined ? label : `Page ${n}`;
}

export interface CitationChipProps {
  /** The link text from the body ("p. 4"). */
  label: string;
  /** `meta.citations[n]`; null when the reply names a citation it does not have (it is drawn, and does nothing). */
  citation: PageCitation | null;
  /** Other passages of the same page cited at the same place: one chip stands for them all. */
  also?: readonly PageCitation[];
  /** The sentence of the reply the chip ends: the jump lights the sentence of the passage that matches it best. */
  sentence?: string;
}

export function CitationChip({ label, citation, also = [], sentence = '' }: CitationChipProps) {
  const place = useContext(ReplyChipPlace);
  const page = citation === null ? null : citation.pageIndex + 1;
  return (
    <ReplyChip
      kind="page"
      label={pageChipLabel(label, citation)}
      name={page === null ? pageChipLabel(label, null) : `Go to page ${page}`}
      tooltip={citation === null ? null : quoteTip(citation.quote)}
      missing={citation === null}
      onPress={(el) => {
        if (citation === null) return;
        if (place.openReading !== undefined) place.openReading();
        else void claudeJump.get()?.toCitation(citation, { also, sentence, from: el });
      }}
    />
  );
}
