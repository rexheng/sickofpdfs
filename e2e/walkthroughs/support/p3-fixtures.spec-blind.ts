// Fixtures for the Phase 3 walkthroughs (library, learning filter, backup and restore). They are made here, with pdf-lib, so the
// tests need nothing from the implementation. Everything is written to test-assets/walkthroughs/ (gitignored; the fixture server
// serves it at /f/walkthroughs/<name>), and the names carry a version: a changed generator gets a new name.
//
// What the spec says each one must be (spec "Learning filter and privacy": the score starts at -1; 3 or more saves; 0 or less
// does not; anything between is "not sure"; a card number blocks on its own and beats the allow list):
//  - NOT_SURE_*: three different 10-page plain-prose booklets, each with one "Chapter" heading. Weights from the spec's table:
//    -1 (start) +1 (8 or more pages) +1.5 (Chapter) = 1.5, so "not sure". The prose avoids every other signal: no references,
//    DOI, abstract, academic words, money, or admin words, and the file names carry no course words ("notes" counts as one). Three, because the tests
//    need PDFs that are not the same document (the same letters would make a re-download of the first, spec rule 2).
//  - CARD: a one-page statement with a valid card number (4111 1111 1111 1111: 16 digits, Luhn-valid, a Visa prefix). The
//    spec's hard block: "a card number ... blocks on its own".
//  - PRIVATE_DOI: a one-page invoice that quotes a DOI. It is not learning (invoice words, amounts), and it is the PDF that
//    must cause no lookup, because the lookups run "only for saved PDFs".
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { WALKTHROUGH_DIR } from './fixtures.spec-blind';

export const P3_FILES = {
  notSureA: 'p3-booklet-a.v1.pdf',
  notSureB: 'p3-booklet-b.v1.pdf',
  notSureC: 'p3-booklet-c.v1.pdf',
  card: 'p3-card.v1.pdf',
  privateDoi: 'p3-private-doi.v1.pdf',
} as const;

/** The path the fixture server serves a P3 file at. */
export const p3Url = (name: (typeof P3_FILES)[keyof typeof P3_FILES]): string => `/f/walkthroughs/${name}`;

/** The DOI the private invoice quotes: a lookup for it must never be sent. */
export const PRIVATE_DOI = '10.5555/private.invoice.0001';
/** A phrase that is only in the private invoice. */
export const PRIVATE_PHRASE = 'Reference doi:10.5555/private.invoice.0001';
/** The card number on the statement: a distinctive string that must never be stored. */
export const CARD_NUMBER = '4111 1111 1111 1111';

const TOPICS: Record<'a' | 'b' | 'c', { nouns: string[]; verbs: string[]; places: string[]; title: string }> = {
  a: {
    title: 'A walk through the old garden',
    nouns: ['gardener', 'rose bush', 'oak tree', 'robin', 'stone path', 'greenhouse', 'apple tree', 'beehive'],
    verbs: ['waters', 'trims', 'visits', 'watches', 'repairs', 'paints', 'sweeps', 'counts'],
    places: ['the river', 'the red gate', 'the kitchen window', 'the long hedge', 'the pond', 'the shed'],
  },
  b: {
    title: 'Notes on a small harbour town',
    nouns: ['fisherman', 'lighthouse', 'ferry', 'seagull', 'rope', 'blue boat', 'market stall', 'baker'],
    verbs: ['unloads', 'mends', 'rows', 'follows', 'ties', 'launches', 'cleans', 'carries'],
    places: ['the quay', 'the north pier', 'the harbour wall', 'the fish market', 'the beach', 'the cove'],
  },
  c: {
    title: 'A week of baking at home',
    nouns: ['loaf', 'wooden spoon', 'oven door', 'sourdough starter', 'flour jar', 'tea towel', 'rolling pin', 'cinnamon bun'],
    verbs: ['rises on', 'rests beside', 'warms near', 'cools by', 'waits under', 'fills', 'covers', 'rolls across'],
    places: ['the counter', 'the window sill', 'the top shelf', 'the kitchen table', 'the back step', 'the pantry'],
  },
};

/** Ten pages of bland, repeatable prose. No academic, money or admin words (see the head of this file). */
async function buildNotSure(kind: 'a' | 'b' | 'c'): Promise<Uint8Array> {
  const { nouns, verbs, places, title } = TOPICS[kind];
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let seed = kind === 'a' ? 7 : kind === 'b' ? 19 : 31;
  const pick = <T>(xs: T[]): T => xs[(seed = (seed * 1103515245 + 12345) & 0x7fffffff) % xs.length];
  for (let n = 1; n <= 10; n++) {
    const page = doc.addPage([612, 792]);
    if (n === 1) {
      page.drawText(title, { x: 56, y: 720, size: 22, font: bold, color: rgb(0.1, 0.1, 0.1) });
      page.drawText('Chapter 1', { x: 56, y: 690, size: 16, font: bold, color: rgb(0.1, 0.1, 0.1) });
    } else {
      page.drawText(`Page ${n}`, { x: 56, y: 720, size: 14, font: bold, color: rgb(0.1, 0.1, 0.1) });
    }
    for (let line = 0; line < 14; line++) {
      const sentence = `The ${pick(nouns)} ${pick(verbs)} ${pick(places)} and the ${pick(nouns)} ${pick(verbs)} ${pick(places)}.`;
      page.drawText(sentence, { x: 56, y: 650 - line * 22, size: 11, font, color: rgb(0.05, 0.05, 0.05) });
    }
  }
  return doc.save();
}

async function buildCard(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const lines = [
    'Card account summary',
    `Card number ${CARD_NUMBER}`,
    'Expires 12/29',
    'Name on card A Example',
    'Statement date 1 October',
    'Please keep this page in a safe place.',
  ];
  lines.forEach((text, i) => page.drawText(text, { x: 56, y: 700 - i * 26, size: 13, font }));
  return doc.save();
}

async function buildPrivateDoi(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const lines = [
    'INVOICE',
    'Invoice number INV-2026-0042',
    'VAT number GB 123 4567 89',
    'Payment due within 30 days',
    'Description            Quantity      Amount',
    'Consulting services        3        £450.00',
    'Travel and expenses        1        £120.50',
    'Subtotal                           £570.50',
    'VAT 20%                            £114.10',
    'Total amount due                   £684.60',
    PRIVATE_PHRASE,
  ];
  lines.forEach((text, i) => page.drawText(text, { x: 56, y: 700 - i * 24, size: 12, font }));
  return doc.save();
}

async function writeOnce(name: string, build: () => Promise<Uint8Array>): Promise<string> {
  const path = join(WALKTHROUGH_DIR, name);
  if ((await stat(path).catch(() => null))?.isFile()) return path;
  await mkdir(WALKTHROUGH_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, await build());
  await rename(tmp, path); // never serve half a file
  return path;
}

/** Makes every P3 file that is missing. Returns the paths on disk, by name. */
export async function ensureP3Fixtures(): Promise<Record<keyof typeof P3_FILES, string>> {
  const [notSureA, notSureB, notSureC, card, privateDoi] = await Promise.all([
    writeOnce(P3_FILES.notSureA, () => buildNotSure('a')),
    writeOnce(P3_FILES.notSureB, () => buildNotSure('b')),
    writeOnce(P3_FILES.notSureC, () => buildNotSure('c')),
    writeOnce(P3_FILES.card, buildCard),
    writeOnce(P3_FILES.privateDoi, buildPrivateDoi),
  ]);
  return { notSureA, notSureB, notSureC, card, privateDoi };
}
