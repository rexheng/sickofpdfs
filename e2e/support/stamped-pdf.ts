// Makes a JSTOR-style stamped PDF: 8 pages of body text with the download stamp at the foot of every page. The same body
// with another IP address and date is "the same paper downloaded again": different bytes (so a different fingerprint), the
// same text. The text is the pages of packages/core/test/stamp-samples.ts, so a PDF read back through the engine matches
// pagesWithStamp() for the same arguments, up to line breaks. Used by the store and walkthrough tests for stamp aliases.
import { createHash } from 'node:crypto';
import { PDFDocument, PDFHexString, StandardFonts, type PDFFont } from 'pdf-lib';
import { bodyPages, stampLines, type StampBody } from '../../packages/core/test/stamp-samples';

const PAGES = 8;
const CHARS_PER_PAGE = 3750;
const PAGE: [number, number] = [612, 792];
const MARGIN = 54;
const BODY_SIZE = 9.5;
const BODY_LEADING = 12;
const STAMP_SIZE = 8;

/** `text` broken into lines no wider than `width`, at word boundaries. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * An 8-page PDF of one paper's text with this stamp on every page. The same `body` with a different `stamp` differs in the
 * stamp lines, in /ID and in /CreationDate, and nowhere else. `body` picks the paper ('other-body' is a different one).
 */
export async function makeStampedPdf(stamp: { ip: string; date: string }, body: StampBody = 'jstor-body'): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const [lineOne, lineTwo] = stampLines(stamp.ip, stamp.date).split('\n');

  for (const text of bodyPages(body, PAGES, CHARS_PER_PAGE)) {
    const page = doc.addPage(PAGE);
    let y = PAGE[1] - MARGIN;
    for (const line of wrap(text, font, BODY_SIZE, PAGE[0] - 2 * MARGIN)) {
      page.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font });
      y -= BODY_LEADING;
    }
    page.drawText(lineOne, { x: MARGIN, y: 40, size: STAMP_SIZE, font });
    page.drawText(lineTwo, { x: MARGIN, y: 28, size: STAMP_SIZE, font });
  }

  // A real download has its own creation date and file id, so these differ between two downloads like everything else.
  const made = new Date(stamp.date);
  const created = Number.isNaN(made.getTime()) ? new Date(0) : made;
  doc.setCreationDate(created);
  doc.setModificationDate(created);
  const id = PDFHexString.of(createHash('md5').update(`${stamp.ip}|${stamp.date}`).digest('hex'));
  doc.context.trailerInfo.ID = doc.context.obj([id, id]);

  return doc.save();
}
