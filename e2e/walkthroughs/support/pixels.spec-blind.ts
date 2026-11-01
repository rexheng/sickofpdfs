// What the owner sees, as numbers: a small PNG decoder for Playwright screenshots, plus the measurements the
// walkthroughs make on them (ink boxes, the page-number strips of book-400, edge sharpness). It reads the screen, not
// the viewer's DOM, so it cannot be fooled by a canvas that is not what is shown.
import { inflateSync } from 'node:zlib';
import { BAR, barBits } from './fixtures.spec-blind';

export interface Rgba {
  width: number;
  height: number;
  /** RGBA, 8 bits a channel, row by row. */
  data: Uint8Array;
}

/** A rectangle in CSS px of the page. */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Decodes an 8-bit, non-interlaced greyscale/RGB/RGBA PNG (what Chromium writes). */
export function decodePng(png: Uint8Array): Rgba {
  const buf = Buffer.from(png);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      colorType = body[9] ?? 0;
      if (depth !== 8 || body[12] !== 0) throw new Error(`unsupported PNG (depth ${depth}, interlace ${body[12]})`);
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (channels === undefined) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (line[i - channels] ?? 0) : 0;
      const b = prev[i] ?? 0;
      const c = i >= channels ? (prev[i - channels] ?? 0) : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = ((line[i] ?? 0) + add) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (channels === 1 || channels === 2) {
        out[o] = out[o + 1] = out[o + 2] = line[s] ?? 0;
        out[o + 3] = channels === 2 ? (line[s + 1] ?? 255) : 255;
      } else {
        out[o] = line[s] ?? 0;
        out[o + 1] = line[s + 1] ?? 0;
        out[o + 2] = line[s + 2] ?? 0;
        out[o + 3] = channels === 4 ? (line[s + 3] ?? 255) : 255;
      }
    }
    prev = line;
  }
  return { width, height, data: out };
}

export const lumaAt = (img: Rgba, x: number, y: number): number => {
  const o = (Math.min(img.height - 1, Math.max(0, y)) * img.width + Math.min(img.width - 1, Math.max(0, x))) * 4;
  return 0.299 * (img.data[o] ?? 0) + 0.587 * (img.data[o + 1] ?? 0) + 0.114 * (img.data[o + 2] ?? 0);
};

/** Device pixels per CSS pixel of a screenshot of a page `cssWidth` wide. */
export const pixelRatio = (img: Rgba, cssWidth: number): number => img.width / cssWidth;

function toDevice(img: Rgba, ratio: number, r: CssRect): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: Math.max(0, Math.round(r.x * ratio)),
    y0: Math.max(0, Math.round(r.y * ratio)),
    x1: Math.min(img.width, Math.round((r.x + r.width) * ratio)),
    y1: Math.min(img.height, Math.round((r.y + r.height) * ratio)),
  };
}

export interface InkBox {
  /** The box of pixels darker than the threshold, as fractions (0..1) of the rectangle searched. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Dark pixels as a share of all pixels in the rectangle. */
  share: number;
  /** Width / height of the box in pixels. */
  aspect: number;
}

/** The bounding box of the dark pixels (luminance below `threshold`) in `rect`, or null when there are none. */
export function inkBox(img: Rgba, ratio: number, rect: CssRect, threshold = 128): InkBox | null {
  const { x0, y0, x1, y1 } = toDevice(img, ratio, rect);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let dark = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (lumaAt(img, x, y) >= threshold) continue;
      dark++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (dark === 0) return null;
  const w = x1 - x0;
  const h = y1 - y0;
  return { left: (minX - x0) / w, top: (minY - y0) / h, right: (maxX + 1 - x0) / w, bottom: (maxY + 1 - y0) / h, share: dark / (w * h), aspect: (maxX + 1 - minX) / (maxY + 1 - minY) };
}

export interface Stats {
  /** Share of pixels that are not near-white (luminance < 240). */
  nonWhite: number;
  /** Share of pixels that are dark (luminance < 100). */
  dark: number;
  /** Share of pixels with visible colour (max channel − min channel > 24). */
  coloured: number;
}

export function regionStats(img: Rgba, ratio: number, rect: CssRect): Stats {
  const { x0, y0, x1, y1 } = toDevice(img, ratio, rect);
  let n = 0;
  let nonWhite = 0;
  let dark = 0;
  let coloured = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * img.width + x) * 4;
      const r = img.data[o] ?? 0;
      const g = img.data[o + 1] ?? 0;
      const b = img.data[o + 2] ?? 0;
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      n++;
      if (l < 240) nonWhite++;
      if (l < 100) dark++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 24) coloured++;
    }
  }
  return n === 0 ? { nonWhite: 0, dark: 0, coloured: 0 } : { nonWhite: nonWhite / n, dark: dark / n, coloured: coloured / n };
}

/**
 * Reads the page number off strip `stripIndex` of a book-400 page shown in `canvas` (where the page's pixels are, in
 * CSS px; the page is Letter and unrotated). Returns null when any square is outside `visible`, or does not read
 * clearly black or white, or the two marker squares are not black: that is, when the strip is not there to read.
 */
export function readStrip(img: Rgba, ratio: number, canvas: CssRect, visible: CssRect, stripIndex: number): number | null {
  const top = BAR.tops[stripIndex];
  if (top === undefined) throw new Error(`no strip ${stripIndex}`);
  const bits: boolean[] = [];
  for (let i = 0; i < BAR.squares; i++) {
    const cx = canvas.x + ((BAR.x0 + i * BAR.size + BAR.size / 2) / BAR.pageWidth) * canvas.width;
    const cy = canvas.y + ((top + BAR.size / 2) / BAR.pageHeight) * canvas.height;
    if (cx < visible.x + 1 || cx > visible.x + visible.width - 1 || cy < visible.y + 1 || cy > visible.y + visible.height - 1) return null;
    const px = Math.round(cx * ratio);
    const py = Math.round(cy * ratio);
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += lumaAt(img, px + dx, py + dy);
    const l = sum / 9;
    if (l > 70 && l < 190) return null;
    bits.push(l <= 70);
  }
  if (!bits[0] || !bits[BAR.squares - 1]) return null;
  return bits.slice(1, 10).reduce((n, b) => n * 2 + (b ? 1 : 0), 0);
}

/** The page numbers that can be read from the screen: every strip of every canvas in `canvases`. */
export function readAllStrips(img: Rgba, ratio: number, canvases: CssRect[], visible: CssRect): number[] {
  const seen = new Set<number>();
  for (const c of canvases) {
    for (let s = 0; s < BAR.tops.length; s++) {
      const n = readStrip(img, ratio, c, visible, s);
      if (n !== null) seen.add(n);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * How many device pixels wide the left edge of the first marker square of strip `stripIndex` is: the number of pixels
 * on the way from white to black that are neither. A page drawn at the size it is shown at has an edge of 0 to 2
 * pixels (anti-aliasing); a small picture stretched up has an edge many pixels wide. Null when the edge is off screen.
 */
export function edgeWidth(img: Rgba, ratio: number, canvas: CssRect, visible: CssRect, stripIndex: number): number | null {
  const top = BAR.tops[stripIndex];
  if (top === undefined) throw new Error(`no strip ${stripIndex}`);
  const ex = canvas.x + (BAR.x0 / BAR.pageWidth) * canvas.width;
  const cy = canvas.y + ((top + BAR.size / 2) / BAR.pageHeight) * canvas.height;
  const reach = 12; // CSS px either side of the edge
  if (ex - reach < visible.x || ex + reach > visible.x + visible.width || cy < visible.y || cy > visible.y + visible.height) return null;
  const py = Math.round(cy * ratio);
  const from = Math.round((ex - reach) * ratio);
  const to = Math.round((ex + reach) * ratio);
  let grey = 0;
  for (let x = from; x <= to; x++) {
    const l = lumaAt(img, x, py);
    if (l > 40 && l < 215) grey++;
  }
  return grey;
}

export { barBits };
