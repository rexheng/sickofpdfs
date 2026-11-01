// Task 22's e2e helpers for the text layer: a real mouse drag between two glyphs, seeded drag endpoints, and how well the
// layer's chars sit on PDFium's glyph boxes. They read the viewer through its test hooks (selectionRanges, glyphCenter).
import type { Page } from '@playwright/test';
import type { CharRange } from '../../packages/viewer/src/text-layer/char-map';
import { hooks } from './test';

/**
 * Clears the selection, then presses the mouse at the centre of glyph `a`'s PDFium box on page `pageIndex`, moves in 8
 * steps and releases at glyph `b`'s centre. Returns the selection as char ranges and as the DOM's text. Both glyphs must
 * be on screen and not under the viewer's toolbar (the helper scrolls the pair into the middle of the page list when
 * they are not); a char with no box of its own (a line break) has no centre to press on, and throws.
 */
export async function dragSelect(page: Page, pageIndex: number, a: number, b: number): Promise<{ ranges: CharRange[]; domText: string }> {
  const h = hooks(page);
  const centres = () => h.eval((x, q) => [x.glyphCenter(q[0], q[1]), x.glyphCenter(q[0], q[2])], [pageIndex, a, b] as [number, number, number]);
  let [pa, pb] = await centres();
  for (const [i, p] of [[a, pa], [b, pb]] as const) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error(`dragSelect: char ${i} on page ${pageIndex} has no glyph centre (no box, or no text layer yet)`);
  }
  // A point is reachable when the page is what the mouse would hit there (not the toolbar over the page list).
  const reachable = () =>
    page.evaluate(
      (q) =>
        q.every((p) => {
          const hit = document.elementFromPoint(p.x, p.y);
          return hit !== null && hit.closest('[data-page-index]') !== null;
        }),
      [pa, pb],
    );
  if (!(await reachable())) {
    // Centre the pair in the page list's scroll area.
    await page.evaluate(
      (d) => {
        const el = document.querySelector<HTMLElement>('[role="document"]');
        if (!el) return;
        const r = el.getBoundingClientRect();
        el.scrollLeft += d.x - (r.left + r.width / 2);
        el.scrollTop += d.y - (r.top + r.height / 2);
      },
      { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 },
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    [pa, pb] = await centres();
    if (!(await reachable())) throw new Error(`dragSelect: chars ${a} and ${b} are not both on screen together; use a larger viewport`);
  }
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await page.mouse.move(pa.x, pa.y);
  await page.mouse.down();
  await page.mouse.move(pb.x, pb.y, { steps: 8 });
  await page.mouse.up();
  return h.eval((x) => ({ ranges: x.selectionRanges(), domText: document.getSelection()?.toString() ?? '' }));
}

/**
 * `n` pairs of char indices in [0, glyphCount), the same for a seed whatever the zoom: even pairs anywhere on the page,
 * odd pairs at most 40 chars apart (mulberry32 seeded with the FNV-1a hash of `seed`). a ≠ b.
 */
export function seededPairs(glyphCount: number, n: number, seed: string): [number, number][] {
  if (glyphCount < 2) throw new Error('seededPairs: fewer than 2 chars');
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let state = h >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(rand() * glyphCount);
    let b = i % 2 === 0 ? Math.floor(rand() * glyphCount) : Math.min(glyphCount - 1, Math.max(0, a + Math.round((rand() - 0.5) * 80)));
    if (b === a) b = a + 1 < glyphCount ? a + 1 : a - 1;
    out.push([a, b]);
  }
  return out;
}

/**
 * For every char the text layer shows on page `pageIndex` that has a PDFium box: the largest distance (client px) between
 * an edge of its DOM range and the same edge of its PDFium box (scale and rotation applied), along the displayed text
 * direction, and the smallest share of the box's height (across the text) the DOM range covers. Chars that share one
 * PDFium box (ligatures such as "fi") get equal shares of it.
 */
export async function textLayerAlignment(page: Page, pageIndex: number): Promise<{ maxEdgeErrorPx: number; minVerticalOverlap: number }> {
  return hooks(page).eval(async (x, pi) => {
    const doc = x.doc();
    if (!doc) throw new Error('textLayerAlignment: no document open');
    const glyphs = (await x.backend.getPageGlyphs(doc.open.doc, pi)).glyphs;
    const pageEl = document.querySelector(`[data-page-index="${pi}"]`);
    const layer = pageEl?.querySelector('.sop-text-layer');
    if (!pageEl || !layer) throw new Error(`textLayerAlignment: page ${pi} has no text layer`);
    const spans = [...layer.querySelectorAll<HTMLElement>('span[data-start]:not(.sop-unselectable)')].map((s) => ({ node: s.firstChild, start: Number(s.dataset.start), length: s.textContent?.length ?? 0 }));
    // Boxes, with equal shares for chars that share one box.
    type Box = { x: number; y: number; width: number; height: number };
    const same = (p: Box | null, q: Box | null) => !!p && !!q && p.x === q.x && p.y === q.y && p.width === q.width && p.height === q.height;
    const boxes: (Box | null)[] = glyphs.map((g) => (!g.generated && g.text !== '\r' && g.text !== '\n' && g.box.width > 0 && g.box.height > 0 ? { ...g.box } : null));
    for (let i = 0; i < glyphs.length; ) {
      const b = boxes[i];
      let j = i + 1;
      if (b) while (j < glyphs.length && same(boxes[j], b) && glyphs[j].angle === glyphs[i].angle) j++;
      if (b && j - i > 1) {
        const k = j - i;
        const t = (glyphs[i].angle * Math.PI) / 180;
        const horizontal = Math.abs(Math.cos(t)) >= Math.abs(Math.sin(t));
        const forward = horizontal ? Math.cos(t) > 0 : Math.sin(t) > 0;
        for (let q = i; q < j; q++) {
          const slot = forward ? q - i : k - 1 - (q - i);
          boxes[q] = horizontal ? { x: b.x + (slot * b.width) / k, y: b.y, width: b.width / k, height: b.height } : { x: b.x, y: b.y + (slot * b.height) / k, width: b.width, height: b.height / k };
        }
      }
      i = j;
    }
    const pageBox = x.viewer.pageBoxes()[pi];
    const size = doc.open.pages[pi];
    if (!pageBox || !size) throw new Error(`textLayerAlignment: no page ${pi}`);
    const rot = pageBox.rotation;
    const turned = rot % 180 !== 0;
    const k = pageBox.width / (turned ? size.height : size.width);
    const origin = pageEl.getBoundingClientRect();
    const W = size.width;
    const H = size.height;
    const toClient = (px: number, py: number) => {
      const [dx, dy] = rot === 90 ? [H - py, px] : rot === 180 ? [W - px, H - py] : rot === 270 ? [py, W - px] : [px, py];
      return { x: origin.left + dx * k, y: origin.top + dy * k };
    };
    let maxEdgeErrorPx = 0;
    let minVerticalOverlap = Infinity;
    const r = document.createRange();
    for (const s of spans) {
      if (!(s.node instanceof Text)) continue;
      for (let o = 0; o < s.length; o++) {
        const i = s.start + o;
        const b = boxes[i];
        const code = s.node.data.charCodeAt(o);
        if (!b || (code >= 0xd800 && code <= 0xdfff)) continue;
        r.setStart(s.node, o);
        r.setEnd(s.node, o + 1);
        const dom = r.getBoundingClientRect();
        const p0 = toClient(b.x, b.y);
        const p1 = toClient(b.x + b.width, b.y + b.height);
        const pdf = { left: Math.min(p0.x, p1.x), right: Math.max(p0.x, p1.x), top: Math.min(p0.y, p1.y), bottom: Math.max(p0.y, p1.y) };
        const shown = (((glyphs[i].angle + rot) % 360) + 360) % 360;
        const vertical = Math.abs(Math.sin((shown * Math.PI) / 180)) > 0.5;
        const [d0, d1, q0, q1] = vertical ? [dom.top, dom.bottom, pdf.top, pdf.bottom] : [dom.left, dom.right, pdf.left, pdf.right];
        const [c0, c1, e0, e1] = vertical ? [dom.left, dom.right, pdf.left, pdf.right] : [dom.top, dom.bottom, pdf.top, pdf.bottom];
        maxEdgeErrorPx = Math.max(maxEdgeErrorPx, Math.abs(d0 - q0), Math.abs(d1 - q1));
        minVerticalOverlap = Math.min(minVerticalOverlap, Math.max(0, Math.min(c1, e1) - Math.max(c0, e0)) / (e1 - e0));
      }
    }
    return { maxEdgeErrorPx, minVerticalOverlap: Number.isFinite(minVerticalOverlap) ? minVerticalOverlap : 0 };
  }, pageIndex);
}
