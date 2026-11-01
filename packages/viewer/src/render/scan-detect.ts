// Is a page a scan? Owner decision (2026-11-01): a page with no text layer shows a quiet "This is a scan" hint, since
// selection needs Chrome's own viewer (which runs OCR) until Phase 7.
import type { DocHandle, PageSize, PdfBackend } from '../backend/types';

/** Fewer visible characters than this counts as no text layer (stray page numbers, a running head of one word). */
const MIN_TEXT_CHARS = 10;
/** The images must cover at least this share of the page (a photographed receipt on a Letter page covers about 40%). */
const MIN_IMAGE_SHARE = 0.25;
/** The object walk is cut short here: a scan page holds a handful of objects. */
const MAX_OBJECTS = 500;
const BUDGET_MS = 10;

/**
 * Answers, once per page, whether it is a scan: fewer than MIN_TEXT_CHARS non-space characters of text, and image
 * objects covering at least a quarter of the page. The two engine calls are quick, but they share the engine with
 * rendering, so ask for the page in view once the reader has settled on it, not for every page.
 */
export class ScanDetector {
  private readonly answers = new Map<number, Promise<boolean>>();

  constructor(
    private readonly backend: PdfBackend,
    private readonly doc: DocHandle,
    private readonly pages: PageSize[],
  ) {}

  isScannedPage(pageIndex: number): Promise<boolean> {
    let answer = this.answers.get(pageIndex);
    if (!answer) {
      answer = this.detect(pageIndex);
      this.answers.set(pageIndex, answer);
      answer.catch(() => this.answers.delete(pageIndex)); // an engine failure may be asked again
    }
    return answer;
  }

  private async detect(pageIndex: number): Promise<boolean> {
    const page = this.pages[pageIndex];
    if (!page) return false;
    const text = await this.backend.getPageText(this.doc, pageIndex);
    if (text.replace(/\s/g, '').length >= MIN_TEXT_CHARS) return false;
    const { objects } = await this.backend.listPageObjects(this.doc, pageIndex, { maxObjects: MAX_OBJECTS, budgetMs: BUDGET_MS });
    const imageArea = objects.filter((o) => o.type === 'image').reduce((sum, o) => sum + o.bounds.width * o.bounds.height, 0);
    return imageArea >= MIN_IMAGE_SHARE * page.width * page.height;
  }
}
