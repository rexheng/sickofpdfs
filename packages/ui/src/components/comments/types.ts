import type { CommentRow } from '@sop/core';

/**
 * What a card needs from a comment. A full `CommentRow` fits, so the viewer passes its rows as they are; the gallery
 * and the notes panel can pass lighter objects.
 */
export type CommentView = Pick<CommentRow, 'id' | 'author' | 'body' | 'createdAt' | 'editedAt' | 'draftOfTab' | 'meta'>;

/**
 * A `cite:n` or `web:n` link in a reply body, turned into a chip. `label` is the link text ("p. 4", "source"), and
 * `n` points at `meta.citations[n]` or `meta.webSources[n]` (contracts section 3).
 */
export interface ChipLink {
  kind: 'cite' | 'web';
  n: number;
  label: string;
}

/**
 * Where the note sits, as the card shows it. The viewer maps the in-memory `Resolution` (contracts section 2) onto it:
 * `placed: false` is 'unplaced'; a close-match placement (`fuzzy`, `caption`, `image`) is 'moved' (D7); anything else
 * is 'placed'.
 */
export type CardPlacement = 'placed' | 'moved' | 'unplaced';

/** The figure a card is about: its 64 px thumbnail (an object or data URL rendered on this computer) and its label. */
export interface CardFigure {
  /** "Figure 3 · p. 4" */
  label: string;
  thumbnail: string | null;
}
