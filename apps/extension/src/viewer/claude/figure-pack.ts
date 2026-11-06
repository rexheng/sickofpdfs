// Gathers what Claude needs to explain a figure, an area or a pin (plan Phase 4 slice C, research 06 section 7):
// the picture (drawn locally by renderRegion), the caption, the exact words inside it, and up to 3 paragraphs that name it.
// Nothing here sends anything. The turn runner (slice D) decides whether the pack goes to Anthropic.
import {
  DETAIL_BUDGET, cleanRuns, FIGURE_LIMITS, FIGURE_PADDING_PT, IMAGE_BUDGET, MAX_MENTIONS, figureLabelsIn, insideTextOf, intersect, isSmallMark, mentionsInPage, padAndClip, toPassage,
  type DocumentId, type FigurePack, type ModelRole, type PageFigure, type Passage, type RegionImage,
} from '@sop/core';
import { renderRegion, type PageTextProvider, type PdfBackend, type PdfRect, type PageSize } from '@sop/viewer';
import type { DocHandle } from '@sop/viewer';

export { figureLabelsIn };

/** The longest edge of the page image sent for context with a scanned area. */
const SCAN_PAGE_EDGE = 1092;
const SCAN_PAGE_BUDGET = 1300;
/** Looking for mentions stops here, so a 600-page file never makes a question wait. */
const MENTION_SCAN_PAGES = 400;
const MENTION_SCAN_MS = 600;
/** The words just above and below an area, in points. */
const AROUND_PT = 40;
const AROUND_MAX_CHARS = 700;

export interface FigurePackDeps {
  be: Pick<PdfBackend, 'renderTile' | 'getPageGlyphs' | 'listPageObjects' | 'getTextRuns'>;
  doc: DocHandle;
  /** OpenResult.pages. */
  pages: readonly PageSize[];
  text: PageTextProvider;
  /** FigureService.figures. */
  figures(pageIndex: number): Promise<PageFigure[]>;
  documentId: DocumentId;
}

/** What the owner pointed at. Rects and points are in points, unrotated page space, y down. */
export type FigureTarget =
  | { kind: 'figure'; pageIndex: number; figure: PageFigure; mark?: { rect?: PdfRect; point?: [number, number] } }
  | { kind: 'area'; pageIndex: number; rect: PdfRect };

export interface PackOptions {
  role: ModelRole;
  /** Tokens for the main picture. Default: by role (1,600 or 3,200), or 4,784 for a scan. */
  imageTokens?: number;
  signal?: AbortSignal;
}

const budgetFor = (role: ModelRole) => (role === 'think-harder' ? IMAGE_BUDGET.thinkHarder : IMAGE_BUDGET.default);

async function isScan(deps: FigurePackDeps, pageIndex: number): Promise<boolean> {
  return (await deps.text.text(pageIndex)).trim().length < 20;
}

export async function buildFigurePack(deps: FigurePackDeps, target: FigureTarget, o: PackOptions): Promise<FigurePack> {
  const page = deps.pages[target.pageIndex];
  if (!page) throw new Error(`buildFigurePack: no page ${target.pageIndex}`);
  const textSource = deps.text.source(target.pageIndex);
  const runs = await deps.be.getTextRuns(deps.doc, target.pageIndex);

  if (target.kind === 'figure') {
    const f = target.figure;
    const rect = padAndClip(f.rect, FIGURE_PADDING_PT, page);
    const base = { pageRotation: page.rotation, ...(o.signal ? { signal: o.signal } : {}) };
    const image = await renderRegion(deps.be, deps.doc, target.pageIndex, rect, {
      ...base, maxTokens: o.imageTokens ?? budgetFor(o.role), ...(target.mark ? { mark: target.mark } : {}),
    });
    const more: RegionImage[] = [];
    if (target.mark?.rect && isSmallMark(target.mark.rect, f.rect)) {
      more.push(await renderRegion(deps.be, deps.doc, target.pageIndex, padAndClip(target.mark.rect, FIGURE_PADDING_PT, page), { ...base, maxTokens: DETAIL_BUDGET, enlarge: true }));
    }
    const pageText = await deps.text.text(target.pageIndex);
    const caption = f.caption ? captionPassage(deps.documentId, target.pageIndex, textSource, pageText, f.caption) : null;
    const mentions = f.label ? await findMentions(deps, f.label, target.pageIndex, f.caption?.text ?? null) : [];
    return {
      label: f.label, pageIndex: target.pageIndex, image, caption, insideText: insideTextOf(runs, f.rect, f.captionRect),
      mentions, ...(more.length ? { more } : {}),
    };
  }

  // An area outside any figure: the crop, the words inside it, and the lines just above and below it.
  const scan = await isScan(deps, target.pageIndex);
  const rect = padAndClip(target.rect, FIGURE_PADDING_PT, page);
  const image = await renderRegion(deps.be, deps.doc, target.pageIndex, rect, {
    pageRotation: page.rotation, maxTokens: o.imageTokens ?? (scan ? IMAGE_BUDGET.scan : budgetFor(o.role)), scan, ...(o.signal ? { signal: o.signal } : {}),
  });
  const more: RegionImage[] = [];
  if (scan && target.rect.width * target.rect.height < (page.width * page.height) / 2) {
    // No text to cite: a small picture of the whole page tells Claude where the area sits.
    more.push(await renderRegion(deps.be, deps.doc, target.pageIndex, { x: 0, y: 0, width: page.width, height: page.height }, {
      pageRotation: page.rotation, maxTokens: SCAN_PAGE_BUDGET, maxEdge: SCAN_PAGE_EDGE, scan: true, ...(o.signal ? { signal: o.signal } : {}),
    }));
  }
  const inside = insideTextOf(runs, target.rect);
  const around = aroundText(runs, target.rect, page);
  return {
    label: null, pageIndex: target.pageIndex, image, caption: null, mentions: [],
    insideText: [inside, around ? `[around the area] ${around}` : ''].filter(Boolean).join('; '), ...(more.length ? { more } : {}),
  };
}

/**
 * Packs for several figures at once ("Compare Figure 2 and 3"): at most 4 figures up front, 1,200 image tokens each when
 * there is more than one, and at most 20 images in all (a small-mark crop is dropped before a figure is).
 */
export async function buildFigurePacks(deps: FigurePackDeps, targets: readonly FigureTarget[], o: PackOptions): Promise<FigurePack[]> {
  const chosen = targets.slice(0, FIGURE_LIMITS.figures);
  const each = chosen.length > 1 ? FIGURE_LIMITS.tokensEach : undefined;
  const packs: FigurePack[] = [];
  for (const t of chosen) {
    packs.push(await buildFigurePack(deps, t, { ...o, ...(each !== undefined ? { imageTokens: each } : {}) }));
  }
  let images = packs.reduce((n, p) => n + 1 + (p.more?.length ?? 0), 0);
  for (const p of packs.slice().reverse()) {
    if (images <= FIGURE_LIMITS.images) break;
    if (p.more?.length) { images -= p.more.length; delete p.more; }
  }
  return packs;
}

/** The figures a question names ("Compare Figure 2 and 3"), found in the document, in the order the question names them. */
export async function figuresNamedIn(deps: FigurePackDeps, question: string, o: { fromPage?: number } = {}): Promise<Extract<FigureTarget, { kind: 'figure' }>[]> {
  const wanted = figureLabelsIn(question);
  if (wanted.length === 0) return [];
  const found = new Map<string, Extract<FigureTarget, { kind: 'figure' }>>();
  // The page the owner is on, then the pages after it, then the pages before: a label is most often near.
  const start = Math.min(Math.max(0, o.fromPage ?? 0), Math.max(0, deps.pages.length - 1));
  for (let step = 0; step < deps.pages.length && found.size < wanted.length; step++) {
    const pageIndex = (start + step) % deps.pages.length;
    for (const fig of await deps.figures(pageIndex)) {
      if (fig.label && wanted.includes(fig.label) && !found.has(fig.label)) found.set(fig.label, { kind: 'figure', pageIndex, figure: fig });
    }
  }
  return wanted.flatMap((l) => found.get(l) ?? []);
}

// ---- Text ----

/** The caption as a Passage, positioned in the page's text() so a citation lands on it. */
function captionPassage(documentId: DocumentId, pageIndex: number, textSource: string, pageText: string, c: NonNullable<PageFigure['caption']>): Passage {
  const at = pageText.indexOf(c.text);
  const start = at >= 0 ? at : c.start;
  return { documentId, pageIndex, start, end: start + c.text.length, textSource, text: c.text, rank: 0, tokens: Math.ceil(c.text.length / 4) };
}

/**
 * Up to 3 passages that name the label: the first mention in the document, then those on the figure's page, then the next
 * ones in reading order. The caption itself is never one.
 */
async function findMentions(deps: FigurePackDeps, label: string, figurePage: number, captionText: string | null): Promise<Passage[]> {
  const t0 = performance.now();
  const out: Passage[] = [];
  const keys = new Set<string>();
  const scan = async (pageIndex: number, limit: number) => {
    const text = await deps.text.text(pageIndex);
    for (const w of mentionsInPage(text, label, pageIndex === figurePage ? captionText : null)) {
      const k = `${pageIndex}:${w.start}`;
      if (keys.has(k) || out.length >= limit) continue;
      keys.add(k);
      out.push(toPassage({ documentId: deps.documentId, pageIndex, textSource: deps.text.source(pageIndex), text, ...w }, out.length));
    }
  };
  const last = Math.min(deps.pages.length, MENTION_SCAN_PAGES);
  const late = () => performance.now() - t0 > MENTION_SCAN_MS;
  // First mention: the earliest page that names it (the figure's own page counts when it is the first).
  let firstPage = -1;
  for (let p = 0; p < last && out.length === 0 && !late(); p++) {
    await scan(p, 1);
    if (out.length > 0) firstPage = p;
  }
  // Same page next, then the rest in reading order.
  await scan(figurePage, MAX_MENTIONS);
  for (let p = Math.max(0, firstPage); p < last && out.length < MAX_MENTIONS && !late(); p++) await scan(p, MAX_MENTIONS);
  return out.slice(0, MAX_MENTIONS).map((p, rank) => ({ ...p, rank }));
}

/** The lines just above and below an area, as plain text, cut short. */
function aroundText(runs: Parameters<typeof insideTextOf>[0], rect: PdfRect, page: PageSize): string {
  const grown = padAndClip({ x: rect.x, y: rect.y - AROUND_PT, width: rect.width, height: rect.height + 2 * AROUND_PT }, 0, page);
  const near = cleanRuns(runs).filter((r) => intersect(r.rect, grown) && !intersect(r.rect, rect));
  near.sort((a, b) => Math.round(a.rect.y / 6) - Math.round(b.rect.y / 6) || a.rect.x - b.rect.x);
  const text = near.map((r) => r.text.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
  return text.length > AROUND_MAX_CHARS ? `${text.slice(0, AROUND_MAX_CHARS - 1).trimEnd()}…` : text;
}
