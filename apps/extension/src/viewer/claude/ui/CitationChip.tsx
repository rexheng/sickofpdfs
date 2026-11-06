// "Page 4" in a reply from Claude (plan §4 F; R74: "Page N" everywhere): a small tonal pill on the text line that jumps
// to the cited passage and flashes it. Hovering it shows the cited words, so the owner can check a claim without leaving
// the thread. The stored body writes "[Page 4](cite:n)" (slice D, 6 Nov; older replies "[p. 4]"); the chip always says "Page".
//
// The pill itself (ReplyChip) is shared by the page, web source and figure chips: Drive's chip shape at the size of a
// line of comment text (20 px, 12/16 500), one colour per kind.
import type { PageCitation } from '@sop/core';
import { Icon, type IconName, Tooltip } from '@sop/ui';
import styles from './CitationChip.module.css';
import { claudeJump } from './jump';

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
  onPress(this: void): void;
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
        if (!missing) onPress();
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
}

export function CitationChip({ label, citation }: CitationChipProps) {
  const page = citation === null ? null : citation.pageIndex + 1;
  return (
    <ReplyChip
      kind="page"
      label={pageChipLabel(label, citation)}
      name={page === null ? pageChipLabel(label, null) : `Go to page ${page}`}
      tooltip={citation === null ? null : quoteTip(citation.quote)}
      missing={citation === null}
      onPress={() => {
        if (citation !== null) void claudeJump.get()?.toCitation(citation);
      }}
    />
  );
}
