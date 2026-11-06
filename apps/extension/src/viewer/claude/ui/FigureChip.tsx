// "Fig. 3 · p. 5" under a reply about a figure (plan §4 F). Claude can't cite an image, so a figure answer always carries
// this chip (contracts §6): pressing it goes to the figure and selects it, with its blue outline, as the Figures tab does.
import { ReplyChip } from './CitationChip';
import { claudeJump } from './jump';

/** "Fig. 3" from "Figure 3", "Fig. 2a" from "Fig 2a"; any other label ("Table 2", "Scheme 1") stays as it is. */
export function shortFigureLabel(label: string): string {
  const m = /^\s*fig(?:ure|\.)?\s*(\d.*|[ivxlc]+\b.*)$/iu.exec(label);
  return m ? `Fig. ${m[1]?.trim() ?? ''}` : label.trim();
}

/** The chip's words: "Fig. 3 · p. 5", or "Fig. 3" while its page is not known. */
export function figureChipLabel(label: string, pageIndex: number | null): string {
  return pageIndex === null ? shortFigureLabel(label) : `${shortFigureLabel(label)} · p. ${pageIndex + 1}`;
}

export interface FigureChipProps {
  /** The figure's label as the PDF prints it ("Figure 3"). */
  label: string;
  /** The page it is on (0-based), when known. */
  pageIndex: number | null;
}

export function FigureChip({ label, pageIndex }: FigureChipProps) {
  const words = figureChipLabel(label, pageIndex);
  return (
    <ReplyChip
      kind="figure"
      icon="image"
      label={words}
      name={pageIndex === null ? `Go to ${label}` : `Go to ${label} on page ${pageIndex + 1}`}
      onPress={() => void claudeJump.get()?.toFigure({ label, pageIndex })}
    />
  );
}
