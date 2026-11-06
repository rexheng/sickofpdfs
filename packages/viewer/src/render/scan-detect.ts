// Is a page a scan? Owner decision (2026-11-01): a page with no text layer shows a quiet "This is a scan" hint, since
// selection needs Chrome's own viewer (which runs OCR) until Phase 7.
//
// A page with a real text layer is never a scan (Test build 5 and 6 critics: a slide deck is not a scan). A slide's
// few words over a picture are real text; and a deck's picture slide is a picture, not a scan, when most of the deck's
// pages have text.
import type { DocHandle, PageSize, PdfBackend } from '../backend/types';

/** Fewer visible characters than this counts as no text layer (stray page numbers, a running head of one word). */
const MIN_TEXT_CHARS = 10;
/** A page whose text has this many letters drawn as real, visible glyphs (a slide's title) has a real text layer. */
const MIN_REAL_LETTERS = 2;
/** The images must cover at least this share of the page (a photographed receipt on a Letter page covers about 40%). */
const MIN_IMAGE_SHARE = 0.25;
/** The object walk is cut short here: a scan page holds a handful of objects. */
const MAX_OBJECTS = 500;
const BUDGET_MS = 10;
/** Pages read, spread through the PDF, to tell whether it is a text PDF (once a document, when a page may be a scan). */
const DOC_SAMPLE_PAGES = 12;
/** A PDF whose sampled pages have text this often is a text PDF: a page of it with no text is a picture, not a scan. */
const TEXT_DOC_SHARE = 0.5;

const letters = (text: string) => text.match(/\p{L}/gu)?.length ?? 0;

/**
 * Answers, once per page, whether it is a scan: fewer than MIN_TEXT_CHARS non-space characters of text, no real text
 * (fewer than MIN_REAL_LETTERS letters with visible glyphs), image objects covering at least a quarter of the page, and
 * a PDF that is not a text PDF (most of its pages without text). The engine calls are quick, but they share the engine
 * with rendering, so ask for the page in view once the reader has settled on it, not for every page.
 */
export class ScanDetector {
  private readonly answers = new Map<number, Promise<boolean>>();
  private readonly imagePages = new Map<number, Promise<boolean>>();
  private textDoc: Promise<boolean> | null = null;

  constructor(
    private readonly backend: PdfBackend,
    private readonly doc: DocHandle,
    private readonly pages: PageSize[],
  ) {}

  isScannedPage(pageIndex: number): Promise<boolean> {
    return once(this.answers, pageIndex, () => this.detect(pageIndex));
  }

  /**
   * Whether images cover at least a quarter of the page, whatever its text. A scan with an OCR text layer has text, but
   * no glyph a reading aid can draw (bold word starts, R90): such a page is a scan too.
   */
  isImagePage(pageIndex: number): Promise<boolean> {
    return once(this.imagePages, pageIndex, async () => {
      const page = this.pages[pageIndex];
      if (!page) return false;
      const { objects } = await this.backend.listPageObjects(this.doc, pageIndex, { maxObjects: MAX_OBJECTS, budgetMs: BUDGET_MS });
      const imageArea = objects.filter((o) => o.type === 'image').reduce((sum, o) => sum + o.bounds.width * o.bounds.height, 0);
      return imageArea >= MIN_IMAGE_SHARE * page.width * page.height;
    });
  }

  private async detect(pageIndex: number): Promise<boolean> {
    if (!this.pages[pageIndex]) return false;
    const text = await this.backend.getPageText(this.doc, pageIndex);
    if (text.replace(/\s/g, '').length >= MIN_TEXT_CHARS) return false;
    if (letters(text) >= MIN_REAL_LETTERS && (await this.hasRealText(pageIndex))) return false;
    if (!(await this.isImagePage(pageIndex))) return false;
    return !(await this.isTextDocument());
  }

  /**
   * Whether the page draws at least MIN_REAL_LETTERS letters as visible glyphs: the engine leaves out invisible text
   * (a scan's OCR layer), clipped text and text under a picture (getGlyphShapes). Only asked of a page with little text.
   */
  private async hasRealText(pageIndex: number): Promise<boolean> {
    const chars = await this.backend.getPageChars(this.doc, pageIndex);
    const { glyphs } = await this.backend.getGlyphShapes(this.doc, pageIndex, 0, chars.length);
    return glyphs.filter((g) => /\p{L}/u.test(chars[g.charIndex] ?? '')).length >= MIN_REAL_LETTERS;
  }

  /** Whether most of DOC_SAMPLE_PAGES pages spread through the PDF have text (MIN_REAL_LETTERS letters): asked once. */
  private isTextDocument(): Promise<boolean> {
    if (this.textDoc) return this.textDoc;
    const asked = (async () => {
      const count = this.pages.length;
      const n = Math.min(count, DOC_SAMPLE_PAGES);
      const sample = [...new Set(Array.from({ length: n }, (_, k) => Math.floor((k * count) / n)))];
      let withText = 0;
      for (const i of sample) if (letters(await this.backend.getPageText(this.doc, i)) >= MIN_REAL_LETTERS) withText++;
      return withText >= TEXT_DOC_SHARE * sample.length;
    })();
    this.textDoc = asked;
    asked.catch(() => {
      if (this.textDoc === asked) this.textDoc = null; // an engine failure may be asked again
    });
    return asked;
  }
}

/** One answer per page: asked again only after an engine failure. */
function once(answers: Map<number, Promise<boolean>>, pageIndex: number, ask: () => Promise<boolean>): Promise<boolean> {
  let answer = answers.get(pageIndex);
  if (!answer) {
    answer = ask();
    answers.set(pageIndex, answer);
    answer.catch(() => answers.delete(pageIndex)); // an engine failure may be asked again
  }
  return answer;
}
