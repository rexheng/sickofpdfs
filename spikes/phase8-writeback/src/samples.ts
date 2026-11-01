// The note set the spike writes: one of each kind our product has (contracts §9), built from real text on a real PDF.
// Positions come from the product engine (search, getTextRangeRects, getGlyphOutlines) on a view handle; the write goes
// through a separate fresh handle (writeback.ts), as slice 8.2 will do it.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { REPO } from './engine.ts';
import { quadFor, readGeometry, rectToUser, unionUser, type PageGeometry, type TopLeftRect } from './geometry.ts';
import { contentStream, parseOutline } from './svgpath.ts';
import { FLAG, type AnnotSpec } from './writeback.ts';

export type RepliesVariant = 'A' | 'B' | 'C';
export interface Expect {
  nm: string; subtype: string; pageIndex: number; rect: [number, number, number, number];
  quads?: [number, number, number, number][];   // user-space rect of each quad
  rgb?: [number, number, number]; contents?: string; author?: string; subject?: string; irt?: string; popupOf?: string; flags: number;
  pixel?: 'fill' | 'underline' | 'strike' | 'bold' | 'box' | 'icon' | 'none';
}

/** The mark colours the product exports: read from the token file, the way scripts/gen-mark-rgb.mjs (slice 8.3) will. */
export function readTokenColours(): Record<string, [number, number, number]> {
  const css = readFileSync(resolve(REPO, 'packages/ui/src/tokens/tokens.css'), 'utf8');
  const out: Record<string, [number, number, number]> = {};
  for (const m of css.matchAll(/--(sop-(?:mark-\d(?:-line)?|area-outline|thread-underline)):\s*#([0-9a-fA-F]{6})/g)) {
    const h = m[2]!;
    out[m[1]!] = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return out;
}

const uuid = (seed: string) => {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

interface Engine {
  getPageChars(id: string, p: number): string;
  getTextRangeRects(id: string, p: number, s: number, c: number): TopLeftRect[];
  getGlyphOutlines(id: string, p: number, s: number, c: number): { charIndex: number; d: string; fill: number[] | null; stroke: number[] | null }[];
  openDocument(id: string, b: ArrayBuffer): { pageCount: number; pages: { width: number; height: number; rotation: number }[] };
}

export interface Env {
  native: Engine;
  mod: Parameters<typeof readGeometry>[0];
  viewId: string;
  pages: { width: number; height: number; rotation: number }[];
  owner: string;
  base: Date;
}

const geomCache = new WeakMap<Env, Map<number, PageGeometry>>();
export function geom(env: Env, p: number): PageGeometry {
  let m = geomCache.get(env);
  if (!m) geomCache.set(env, (m = new Map()));
  let g = m.get(p);
  if (!g) {
    // the view handle's page object is not exposed; geometry is read on a throwaway raw handle by the caller (see makeEnv)
    throw new Error(`geometry for page ${p} was not preloaded`);
  }
  g = m.get(p)!;
  return g;
}
export function preloadGeometry(env: Env, p: number, g: PageGeometry): void {
  let m = geomCache.get(env);
  if (!m) geomCache.set(env, (m = new Map()));
  m.set(p, g);
}

function find(env: Env, page: number, phrase: string): number {
  const text = env.native.getPageChars(env.viewId, page);
  const i = text.indexOf(phrase);
  if (i < 0) throw new Error(`"${phrase}" is not on page ${page}`);
  return i;
}

/** User-space rectangles (one per line) of `count` chars starting at `phrase` on `page`. */
function span(env: Env, page: number, phrase: string, count = phrase.length) {
  const start = find(env, page, phrase);
  const g = geom(env, page);
  const rects = env.native.getTextRangeRects(env.viewId, page, start, count).map((r) => rectToUser(g, r));
  return { start, count, g, rects };
}

const at = (env: Env, minutes: number) => new Date(env.base.getTime() + minutes * 60_000);

export interface Built { specs: AnnotSpec[]; expect: Expect[]; notes: string[] }

/** All notes. `variant` decides how replies are written (A empty-appearance threaded, B hidden threaded, C folded). */
export function buildNotes(env: Env, variant: RepliesVariant): Built {
  const col = readTokenColours();
  const rgbOf = (k: string): [number, number, number] => col[k] ?? [0, 0, 0];
  const specs: AnnotSpec[] = [];
  const expect: Expect[] = [];
  const notes: string[] = [];
  const me = env.owner;
  const PRINT = FLAG.Print;

  const markup = (o: { id: string; sub: 'Highlight' | 'Underline' | 'StrikeOut'; page: number; rects: [number, number, number, number][]; g: PageGeometry; rgb: [number, number, number]; ap: AnnotSpec['ap']; contents?: string; author?: string; minutes: number; pixel: Expect['pixel'] }) => {
    const nm = `sop:${uuid(o.id)}`;
    const rect = unionUser(o.rects);
    const s: AnnotSpec = { subtype: o.sub, pageIndex: o.page, rect, quads: o.rects.map((r) => [...quadFor(o.g, r)] as AnnotSpec['quads'] extends (infer Q)[] | undefined ? Q : never), rgb: o.rgb, nm, author: o.author ?? me, contents: o.contents ?? '', created: at(env, o.minutes), modified: at(env, o.minutes), flags: PRINT, ap: o.ap };
    specs.push(s);
    expect.push({ nm, subtype: o.sub, pageIndex: o.page, rect, quads: o.rects, rgb: o.rgb, contents: o.contents ?? '', author: s.author, flags: PRINT, pixel: o.pixel });
    return nm;
  };

  const popup = (parentNm: string, page: number, g: PageGeometry, anchor: [number, number, number, number], minutes: number) => {
    const [cl, cb, cr, ct] = g.crop;
    const w = 220, h = 120;
    const left = Math.min(Math.max(cl, anchor[2] + 8), cr - w);
    const top = Math.min(ct, Math.max(cb + h, anchor[3]));
    const nm = `${parentNm}~popup`;
    specs.push({ subtype: 'Popup', pageIndex: page, rect: [left, top - h, left + w, top], nm, popupOfNm: parentNm, flags: 0, ap: 'none', modified: at(env, minutes) });
    expect.push({ nm, subtype: 'Popup', pageIndex: page, rect: [left, top - h, left + w, top], flags: 0, popupOf: parentNm, pixel: 'none' });
  };

  /** A thread's replies: threaded as /Text with /IRT, or folded into the root's /Contents. Returns the folded suffix. */
  const replies = (rootNm: string, page: number, anchor: [number, number, number, number], list: { author: string; text: string }[], minutes: number): string => {
    if (variant === 'C') return list.map((r) => `\n\n${r.author}: ${r.text}`).join('');
    list.forEach((r, i) => {
      const nm = `${rootNm}~r${i + 1}`;
      const flags = variant === 'B' ? FLAG.Hidden : PRINT | FLAG.NoZoom | FLAG.NoRotate;
      const rect: [number, number, number, number] = [anchor[0], anchor[3] - 16, anchor[0] + 16, anchor[3]];
      specs.push({ subtype: 'Text', pageIndex: page, rect, nm, author: r.author, contents: r.text, subject: 'Reply', created: at(env, minutes + i + 1), modified: at(env, minutes + i + 1), flags, irtNm: rootNm, rt: 'R', rgb: [255, 235, 59], ap: { stream: 'q Q' } });
      expect.push({ nm, subtype: 'Text', pageIndex: page, rect, author: r.author, contents: r.text, subject: 'Reply', irt: rootNm, flags, pixel: 'none' });
    });
    return '';
  };

  // ---- 1. plain marks (page 0) ----
  const p0 = 0;
  {
    const s = span(env, p0, 'This work is a component of a', 'This work is a component of a\nlarger project on income risk'.length);
    markup({ id: 'm1', sub: 'Highlight', page: p0, rects: s.rects, g: s.g, rgb: rgbOf('sop-mark-1'), ap: 'pdfium-multiply', minutes: 1, pixel: 'fill' });
    notes.push('Highlight, yellow, two lines');
  }
  {
    const s = span(env, p0, 'Stefanie', 'Stefanie\nStantcheva'.length);
    markup({ id: 'm2', sub: 'Underline', page: p0, rects: s.rects, g: s.g, rgb: rgbOf('sop-mark-2-line'), ap: 'pdfium', minutes: 2, pixel: 'underline' });
    notes.push('Underline, green');
  }
  {
    const s = span(env, p0, 'Working Paper 29000', 'Working Paper 29000'.length);
    markup({ id: 'm3', sub: 'StrikeOut', page: p0, rects: s.rects, g: s.g, rgb: rgbOf('sop-mark-4-line'), ap: 'pdfium', minutes: 3, pixel: 'strike' });
    notes.push('Strikethrough, pink');
  }
  // ---- 2. bold (page 1): a Square with no border whose appearance is the glyph outlines ----
  {
    const phrase = 'idiosyncratic and exogenous changes';
    const page = 1;
    const s = span(env, page, phrase);
    const outlines = env.native.getGlyphOutlines(env.viewId, page, s.start, s.count);
    const [cl, , , ct] = s.g.crop;
    const toUser = (x: number, y: number) => ({ x: cl + x, y: ct - y });
    const stream = contentStream(outlines.map((o) => {
      const fill = (o.fill ?? o.stroke ?? [0, 0, 0, 255]) as [number, number, number, number];
      return { cmds: parseOutline(o.d, toUser), fill, stroke: fill, width: 0.03 * 10.5 };
    }));
    const nm = `sop:${uuid('bold1')}`;
    const rect = unionUser(s.rects);
    // pad the rect by the stroke so the stroked edge is inside the BBox
    const pad = 0.5;
    const padded: [number, number, number, number] = [rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad];
    specs.push({ subtype: 'Square', pageIndex: page, rect: padded, nm, author: me, subject: 'Bold', contents: '', created: at(env, 4), modified: at(env, 4), flags: PRINT, noBorder: true, ap: { stream } });
    expect.push({ nm, subtype: 'Square', pageIndex: page, rect: padded, author: me, subject: 'Bold', flags: PRINT, pixel: 'bold', contents: '' });
    notes.push('Bold, glyph outlines in a Square with /Subj (Bold)');
  }
  // ---- 3. area mark (page 1) ----
  {
    const page = 1;
    const g = geom(env, page);
    const [cl, , , ct] = g.crop;
    const rect: [number, number, number, number] = [cl + 330, ct - 330, cl + 540, ct - 300];
    const nm = `sop:${uuid('area1')}`;
    specs.push({ subtype: 'Square', pageIndex: page, rect, nm, author: me, subject: 'Area', contents: '', rgb: rgbOf('sop-area-outline'), borderWidth: 1.5, created: at(env, 5), modified: at(env, 5), flags: PRINT, ap: 'pdfium' });
    expect.push({ nm, subtype: 'Square', pageIndex: page, rect, rgb: rgbOf('sop-area-outline'), author: me, subject: 'Area', flags: PRINT, pixel: 'box', contents: '' });
    notes.push('Area, yellow-gold outline, no fill');
  }
  // ---- 4. threads ----
  {
    // T1: a text thread on a highlight; the highlight is the root, with a closed popup. Polish in the comment.
    const page = 1;
    const s = span(env, page, 'We study how Americans respond to idiosyncratic', 'We study how Americans respond to idiosyncratic and exogenous changes in household wealth'.length);
    const rootNm = `sop:${uuid('t1')}`;
    const list = [{ author: 'Claude', text: 'Idiosyncratic means specific to one household: here, a lottery win.' }, { author: me, text: 'Zażółć gęślą jaźń: that helps, thanks.' }];
    const tail = variant === 'C' ? list.map((r) => `\n\n${r.author}: ${r.text}`).join('') : '';
    const rect = unionUser(s.rects);
    specs.push({ subtype: 'Highlight', pageIndex: page, rect, quads: s.rects.map((r) => [...quadFor(s.g, r)] as never), rgb: rgbOf('sop-mark-5'), nm: rootNm, author: me, contents: `What does "idiosyncratic" mean here?${tail}`, subject: 'Thread', created: at(env, 6), modified: at(env, 6), flags: PRINT, ap: 'pdfium-multiply' });
    expect.push({ nm: rootNm, subtype: 'Highlight', pageIndex: page, rect, quads: s.rects, rgb: rgbOf('sop-mark-5'), author: me, contents: `What does "idiosyncratic" mean here?${tail}`, subject: 'Thread', flags: PRINT, pixel: 'fill' });
    popup(rootNm, page, s.g, rect, 6);
    replies(rootNm, page, rect, list, 6);
    notes.push(`Thread on a highlight (orange) with 2 replies, one from Claude [${variant}]`);
  }
  {
    // T2: a text thread with no highlight: an Underline with a dotted appearance.
    const page = 1;
    const s = span(env, page, 'event-study design', 'event-study design'.length);
    const rootNm = `sop:${uuid('t2')}`;
    const rect = unionUser(s.rects);
    const list = [{ author: me, text: 'Привет: это определение мне нужно позже.' }];
    const tail = variant === 'C' ? list.map((r) => `\n\n${r.author}: ${r.text}`).join('') : '';
    const lineY = rect[1] + 1.2;
    const grey = rgbOf('sop-thread-underline');
    const stream = contentStream(s.rects.map((ur) => ({
      cmds: [{ c: 'M' as const, x: ur[0], y: ur[1] + 1.2 }, { c: 'L' as const, x: ur[2], y: ur[1] + 1.2 }],
      stroke: [...grey, 255] as [number, number, number, number], width: 1, dash: [1.2, 1.8],
    })));
    void lineY;
    specs.push({ subtype: 'Underline', pageIndex: page, rect, quads: s.rects.map((r) => [...quadFor(s.g, r)] as never), rgb: grey, nm: rootNm, author: me, contents: `What is an event-study design?${tail}`, subject: 'Thread', created: at(env, 7), modified: at(env, 7), flags: PRINT, ap: { stream } });
    expect.push({ nm: rootNm, subtype: 'Underline', pageIndex: page, rect, quads: s.rects, rgb: grey, author: me, contents: `What is an event-study design?${tail}`, subject: 'Thread', flags: PRINT, pixel: 'underline' });
    popup(rootNm, page, s.g, rect, 7);
    replies(rootNm, page, rect, list, 7);
    notes.push(`Thread on plain text: dotted Underline root + popup, 1 reply (Cyrillic) [${variant}]`);
  }
  {
    // T3: an area/figure thread: a Square outline is the root. CJK in the comment.
    const page = 0;
    const g = geom(env, page);
    const [cl, , , ct] = g.crop;
    const rect: [number, number, number, number] = [cl + 70, ct - 330, cl + 300, ct - 250];
    const rootNm = `sop:${uuid('t3')}`;
    const list = [{ author: 'Claude', text: '日本語のテスト: 図の説明です。' }];
    const tail = variant === 'C' ? list.map((r) => `\n\n${r.author}: ${r.text}`).join('') : '';
    specs.push({ subtype: 'Square', pageIndex: page, rect, rgb: rgbOf('sop-area-outline'), borderWidth: 1.5, nm: rootNm, author: me, contents: `Figure outline. 你好，世界${tail}`, subject: 'Figure', created: at(env, 8), modified: at(env, 8), flags: PRINT, ap: 'pdfium' });
    expect.push({ nm: rootNm, subtype: 'Square', pageIndex: page, rect, rgb: rgbOf('sop-area-outline'), author: me, contents: `Figure outline. 你好，世界${tail}`, subject: 'Figure', flags: PRINT, pixel: 'box' });
    popup(rootNm, page, g, rect, 8);
    replies(rootNm, page, rect, list, 8);
    notes.push(`Thread on an area: Square root + popup, 1 reply (CJK) [${variant}]`);
  }
  {
    // pin / point note, page note, document note: /Text with the note icon
    const g0 = geom(env, 0);
    const [cl, , , ct] = g0.crop;
    const pin: [number, number, number, number] = [cl + 420, ct - 420, cl + 440, ct - 400];
    const pinNm = `sop:${uuid('pin1')}`;
    specs.push({ subtype: 'Text', pageIndex: 0, rect: pin, nm: pinNm, author: me, contents: 'A pin on the page.', subject: 'Pin', created: at(env, 9), modified: at(env, 9), flags: PRINT | FLAG.NoZoom | FLAG.NoRotate, rgb: rgbOf('sop-mark-1'), iconName: 'Comment', ap: 'pdfium' });
    expect.push({ nm: pinNm, subtype: 'Text', pageIndex: 0, rect: pin, author: me, contents: 'A pin on the page.', subject: 'Pin', flags: PRINT | FLAG.NoZoom | FLAG.NoRotate, pixel: 'icon' });
    popup(pinNm, 0, g0, pin, 9);
    const pg: [number, number, number, number] = [cl + 24, ct - 44, cl + 44, ct - 24];
    const pgNm = `sop:${uuid('page1')}`;
    specs.push({ subtype: 'Text', pageIndex: 1, rect: [pg[0], pg[1], pg[2], pg[3]], nm: pgNm, author: me, contents: 'A note on the whole page.', subject: 'Page note', created: at(env, 10), modified: at(env, 10), flags: PRINT | FLAG.NoZoom | FLAG.NoRotate, rgb: rgbOf('sop-mark-1'), iconName: 'Note', ap: 'pdfium' });
    expect.push({ nm: pgNm, subtype: 'Text', pageIndex: 1, rect: pg, author: me, contents: 'A note on the whole page.', subject: 'Page note', flags: PRINT | FLAG.NoZoom | FLAG.NoRotate, pixel: 'icon' });
    popup(pgNm, 1, g0, pg, 10);
    const dc: [number, number, number, number] = [cl + 24, ct - 80, cl + 44, ct - 60];
    const dcNm = `sop:${uuid('doc1')}`;
    specs.push({ subtype: 'Text', pageIndex: 0, rect: dc, nm: dcNm, author: me, contents: 'A note on the whole document.', subject: 'Document note', created: at(env, 11), modified: at(env, 11), flags: PRINT | FLAG.NoZoom | FLAG.NoRotate, rgb: rgbOf('sop-mark-1'), iconName: 'Note', ap: 'pdfium' });
    expect.push({ nm: dcNm, subtype: 'Text', pageIndex: 0, rect: dc, author: me, contents: 'A note on the whole document.', subject: 'Document note', flags: PRINT | FLAG.NoZoom | FLAG.NoRotate, pixel: 'icon' });
    popup(dcNm, 0, g0, dc, 11);
    notes.push('Pin, page note, document note: /Text note icons with closed popups');
  }
  void replies;
  return { specs, expect, notes };
}
