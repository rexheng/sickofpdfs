// "Figure 3 · Page 5" under a reply about a figure (plan §4 F; R74, as the figure's card says it). Claude can't cite an
// image, so a figure answer always carries this chip (contracts §6): pressing it goes to the figure and selects it, with
// its blue outline, as the Figures tab does. In the library it opens the note's reading (ReplyChipPlace).
import { useContext } from 'react';
import { ReplyChip, ReplyChipPlace } from './CitationChip';
import { claudeJump } from './jump-target';

/** The chip's words, as the figure's card says them (R74): "Figure 1 · Page 29", or "Figure 1" while its page is not known. */
export function figureChipLabel(label: string, pageIndex: number | null): string {
  const name = label.trim();
  return pageIndex === null ? name : `${name} · Page ${pageIndex + 1}`;
}

export interface FigureChipProps {
  /** The figure's label as the PDF prints it ("Figure 3"). */
  label: string;
  /** The page it is on (0-based), when known. */
  pageIndex: number | null;
}

export function FigureChip({ label, pageIndex }: FigureChipProps) {
  const place = useContext(ReplyChipPlace);
  const words = figureChipLabel(label, pageIndex);
  return (
    <ReplyChip
      kind="figure"
      icon="image"
      label={words}
      name={pageIndex === null ? `Go to ${label}` : `Go to ${label} on page ${pageIndex + 1}`}
      onPress={() => (place.openReading !== undefined ? place.openReading() : void claudeJump.get()?.toFigure({ label, pageIndex }))}
    />
  );
}
