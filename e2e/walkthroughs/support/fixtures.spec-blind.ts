// Fixtures for the walkthrough user tests (gate 1). They are made here, with pdf-lib, so that these tests need
// nothing from the implementation's own fixture scripts. Everything is written to test-assets/walkthroughs/
// (gitignored; the fixture server serves it at /f/walkthroughs/<name>).
//
//  - book-400: 400 Letter pages. Every page carries three "strips" of 11 squares that encode its page number
//    (see BAR), so a test can tell from pixels alone which page is on screen, and whether a page is blank.
//  - mixed: five pages of different shapes, one with /Rotate 90 (the rotated-page walkthrough).
//  - password: the repo's AES-256 test PDF (user password "secret").
//  - corrupt: a valid PDF header followed by junk. empty: zero bytes.
import { copyFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const WALKTHROUGH_DIR = join(REPO_ROOT, 'test-assets', 'walkthroughs');
/** The path the fixture server serves a file of WALKTHROUGH_DIR at. */
export const served = (name: string): string => `/f/walkthroughs/${name}`;

/**
 * The page-number strips on every page of book-400, in points from the top-left of the (Letter, unrotated) page.
 * A strip is `squares` squares of `size` pt side by side from x0. Square 0 and the last square are always black
 * (markers). Squares 1..9 are the 9 bits of the page number, most significant first (black = 1). A strip sits on a
 * white box so that it reads the same over the page's background picture.
 */
export const BAR = { pageWidth: 612, pageHeight: 792, x0: 40, size: 28, squares: 11, tops: [24, 380, 740] } as const;

/** The 9 bits of `n` (1..511) as the strip squares 1..9 show them. */
export const barBits = (n: number): boolean[] => Array.from({ length: 9 }, (_, i) => ((n >> (8 - i)) & 1) === 1);

async function writeOnce(name: string, build: () => Promise<Uint8Array>): Promise<string> {
  const path = join(WALKTHROUGH_DIR, name);
  const have = await stat(path).catch(() => null);
  if (have?.isFile()) return path; // names carry a version: a changed generator gets a new name
  await mkdir(WALKTHROUGH_DIR, { recursive: true });
  const bytes = await build();
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path); // never serve half a file
  return path;
}

/** A deterministic grey "paper texture" JPEG, so that every page costs the engine a real image decode. */
function textureJpeg(width: number, height: number): Uint8Array {
  const data = Buffer.alloc(width * height * 4);
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 4 * (y * width + x);
      const v = 150 + 60 * Math.sin(x / 37) * Math.cos(y / 53) + 30 * rand();
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v - 8;
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width, height }, 70).data;
}

/** The 400-page book. Page n: a faint texture, three number strips, "Page n" and 30 lines of text. */
async function buildBook(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle('Walkthrough book');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const texture = await doc.embedJpg(textureJpeg(900, 1160));
  const { pageWidth, pageHeight, x0, size, squares, tops } = BAR;
  for (let n = 1; n <= pages; n++) {
    const page = doc.addPage([pageWidth, pageHeight]);
    page.drawImage(texture, { x: 0, y: 0, width: pageWidth, height: pageHeight, opacity: 0.18 });
    const bits = barBits(n);
    for (const top of tops) {
      page.drawRectangle({ x: x0 - 4, y: pageHeight - top - size - 4, width: squares * size + 8, height: size + 8, color: rgb(1, 1, 1) });
      for (let i = 0; i < squares; i++) {
        const black = i === 0 || i === squares - 1 || bits[i - 1] === true;
        if (black) page.drawRectangle({ x: x0 + i * size, y: pageHeight - top - size, width: size, height: size, color: rgb(0, 0, 0) });
      }
    }
    page.drawText(`Page ${n}`, { x: 40, y: pageHeight - 120, size: 40, font: bold, color: rgb(0.1, 0.1, 0.1) });
    for (let k = 0; k < 30; k++) {
      const top = 170 + k * 17;
      if (top > 360 && top < 420) continue; // the middle strip sits there
      page.drawText(`Page ${n}, line ${k + 1}: the quick brown fox jumps over the lazy dog, again and again.`, {
        x: 40,
        y: pageHeight - top,
        size: 11,
        font: regular,
        color: rgb(0.05, 0.05, 0.05),
      });
    }
  }
  return doc.save({ useObjectStreams: true });
}

/**
 * Five pages (the shapes of a real reading list), each reading "Page N" in 48 pt Helvetica at the TOP-LEFT as the page
 * is displayed. Page 3 is a Letter page with /Rotate 90: its label is drawn rotated 90 degrees near the unrotated
 * bottom-left, which /Rotate 90 displays upright at the top-left.
 */
export const MIXED_PAGES = [
  { n: 1, name: 'Letter portrait', width: 612, height: 792, rotate: 0 },
  { n: 2, name: 'A4 landscape', width: 842, height: 595, rotate: 0 },
  { n: 3, name: 'Letter, /Rotate 90', width: 612, height: 792, rotate: 90 },
  { n: 4, name: 'Slide 16:9', width: 960, height: 540, rotate: 0 },
  { n: 5, name: 'A5 portrait', width: 420, height: 595, rotate: 0 },
] as const;

async function buildMixed(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of MIXED_PAGES) {
    const page = doc.addPage([spec.width, spec.height]);
    if (spec.rotate === 90) {
      page.setRotation(degrees(90));
      page.drawText(`Page ${spec.n}`, { x: 60, y: 24, size: 48, font, rotate: degrees(90) });
    } else {
      page.drawText(`Page ${spec.n}`, { x: 24, y: spec.height - 60, size: 48, font });
    }
    if (spec.rotate === 0) page.drawText(`${spec.name}, ${spec.width} x ${spec.height} pt`, { x: 24, y: 24, size: 12, font });
  }
  return doc.save();
}

/** A valid header and then junk: it passes the "is it a PDF" glance and fails in the engine. */
function corruptBytes(): Uint8Array {
  const head = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R\n', 'latin1');
  let seed = 99;
  const junk = Buffer.alloc(4000);
  for (let i = 0; i < junk.length; i++) junk[i] = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16;
  return Buffer.concat([head, junk]);
}

export const BOOK_PAGES = 400;
export const FIXTURES = {
  book: 'wt-book-400.v1.pdf',
  mixed: 'wt-mixed.v1.pdf',
  password: 'wt-password.v1.pdf',
  corrupt: 'wt-corrupt.v1.pdf',
  empty: 'wt-empty.v1.pdf',
} as const;
export const PASSWORD = { right: 'secret', wrong: 'not-the-password', page1Text: 'Secret page 1' } as const;

export async function ensureBook(): Promise<string> {
  return writeOnce(FIXTURES.book, () => buildBook(BOOK_PAGES));
}
export async function ensureMixed(): Promise<string> {
  return writeOnce(FIXTURES.mixed, buildMixed);
}
export async function ensurePassword(): Promise<string> {
  // The AES-256 file the engine tests use (user password "secret"); copied so the fixture server can serve it.
  const path = join(WALKTHROUGH_DIR, FIXTURES.password);
  if ((await stat(path).catch(() => null))?.isFile()) return path;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await copyFile(join(REPO_ROOT, 'packages/viewer/test/fixtures/password-secret.pdf'), tmp);
  await rename(tmp, path);
  return path;
}
export async function ensureCorrupt(): Promise<string> {
  return writeOnce(FIXTURES.corrupt, () => Promise.resolve(corruptBytes()));
}
export async function ensureEmpty(): Promise<string> {
  return writeOnce(FIXTURES.empty, () => Promise.resolve(new Uint8Array(0)));
}

/** The real files the walkthroughs open (made by `pnpm fixtures`). */
export const REAL = {
  paper50: { url: '/f/paper-50.pdf', file: join(REPO_ROOT, 'test-assets', 'paper-50.pdf'), pages: 50 },
  book404: { url: '/f/classifier/learning/textbook-axler-LADR4e.pdf', file: join(REPO_ROOT, 'test-assets/classifier/learning/textbook-axler-LADR4e.pdf'), pages: 404 },
  starbucks: { url: '/f/classifier/not-learning/receipt-starbucks-scan.pdf', file: join(REPO_ROOT, 'test-assets/classifier/not-learning/receipt-starbucks-scan.pdf'), pages: 1 },
  wholefoods: { url: '/f/classifier/not-learning/receipt-wholefoods-scan.pdf', file: join(REPO_ROOT, 'test-assets/classifier/not-learning/receipt-wholefoods-scan.pdf'), pages: 1 },
} as const;
