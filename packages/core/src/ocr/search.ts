// Find on a recognised page (the OCR side of PageTextProvider.search). Matches as FPDFText_Find does for a text page: case
// is ignored unless `matchCase`, a line break counts as one space, a joined line-end hyphen (U+FFFE) is not there, and
// `wholeWord` wants no letter or digit either side. Hits are ranges of this page's char indices, with their line rects.
// Pure: no DOM, no engine.
import type { Rotation, SearchHit } from '../../../viewer/src/backend/types';
import { ocrRects } from './rects';
import { JOINED_HYPHEN, ocrText } from './to-glyphs';
import type { OcrPageResult } from './types';

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The page's chars as one searchable string, and the char index each of its units came from. */
function searchable(text: string, matchCase: boolean): { s: string; from: number[] } {
  let s = '';
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === JOINED_HYPHEN) continue;
    if (c === '\r' || c === '\n') {
      if (s.endsWith(' ')) continue; // '\r\n' (and a space before it) is one space
      s += ' ';
      from.push(i);
      continue;
    }
    const folded = matchCase ? c : c.toLowerCase();
    const unit = folded.length === 1 ? folded : c;
    s += unit;
    from.push(i);
  }
  return { s, from };
}

export function searchOcr(r: OcrPageResult, query: string, o: { matchCase: boolean; wholeWord: boolean }, rotation: Rotation = 0): SearchHit[] {
  const q = (o.matchCase ? query : query.toLowerCase()).replace(/\s+/g, ' ');
  if (q.trim().length === 0) return [];
  const text = ocrText(r.words, rotation);
  const { s, from } = searchable(text, o.matchCase);
  const hits: SearchHit[] = [];
  for (let at = s.indexOf(q); at >= 0; at = s.indexOf(q, at + 1)) {
    const endAt = at + q.length;
    if (o.wholeWord && ((at > 0 && WORD_CHAR.test(s[at - 1]!)) || (endAt < s.length && WORD_CHAR.test(s[endAt]!)))) continue;
    const start = from[at]!;
    const last = from[endAt - 1]!;
    const count = last + 1 - start;
    hits.push({ pageIndex: r.pageIndex, start, count, rects: ocrRects(r, start, count, rotation) });
  }
  return hits;
}
