// The geometry module of S7 (packages/viewer/src/marks/geometry.ts) as the spec-blind tests call it.
//
// The plan names what the module does and almost none of its names: "Conversions from PdfRect to NormRect (crop box) and
// from NormRect to CSS px, at any rotation. One SVG path per style and colour, so overlaps never darken. Underline sits at
// the rect's bottom, strikethrough at its middle, and the dotted underline uses the same rects. A hit test, and sortKey."
// Only `sortKey` is a name. So the tests do not import the functions: they ask this file, and this file is the one place
// that says what the tests GUESS.
//
// How a guess is checked: for each function, a few likely names and call shapes are tried, and the first one that
// reproduces a probe with a known answer is used (a probe is a case small enough to work out by hand). When none does, the
// test fails with the list of what was tried and what the module exports, and this file is the only thing to adjust.
//
// What the guesses mean, in one place:
// The shapes the code publishes (implementer's signature list), which the probes below settle on:
//   pdfRectToNorm(rect: PdfRect, page: { width, height }): NormRect                      points -> 0..1 of the crop box
//   normToCss(norm: NormRect, { width, height }, scale, rotation)                         0..1 -> CSS px on the turned page
//     (rotation is the TOTAL turn: the page's /Rotate plus the viewer's own turn, clockwise; scale is CSS px per point)
//   markPaths(shapes: { style, color, rects: Box[] }[], { rotation })                    -> { style, color, d }[]; rects are CSS-px boxes
//   hitTest(items: { id, rects: Box[] }[], point: { x, y })                               -> the ids hit, the last drawn first; rects are CSS-px boxes
//   sortKey(anchor)                                                                       -> the top of the anchor's first rect (0..1), the sort_key column;
//                                                                                            rows are ordered by (page_index, sort_key); null for a document note
import * as geometry from '../../src/marks/geometry';
import type { PdfRect, Rotation } from '../../src/backend/types';

export type NormRect = [x0: number, y0: number, x1: number, y1: number];
export interface PageBox {
  /** The unrotated crop box, in points. */
  width: number;
  height: number;
  /** The page's own /Rotate. */
  rotation: Rotation;
}
export interface View extends PageBox {
  /** CSS px per point. */
  scale: number;
  /** The viewer's rotation, added to the page's. */
  viewRotation: Rotation;
}
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type PaintStyle = 'highlight' | 'underline' | 'strike' | 'dotted';
export interface PaintMark {
  id: string;
  style: PaintStyle;
  color: 1 | 2 | 3 | 4 | 5;
  rects: NormRect[];
}
export interface PaintedPath {
  style: string;
  color: number | null;
  d: string;
}

const exported = geometry as unknown as Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

function find(names: string[]): { name: string; fn: Fn } | null {
  for (const name of names) if (typeof exported[name] === 'function') return { name, fn: exported[name] as Fn };
  return null;
}

class Unbound extends Error {
  constructor(what: string, tried: string[], detail = '') {
    super(`geometry.ts: no ${what} found. Tried ${tried.join(', ')}. It exports: ${Object.keys(exported).join(', ') || '(nothing)'}. ${detail}`.trim());
  }
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function toNumbers(v: unknown): number[] | null {
  if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number')) return v;
  return null;
}

function asBox(v: unknown): Box | null {
  const a = toNumbers(v);
  if (a) return { x: a[0], y: a[1], width: a[2], height: a[3] }; // [x, y, width, height]; a [x0, y0, x1, y1] is told apart by the probes
  if (v && typeof v === 'object') {
    const o = v as Record<string, number | undefined>;
    const x = o.x ?? o.left;
    const y = o.y ?? o.top;
    const width = o.width ?? o.w ?? (o.right !== undefined && x !== undefined ? o.right - x : undefined);
    const height = o.height ?? o.h ?? (o.bottom !== undefined && y !== undefined ? o.bottom - y : undefined);
    if ([x, y, width, height].every((n) => typeof n === 'number')) return { x: x as number, y: y as number, width: width as number, height: height as number };
  }
  return null;
}

const sameBox = (a: Box | null, b: Box) => a !== null && close(a.x, b.x) && close(a.y, b.y) && close(a.width, b.width) && close(a.height, b.height);

// ---------------------------------------------------------------------------------------------------------------
// PdfRect -> NormRect

type NormCall = (f: Fn, r: PdfRect, p: { width: number; height: number }) => unknown;
const NORM_SHAPES: NormCall[] = [(f, r, p) => f(r, p), (f, r, p) => f(r, p.width, p.height), (f, r, p) => f(p, r)];

let normBound: ((r: PdfRect, p: { width: number; height: number }) => NormRect) | null = null;
export function pdfRectToNorm(r: PdfRect, page: { width: number; height: number }): NormRect {
  if (!normBound) {
    const names = ['pdfRectToNorm', 'pdfToNorm', 'toNormRect', 'normalizeRect', 'rectToNorm', 'pdfRectToNormRect', 'normRect'];
    const found = find(names);
    if (!found) throw new Unbound('PdfRect -> NormRect function', names);
    const probe = { r: { x: 20, y: 10, width: 60, height: 30 }, p: { width: 200, height: 100 } };
    const want: NormRect = [0.1, 0.1, 0.4, 0.4];
    const shape = NORM_SHAPES.find((s) => {
      try {
        const out = s(found.fn, probe.r, probe.p);
        const a = toNumbers(out);
        return a !== null && a.every((n, i) => close(n, want[i]));
      } catch {
        return false;
      }
    });
    if (!shape) throw new Unbound('call shape for ' + found.name, ['(rect, page)', '(rect, width, height)', '(page, rect)'], `Probe: rect ${JSON.stringify(probe.r)} on a ${JSON.stringify(probe.p)} page should give ${JSON.stringify(want)}.`);
    normBound = (r, p) => shape(found.fn, r, p) as NormRect;
  }
  return normBound(r, page);
}

// ---------------------------------------------------------------------------------------------------------------
// NormRect -> CSS px

type CssCall = (f: Fn, n: NormRect, v: View) => unknown;
const total = (v: View) => ((v.rotation + v.viewRotation) % 360) as Rotation;
const CSS_SHAPES: { id: string; call: CssCall; carriesPageRotation: boolean }[] = [
  { id: '(norm, page, scale, viewRotation)', call: (f, n, v) => f(n, { width: v.width, height: v.height, rotation: v.rotation }, v.scale, v.viewRotation), carriesPageRotation: true },
  { id: '(norm, { ...page, scale, viewRotation })', call: (f, n, v) => f(n, { width: v.width, height: v.height, rotation: v.rotation, scale: v.scale, viewRotation: v.viewRotation }), carriesPageRotation: true },
  { id: '(norm, page, { scale, viewRotation })', call: (f, n, v) => f(n, { width: v.width, height: v.height, rotation: v.rotation }, { scale: v.scale, viewRotation: v.viewRotation }), carriesPageRotation: true },
  { id: '(norm, { page, scale, viewRotation })', call: (f, n, v) => f(n, { page: { width: v.width, height: v.height, rotation: v.rotation }, scale: v.scale, viewRotation: v.viewRotation }), carriesPageRotation: true },
  { id: '(norm, { width, height }, scale, rotation)', call: (f, n, v) => f(n, { width: v.width, height: v.height }, v.scale, total(v)), carriesPageRotation: false },
  { id: '(norm, { width, height }, rotation, scale)', call: (f, n, v) => f(n, { width: v.width, height: v.height }, total(v), v.scale), carriesPageRotation: false },
  { id: '(norm, { width, height, scale, rotation })', call: (f, n, v) => f(n, { width: v.width, height: v.height, scale: v.scale, rotation: total(v) }), carriesPageRotation: false },
  { id: '(norm, { width, height }, { scale, rotation })', call: (f, n, v) => f(n, { width: v.width, height: v.height }, { scale: v.scale, rotation: total(v) }), carriesPageRotation: false },
];

/** Where a point of the unrotated page lands on the page as shown, turned clockwise by `rotation`, in px: the hand-worked definition the probes and the tests use. */
export function turnedPoint(u: number, v: number, view: { width: number; height: number; scale: number }, rotation: Rotation): { x: number; y: number } {
  const W = view.width * view.scale;
  const H = view.height * view.scale;
  switch (rotation) {
    case 0:
      return { x: u * W, y: v * H };
    case 90:
      return { x: (1 - v) * H, y: u * W };
    case 180:
      return { x: (1 - u) * W, y: (1 - v) * H };
    case 270:
      return { x: v * H, y: (1 - u) * W };
  }
}

/** The CSS box a NormRect should have: the definition. */
export function expectedCss(n: NormRect, view: { width: number; height: number; scale: number }, rotation: Rotation): Box {
  const a = turnedPoint(n[0], n[1], view, rotation);
  const b = turnedPoint(n[2], n[3], view, rotation);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

let cssBound: ((n: NormRect, v: View) => Box) | null = null;
export function normToCss(n: NormRect, view: View): Box {
  if (!cssBound) {
    const names = ['normToCss', 'normRectToCss', 'toCssRect', 'normToPx', 'normToScreen', 'rectToCss', 'cssRect', 'normToCssRect'];
    const found = find(names);
    if (!found) throw new Unbound('NormRect -> CSS px function', names);
    const probeNorm: NormRect = [0.1, 0.2, 0.5, 0.6];
    const probes: View[] = [
      { width: 200, height: 100, rotation: 0, scale: 2, viewRotation: 0 },
      { width: 200, height: 100, rotation: 0, scale: 2, viewRotation: 90 },
      // a page with its own /Rotate: tells a call that takes the total turn from one that takes the two parts
      { width: 200, height: 100, rotation: 90, scale: 2, viewRotation: 0 },
      { width: 200, height: 100, rotation: 270, scale: 2, viewRotation: 180 },
    ];
    const works = (shape: (typeof CSS_SHAPES)[number]) =>
      probes.every((p) => {
        try {
          return sameBox(asBox(shape.call(found.fn, probeNorm, p)), expectedCss(probeNorm, p, total(p)));
        } catch {
          return false;
        }
      });
    const shape = CSS_SHAPES.find(works);
    if (!shape) {
      const seen = CSS_SHAPES.map((s) => {
        try {
          return `${s.id} -> ${JSON.stringify(s.call(found.fn, probeNorm, probes[1]))}`;
        } catch (e) {
          return `${s.id} threw ${(e as Error).message}`;
        }
      });
      throw new Unbound('call shape for ' + found.name, CSS_SHAPES.map((s) => s.id), `Probe: ${JSON.stringify(probeNorm)} on a 200x100 pt page at scale 2 turned 90 should be ${JSON.stringify(expectedCss(probeNorm, probes[1], 90))}. Got: ${seen.join(' | ')}`);
    }
    cssBound = (norm, view2) => {
      const box = asBox(shape.call(found.fn, norm, view2));
      if (!box) throw new Error(`${found.name} returned something that is not a rectangle`);
      return box;
    };
  }
  return cssBound(n, view);
}

// ---------------------------------------------------------------------------------------------------------------
// sortKey

export function sortKey(anchor: unknown): number | null {
  const f = find(['sortKey', 'markSortKey', 'sortKeyOf']);
  if (!f) throw new Unbound('sortKey', ['sortKey', 'markSortKey', 'sortKeyOf']);
  const out = f.fn(anchor);
  if (out === null || (typeof out === 'number' && Number.isFinite(out))) return out;
  throw new Error(`sortKey returned ${JSON.stringify(out)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Paths

/** A path's `d` read as geometry: absolute and relative M L H V Z only. A curve or arc is reported, not guessed at. */
export function pathBox(d: string): { box: Box; subpaths: number } {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let subpaths = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  const num = () => Number(tokens[i++]);
  const put = () => {
    xs.push(x);
    ys.push(y);
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M':
        x = rel ? x + num() : num();
        y = rel ? y + num() : num();
        startX = x;
        startY = y;
        subpaths++;
        put();
        cmd = rel ? 'l' : 'L'; // further pairs are implicit line-tos
        break;
      case 'L':
        x = rel ? x + num() : num();
        y = rel ? y + num() : num();
        put();
        break;
      case 'H':
        x = rel ? x + num() : num();
        put();
        break;
      case 'V':
        y = rel ? y + num() : num();
        put();
        break;
      case 'Z':
        x = startX;
        y = startY;
        break;
      default:
        throw new Error(`path command ${cmd} is not read by this test: ${d}`);
    }
  }
  if (!xs.length) throw new Error(`empty path: ${JSON.stringify(d)}`);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { box: { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 }, subpaths };
}

type PathsCall = (f: Fn, marks: PaintMark[], v: View) => unknown;
const PATH_SHAPES: { id: string; call: PathsCall }[] = [
  { id: '(marks, view)', call: (f, m, v) => f(m, v) },
  { id: '(marks, page, scale, viewRotation)', call: (f, m, v) => f(m, { width: v.width, height: v.height, rotation: v.rotation }, v.scale, v.viewRotation) },
  { id: '(marks, page, { scale, viewRotation })', call: (f, m, v) => f(m, { width: v.width, height: v.height, rotation: v.rotation }, { scale: v.scale, viewRotation: v.viewRotation }) },
  { id: '(marks, (norm) => css box)', call: (f, m, v) => f(m, (n: NormRect) => normToCss(n, v)) },
  // geometry.ts as written: shapes whose rects are CSS-px boxes, then options. The turn goes in the options.
  { id: '(shapes in css px, { rotation })', call: (f, m, v) => f(m.map((k) => ({ style: k.style, color: k.color, rects: k.rects.map((r) => normToCss(r, v)) })), { rotation: total(v) }) },
];

function readPaths(out: unknown): PaintedPath[] | null {
  const list = out instanceof Map ? [...out.values()] : Array.isArray(out) ? out : null;
  if (!list) return null;
  const paths: PaintedPath[] = [];
  for (const p of list as unknown[]) {
    if (!p || typeof p !== 'object') return null;
    const o = p as Record<string, unknown>;
    if (typeof o.d !== 'string') return null;
    const style = typeof o.style === 'string' ? o.style : typeof o.kind === 'string' ? o.kind : '';
    const color = typeof o.color === 'number' ? o.color : null;
    paths.push({ style, color, d: o.d });
  }
  return paths;
}

let pathsBound: ((marks: PaintMark[], v: View) => PaintedPath[]) | null = null;
export function markPaths(marks: PaintMark[], view: View): PaintedPath[] {
  if (!pathsBound) {
    const names = ['markPaths', 'buildMarkPaths', 'markPathData', 'pathsForMarks', 'buildPaths', 'svgPaths', 'markSvgPaths', 'paintMarks'];
    const found = find(names);
    if (!found) throw new Unbound('mark-path builder', names);
    const probeView: View = { width: 200, height: 100, rotation: 0, scale: 2, viewRotation: 0 };
    const probe: PaintMark[] = [{ id: 'p', style: 'highlight', color: 1, rects: [[0.1, 0.2, 0.5, 0.6]] }];
    const want = expectedCss([0.1, 0.2, 0.5, 0.6], probeView, 0);
    const shape = PATH_SHAPES.find((s) => {
      try {
        const paths = readPaths(s.call(found.fn, probe, probeView));
        return paths !== null && paths.length === 1 && sameBox(pathBox(paths[0].d).box, want);
      } catch {
        return false;
      }
    });
    if (!shape) throw new Unbound('call shape for ' + found.name, PATH_SHAPES.map((s) => s.id), `Probe: one highlight over [0.1,0.2,0.5,0.6] on a 200x100 pt page at scale 2 should give one path covering ${JSON.stringify(want)}.`);
    pathsBound = (m, v) => {
      const paths = readPaths(shape.call(found.fn, m, v));
      if (!paths) throw new Error(`${found.name} did not return a list of { d } paths`);
      return paths;
    };
  }
  return pathsBound(marks, view);
}

// ---------------------------------------------------------------------------------------------------------------
// Hit test

type HitCall = (f: Fn, m: PaintMark[], v: View, p: { x: number; y: number }) => unknown;
const HIT_SHAPES: { id: string; call: HitCall }[] = [
  { id: '(marks, view, point)', call: (f, m, v, p) => f(m, v, p) },
  { id: '(marks, point, view)', call: (f, m, v, p) => f(m, p, v) },
  { id: '(marks, page, scale, viewRotation, point)', call: (f, m, v, p) => f(m, { width: v.width, height: v.height, rotation: v.rotation }, v.scale, v.viewRotation, p) },
  { id: '(marks, point.x, point.y, view)', call: (f, m, v, p) => f(m, p.x, p.y, v) },
  // geometry.ts as written: items whose rects are CSS-px boxes, then the point. Ids come back last drawn first.
  { id: '(items in css px, point)', call: (f, m, v, p) => f(m.map((k) => ({ id: k.id, rects: k.rects.map((r) => normToCss(r, v)) })), p) },
];

function readHit(out: unknown): string | null | undefined {
  if (out === null || out === undefined) return null;
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return out.length ? readHit(out[0]) : null; // the code lists the last drawn first
  if (typeof out === 'object' && typeof (out as { id?: unknown }).id === 'string') return (out as { id: string }).id;
  return undefined;
}

let hitBound: ((m: PaintMark[], v: View, p: { x: number; y: number }) => string | null) | null = null;
/** The id of the mark under a point in CSS px (the topmost when several are, which is the first the code lists), or null. */
export function hitTest(marks: PaintMark[], view: View, point: { x: number; y: number }): string | null {
  if (!hitBound) {
    const names = ['hitTest', 'hitTestMarks', 'markAt', 'markAtPoint', 'hitMark', 'pickMark'];
    const found = find(names);
    if (!found) throw new Unbound('hit test', names);
    const probeView: View = { width: 200, height: 100, rotation: 0, scale: 2, viewRotation: 0 };
    const probe: PaintMark[] = [{ id: 'probe', style: 'highlight', color: 1, rects: [[0.1, 0.2, 0.5, 0.6]] }]; // CSS box 40,40 to 200,120
    const shape = HIT_SHAPES.find((s) => {
      try {
        return readHit(s.call(found.fn, probe, probeView, { x: 100, y: 80 })) === 'probe' && readHit(s.call(found.fn, probe, probeView, { x: 10, y: 10 })) === null;
      } catch {
        return false;
      }
    });
    if (!shape) throw new Unbound('call shape for ' + found.name, HIT_SHAPES.map((s) => s.id), 'Probe: the point (100, 80) is inside a mark over [0.1,0.2,0.5,0.6] on a 200x100 pt page at scale 2; (10, 10) is outside.');
    hitBound = (m, v, p) => readHit(shape.call(found.fn, m, v, p)) ?? null;
  }
  return hitBound(marks, view, point);
}
