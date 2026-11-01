// Spec-blind helpers for Task 22 (selection painting, R44). Pure Node code: it reads a screenshot and judges how a
// selection was painted. It knows nothing about the viewer's DOM, so it works for an SVG path, a canvas or divs.
//
// What R44 says, as checks on pixels:
//  - one colour (the --text-selection token) and a single blend, so overlaps never darken;
//  - every line band has the same height (within 1 px) when the lines have the same font size;
//  - adjacent bands never overlap;
//  - the band covers the ink of the selected glyphs, and its edges follow the text.
import { inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------------------------
// PNG

export interface Img {
  width: number;
  height: number;
  /** RGBA, 8 bits a channel. */
  data: Uint8Array;
}

/** Decodes the 8-bit, non-interlaced PNGs Chromium writes (colour types 0, 2, 4 and 6). */
export function decodePng(buf: Uint8Array): Img {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  const idat: Uint8Array[] = [];
  while (pos < buf.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      depth = body[8]!;
      colourType = body[9]!;
      if (body[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} not supported`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  if (channels === undefined) throw new Error(`PNG colour type ${colourType} not supported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[dst + x - channels] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? out[dst - stride + x - channels] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[dst + x] = v & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 1 || channels === 2) {
      data[d] = data[d + 1] = data[d + 2] = out[s]!;
      data[d + 3] = channels === 2 ? out[s + 1] : 255;
    } else {
      data[d] = out[s]!;
      data[d + 1] = out[s + 1]!;
      data[d + 2] = out[s + 2]!;
      data[d + 3] = channels === 4 ? out[s + 3] : 255;
    }
  }
  return { width, height, data };
}

// ---------------------------------------------------------------------------------------------------------------
// Colours

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0 to 1. */
  a: number;
}

/** `rgba(11,87,208,.3)`, `rgb(11 87 208 / 30%)` or `#0b57d04d`. null when it is not one of those. */
export function parseCssColor(s: string): Rgba | null {
  const text = s.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(text);
  if (!fn) return null;
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const chan = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  const [r, g, b] = [chan(parts[0]), chan(parts[1]), chan(parts[2])];
  if ([r, g, b, alpha].some((n) => Number.isNaN(n))) return null;
  return { r, g, b, a: alpha };
}

/** `c` painted once over white. */
export function overWhite(c: Rgba): [number, number, number] {
  return [255 * (1 - c.a) + c.r * c.a, 255 * (1 - c.a) + c.g * c.a, 255 * (1 - c.a) + c.b * c.a];
}

// ---------------------------------------------------------------------------------------------------------------
// The analysis

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PaintGlyph {
  /** The glyph's ink box and its loose box, client px. */
  tight: Box;
  loose: Box;
  /** Points. */
  fontSize: number;
}

export interface PaintOptions {
  /** 'h': lines run along x on the screen. 'v': they run along y (a page turned by 90 or 270). */
  orientation: 'h' | 'v';
  dpr: number;
  /** CSS px per point at this zoom. */
  pxPerPt: number;
  /** The engine's merged line rectangles for the selection (getTextRangeRects), client px. */
  lines: Box[];
  /** The selected, visible glyphs, client px. */
  glyphs: PaintGlyph[];
  /** The colour the selection must be painted in (the --text-selection token). */
  colour: Rgba;
}

export interface LineMeasure {
  /** Index into PaintOptions.lines. */
  line: number;
  /** Band edges across the line (CSS px along the page's y for 'h'), and the band's thickness. */
  top: number;
  bottom: number;
  thickness: number;
  /** Band extent along the line. */
  left: number;
  right: number;
  fontSize: number;
}

export interface PaintReport {
  problems: string[];
  lines: LineMeasure[];
  /** Pixels painted twice (an overlap that darkened). */
  doubleBlendPixels: number;
  /** The most common non-white colour inside the bands. */
  dominant: [number, number, number] | null;
}

interface Frame {
  a0: number;
  a1: number;
  c0: number;
  c1: number;
}

const sq = (n: number) => n * n;

export function analyzeSelectionPaint(img: Img, o: PaintOptions): PaintReport {
  const problems: string[] = [];
  const { dpr } = o;
  const frame = (b: Box): Frame => (o.orientation === 'h' ? { a0: b.left, a1: b.right, c0: b.top, c1: b.bottom } : { a0: b.top, a1: b.bottom, c0: b.left, c1: b.right });
  const pixel = (a: number, c: number): [number, number, number] | null => {
    const x = o.orientation === 'h' ? a : c;
    const y = o.orientation === 'h' ? c : a;
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
    const i = 4 * (y * img.width + x);
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };

  const C = o.colour;
  const vr = 255 - C.r;
  const vg = 255 - C.g;
  const vb = 255 - C.b;
  const vv = sq(vr) + sq(vg) + sq(vb);
  const single = overWhite(C);
  /** How much of the single-blend colour this pixel shows (1 = fully painted once, ~1.7 = painted twice), or null when the pixel is not on the white-to-colour line. */
  const fill = (p: [number, number, number]): number | null => {
    const dr = 255 - p[0];
    const dg = 255 - p[1];
    const db = 255 - p[2];
    const t = (dr * vr + dg * vg + db * vb) / vv;
    const residual = Math.hypot(dr - t * vr, dg - t * vg, db - t * vb);
    if (t < -0.02 || residual > 6) return null;
    return Math.max(0, t) / C.a;
  };

  // Lines in the order they run across the page.
  const order = o.lines.map((_, i) => i).sort((p, q) => (frame(o.lines[p]).c0 + frame(o.lines[p]).c1) - (frame(o.lines[q]).c0 + frame(o.lines[q]).c1));
  const centre = (i: number) => (frame(o.lines[i]).c0 + frame(o.lines[i]).c1) / 2;

  // Glyphs to lines: the line whose rectangle holds the glyph's centre (across, then along).
  const glyphLine = new Map<number, number[]>();
  o.glyphs.forEach((g, gi) => {
    const f = frame(g.loose);
    const ca = (f.a0 + f.a1) / 2;
    const cc = (f.c0 + f.c1) / 2;
    let best = -1;
    let bestD = Infinity;
    o.lines.forEach((l, li) => {
      const lf = frame(l);
      const inside = ca >= lf.a0 - 2 && ca <= lf.a1 + 2;
      const d = Math.abs(cc - (lf.c0 + lf.c1) / 2) + (inside ? 0 : 1000);
      if (d < bestD) {
        bestD = d;
        best = li;
      }
    });
    if (best >= 0) glyphLine.set(best, [...(glyphLine.get(best) ?? []), gi]);
  });

  const measures: LineMeasure[] = [];
  let doubleBlend = 0;
  const colourCount = new Map<number, number>();

  order.forEach((li, rank) => {
    const lf = frame(o.lines[li]);
    const c = (lf.c0 + lf.c1) / 2;
    const prev = rank > 0 ? centre(order[rank - 1]) : null;
    const next = rank < order.length - 1 ? centre(order[rank + 1]) : null;
    const pitchUp = prev === null ? (next === null ? (lf.c1 - lf.c0) * 1.4 : next - c) : c - prev;
    const pitchDown = next === null ? pitchUp : next - c;
    const low = c - pitchUp / 2;
    const high = c + pitchDown / 2;
    const r0 = Math.floor(low * dpr);
    const r1 = Math.ceil(high * dpr);
    const aLo = Math.floor((lf.a0 - 6) * dpr);
    const aHi = Math.ceil((lf.a1 + 6) * dpr);

    // Per row: the most the row is painted, and the extent of the painted pixels.
    const cov: number[] = [];
    let minA = Infinity;
    let maxA = -Infinity;
    const rowMinA: number[] = [];
    const rowMaxA: number[] = [];
    for (let r = r0; r < r1; r++) {
      // The part of this row inside the window (the first and last rows are cut at the window's edge, half way to the neighbouring line).
      const inside = Math.max(0, Math.min(r + 1, high * dpr) - Math.max(r, low * dpr));
      let best = 0;
      let rmin = Infinity;
      let rmax = -Infinity;
      for (let a = aLo; a < aHi; a++) {
        const p = pixel(a, r);
        if (!p) continue;
        const f = fill(p);
        if (f === null) continue;
        if (f > best) best = f;
        if (f >= 0.5) {
          if (a < rmin) rmin = a;
          if (a > rmax) rmax = a;
        }
      }
      cov.push(Math.min(best, 1, inside));
      rowMinA.push(rmin);
      rowMaxA.push(rmax);
    }
    // The band around the line's centre row.
    const centreRow = Math.min(cov.length - 1, Math.max(0, Math.round(c * dpr) - r0));
    let seed = -1;
    for (let d = 0; d <= 3 && seed < 0; d++) {
      if ((cov[centreRow + d] ?? 0) >= 0.5) seed = centreRow + d;
      else if ((cov[centreRow - d] ?? 0) >= 0.5) seed = centreRow - d;
    }
    if (seed < 0) {
      // Say what is there instead: the most common non-white colour in the line's rectangle.
      const census = new Map<number, number>();
      for (let r = Math.floor(lf.c0 * dpr); r < Math.ceil(lf.c1 * dpr); r++) {
        for (let a = Math.floor(lf.a0 * dpr); a < Math.ceil(lf.a1 * dpr); a++) {
          const p = pixel(a, r);
          if (!p || (p[0] >= 250 && p[1] >= 250 && p[2] >= 250) || (p[0] < 90 && p[1] < 90 && p[2] < 90)) continue;
          const key = (p[0] << 16) | (p[1] << 8) | p[2];
          census.set(key, (census.get(key) ?? 0) + 1);
        }
      }
      const [top] = [...census].sort((p, q) => q[1] - p[1]);
      const area = Math.max(1, (lf.a1 - lf.a0) * (lf.c1 - lf.c0) * dpr * dpr);
      const there = top && top[1] / area > 0.2 ? `, but the highlight colour is rgb(${(top[0] >> 16) & 255},${(top[0] >> 8) & 255},${top[0] & 255}), not the token's rgb(${single.map((n) => Math.round(n)).join(',')})` : '';
      problems.push(`line ${rank + 1} of ${order.length}: no pixel of the selection colour is painted on it${there}`);
      return;
    }
    let top = seed;
    while (top > 0 && cov[top - 1] > 0.04) top--;
    let bottom = seed;
    while (bottom < cov.length - 1 && cov[bottom + 1] > 0.04) bottom++;
    const topEdge = (r0 + top + (cov[top] >= 0.98 ? 0 : 1 - cov[top])) / dpr;
    const bottomEdge = (r0 + bottom + (cov[bottom] >= 0.98 ? 1 : cov[bottom])) / dpr;
    for (let r = top + 1; r < bottom; r++) {
      if (cov[r] < 0.9) problems.push(`line ${rank + 1}: the band has a hole in it (row ${r0 + r} is ${(cov[r] * 100).toFixed(0)}% painted)`);
    }
    // The extent along the line, from rows well inside the band (the edge rows may hold a neighbour's anti-aliasing).
    for (let r = top + 1; r <= bottom - 1; r++) {
      if ((rowMinA[r] ?? Infinity) < minA && cov[r] >= 0.9) minA = rowMinA[r]!;
      if ((rowMaxA[r] ?? -Infinity) > maxA && cov[r] >= 0.9) maxA = rowMaxA[r]!;
    }
    if (!Number.isFinite(minA) || !Number.isFinite(maxA)) {
      problems.push(`line ${rank + 1}: the painted band is too thin to measure (${bottom - top + 1} px)`);
      return;
    }
    const gs = (glyphLine.get(li) ?? []).map((gi) => o.glyphs[gi]);
    const sizes = gs.map((g) => g.fontSize).sort((p, q) => p - q);
    const fontSize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
    measures.push({ line: li, top: topEdge, bottom: bottomEdge, thickness: bottomEdge - topEdge, left: minA / dpr, right: (maxA + 1) / dpr, fontSize });

    // Colour census and double-paint scan inside the band.
    for (let r = r0 + top; r <= r0 + bottom; r++) {
      for (let a = Math.max(aLo, Math.floor(minA)); a <= Math.min(aHi, Math.ceil(maxA)); a++) {
        const p = pixel(a, r);
        if (!p) continue;
        const f = fill(p);
        if (f !== null && f > 1.35) doubleBlend++;
        if (p[0] >= 250 && p[1] >= 250 && p[2] >= 250) continue;
        const key = (p[0] << 16) | (p[1] << 8) | p[2];
        colourCount.set(key, (colourCount.get(key) ?? 0) + 1);
      }
    }

    // No white gap inside the line, on the rows through its middle.
    const midRows = [Math.round(c * dpr) - 1, Math.round(c * dpr), Math.round(c * dpr) + 1];
    const gapLeft = Math.ceil(minA + 2 * dpr);
    const gapRight = Math.floor(maxA - 2 * dpr);
    let gaps = 0;
    let gapAt = -1;
    for (const r of midRows) {
      for (let a = gapLeft; a <= gapRight; a++) {
        const p = pixel(a, r);
        if (p && p[0] >= 250 && p[1] >= 250 && p[2] >= 250) {
          gaps++;
          if (gapAt < 0) gapAt = a;
        }
      }
    }
    if (gaps > 0) problems.push(`line ${rank + 1}: ${gaps} unpainted pixels inside the line (first at ${gapAt / dpr} along it): the highlight is ragged`);

    // Edges follow the text: against the engine's line rectangle.
    const tol = 1 + 0.75 * o.pxPerPt;
    if (Math.abs(minA / dpr - lf.a0) > tol) problems.push(`line ${rank + 1}: the highlight starts ${(minA / dpr - lf.a0).toFixed(1)} px from where the text starts (limit ${tol.toFixed(1)})`);
    if (Math.abs((maxA + 1) / dpr - lf.a1) > tol) problems.push(`line ${rank + 1}: the highlight ends ${((maxA + 1) / dpr - lf.a1).toFixed(1)} px from where the text ends (limit ${tol.toFixed(1)})`);

    // It covers the ink of the glyphs (supers and subscripts excluded).
    const main = gs.filter((g) => g.fontSize >= 0.8 * fontSize);
    if (main.length > 0) {
      const inks = main.map((g) => frame(g.tight));
      const inkTop = Math.min(...inks.map((f) => f.c0));
      const inkBottom = Math.max(...inks.map((f) => f.c1));
      if (topEdge > inkTop + 1) problems.push(`line ${rank + 1}: the highlight starts ${(topEdge - inkTop).toFixed(1)} px below the top of the letters`);
      if (bottomEdge < inkBottom - 1) problems.push(`line ${rank + 1}: the highlight stops ${(inkBottom - bottomEdge).toFixed(1)} px above the bottom of the letters`);
    }
  });

  // Same font size, same height.
  const bySize = new Map<number, LineMeasure[]>();
  for (const m of measures) {
    if (m.fontSize <= 0) continue;
    const key = Math.round(m.fontSize * 2) / 2;
    bySize.set(key, [...(bySize.get(key) ?? []), m]);
  }
  for (const [size, group] of bySize) {
    if (group.length < 2) continue;
    const ts = group.map((m) => m.thickness);
    const spread = Math.max(...ts) - Math.min(...ts);
    if (spread > 1.0) problems.push(`lines in ${size} pt text have uneven heights: ${Math.min(...ts).toFixed(1)} to ${Math.max(...ts).toFixed(1)} px (limit 1 px apart)`);
  }
  // A band tall enough for its text, and no taller than a sane line.
  for (const m of measures) {
    if (m.fontSize <= 0) continue;
    const em = m.fontSize * o.pxPerPt;
    if (m.thickness < 0.7 * em) problems.push(`a ${m.fontSize} pt line is painted only ${m.thickness.toFixed(1)} px thick (less than the text itself, ${em.toFixed(1)} px)`);
    if (m.thickness > 1.8 * em) problems.push(`a ${m.fontSize} pt line is painted ${m.thickness.toFixed(1)} px thick (far more than the text, ${em.toFixed(1)} px)`);
  }
  // Neighbouring bands do not overlap.
  const sorted = [...measures].sort((p, q) => p.top - q.top);
  for (let i = 1; i < sorted.length; i++) {
    const overlap = sorted[i - 1].bottom - sorted[i].top;
    if (overlap > 0.75) problems.push(`two neighbouring lines overlap by ${overlap.toFixed(1)} px`);
  }
  if (doubleBlend > 3) problems.push(`${doubleBlend} pixels are painted twice (darker bands where highlights overlap)`);

  let dominant: [number, number, number] | null = null;
  let most = 0;
  for (const [key, n] of colourCount) {
    if (n > most) {
      most = n;
      dominant = [(key >> 16) & 255, (key >> 8) & 255, key & 255];
    }
  }
  if (dominant && Math.max(Math.abs(dominant[0] - single[0]), Math.abs(dominant[1] - single[1]), Math.abs(dominant[2] - single[2])) > 4) {
    problems.push(`the highlight colour is rgb(${dominant.join(',')}), not the token's rgb(${single.map((n) => Math.round(n)).join(',')})`);
  }
  return { problems, lines: measures, doubleBlendPixels: doubleBlend, dominant };
}
