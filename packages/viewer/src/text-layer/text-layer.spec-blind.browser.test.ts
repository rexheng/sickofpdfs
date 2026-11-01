// Spec-blind browser tests for the text layer's contract (Task 22): the layer is built from PDFium's glyph boxes, and a
// selection in it maps back to PDFium char ranges and out again. Written from the interface file only: `buildTextItems`,
// `renderTextLayer`, `getSelectionRanges`, `selectCharRanges`, `normalizeCopiedText` and the `data-start` offsets.
//
// Run: `pnpm test:browser packages/viewer/src/text-layer` (needs `pnpm fixtures`, and the engine assets, which the
// browser project copies in). The module that exports each function is not named by the interface file, so the
// functions are looked up in text-layer.ts, items.ts and char-map.ts (the files the interface file creates).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifier, copyOf, generated } from '../../test/spec-blind/browser-helpers';
import { createEmbedPdfBackend } from '../backend/embedpdf/backend';
import { engineAssets } from '../backend/embedpdf/assets';
import type { DocHandle, PageGlyphs, PdfBackend } from '../backend/types';
import type { PageBox } from '../layout/page-layout';

declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: { eager: true }): Record<string, T>;
  }
}

interface CharRange {
  pageIndex: number;
  start: number;
  end: number;
}
interface TextItem {
  str: string;
  dir: 'ltr' | 'rtl';
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
  hasEOL: boolean;
  start: number;
}
interface TextLayerHandle {
  root: HTMLElement;
  update(scale: number, rotation: 0 | 90 | 180 | 270): void;
  destroy(): void;
}
type BuildTextItems = (g: PageGlyphs, measure: (text: string, cssFont: string) => number, scale: number) => TextItem[];
type RenderTextLayer = (container: HTMLElement, items: TextItem[], box: PageBox, pageIndex: number) => TextLayerHandle;
type GetSelectionRanges = (viewerRoot: HTMLElement) => CharRange[];
type SelectCharRanges = (viewerRoot: HTMLElement, ranges: CharRange[]) => void;
type NormalizeCopiedText = (s: string) => string;

const modules = import.meta.glob<Record<string, unknown>>('./{text-layer,items,char-map}.ts', { eager: true });
function exported<T>(name: string): T {
  for (const m of Object.values(modules)) if (typeof m[name] === 'function') return m[name] as T;
  throw new Error(`none of text-layer.ts, items.ts or char-map.ts exports ${name} (found ${Object.keys(modules).join(', ') || 'no such files'})`);
}

const ASSETS = engineAssets((path) => new URL(`/apps/extension/public/${path}`, globalThis.location.href).href);
const SLOW = 60_000;

let backend: PdfBackend;
beforeAll(() => {
  backend = createEmbedPdfBackend(ASSETS);
});
afterAll(() => {
  (backend as { dispose?: () => void }).dispose?.();
});

const squash = (s: string) => s.normalize('NFKC').replace(/[\s\u00AD\u200B\uFFFE]+/gu, '');
const measure = (() => {
  const ctx = document.createElement('canvas').getContext('2d')!;
  return (text: string, cssFont: string) => {
    ctx.font = cssFont;
    return ctx.measureText(text).width;
  };
})();

// A small seeded choice, so the same ranges are tried every run.
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Built {
  viewerRoot: HTMLElement;
  handle: TextLayerHandle;
  items: TextItem[];
  glyphs: PageGlyphs;
  doc: DocHandle;
  text: string;
  dispose(): void;
}

/** Opens a fixture, builds page 1's text layer the way the viewer does, and mounts it in a viewer-shaped DOM. */
async function build(bytes: Uint8Array, scale = 1): Promise<Built> {
  const info = await backend.open(copyOf(bytes));
  const glyphs = await backend.getPageGlyphs(info.doc, 0);
  const text = await backend.getPageText(info.doc, 0);
  const items = exported<BuildTextItems>('buildTextItems')(glyphs, measure, scale);
  const page = info.pages[0];
  const box: PageBox = { index: 0, top: 0, left: 0, width: (page.width * 96 * scale) / 72, height: (page.height * 96 * scale) / 72, rotation: 0 };
  const viewerRoot = document.createElement('div');
  const pageEl = document.createElement('div');
  pageEl.dataset.pageIndex = '0';
  pageEl.style.cssText = `position:relative;width:${box.width}px;height:${box.height}px`;
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;inset:0';
  pageEl.append(container);
  viewerRoot.append(pageEl);
  document.body.append(viewerRoot);
  const handle = exported<RenderTextLayer>('renderTextLayer')(container, items, box, 0);
  return {
    viewerRoot,
    handle,
    items,
    glyphs,
    doc: info.doc,
    text,
    dispose() {
      handle.destroy();
      viewerRoot.remove();
      void backend.close(info.doc);
    },
  };
}

const visible = (g: { text: string; generated: boolean; box: { width: number } }) => !g.generated && !/^\s$/u.test(g.text) && !'\uFFFE\uFFFF\u00AD\u200B\u2060\uFEFF'.includes(g.text) && g.box.width > 0;

const FIXTURES = [
  { name: 'tl-two-column.pdf', note: 'plain two-column text' },
  { name: 'tl-ligatures.pdf', note: 'ligatures: letters sharing one box' },
  { name: 'tl-rtl.pdf', note: 'right to left' },
  { name: 'tl-maths.pdf', note: 'maths italic letters (two UTF-16 units one box) and superscripts' },
  { name: 'tl-rotated-table.pdf', note: 'text at 270 degrees, one object a glyph' },
];

describe.each(FIXTURES)('the text layer of $name ($note)', ({ name }) => {
  let built: Built;
  beforeAll(async () => {
    built = await build(await generated(name, 'Run `pnpm fixtures`.'));
  }, SLOW);
  afterAll(() => built.dispose());

  it('is made of items in text order whose text is the page text', () => {
    const { items, text } = built;
    expect(items.length).toBeGreaterThan(0);
    for (let i = 1; i < items.length; i++) expect(items[i].start, `item ${i} starts after item ${i - 1}`).toBeGreaterThan(items[i - 1].start);
    expect(squash(items.map((i) => i.str).join(''))).toBe(squash(text));
    // Each item says which way it reads, and has a real size.
    for (const it of items) {
      expect(['ltr', 'rtl']).toContain(it.dir);
      expect(it.width).toBeGreaterThan(0);
      expect(it.height).toBeGreaterThan(0);
    }
  });

  it('puts every item in the DOM with its data-start offset, text not hidden from the accessibility tree', () => {
    const spans = [...built.viewerRoot.querySelectorAll<HTMLElement>('[data-start]')];
    expect(spans.map((s) => Number(s.dataset.start))).toEqual(expect.arrayContaining(built.items.map((i) => i.start)));
    expect(built.viewerRoot.querySelector('[aria-hidden="true"] [data-start], [data-start][aria-hidden="true"]')).toBeNull();
  });

  it('turns a selection of chars [a, b) into the DOM and back to exactly [a, b)', () => {
    const { viewerRoot, glyphs } = built;
    const pool = glyphs.glyphs.filter(visible).map((g) => g.index);
    const random = seeded(22);
    const select = exported<SelectCharRanges>('selectCharRanges');
    const read = exported<GetSelectionRanges>('getSelectionRanges');
    const failures: string[] = [];
    for (let n = 0; n < 40; n++) {
      const i = Math.floor(random() * pool.length);
      const j = n % 2 === 0 ? Math.min(pool.length - 1, i + Math.floor(random() * 30)) : Math.floor(random() * pool.length);
      const a = Math.min(pool[i], pool[j]);
      const b = Math.max(pool[i], pool[j]) + 1; // end exclusive: a visible last glyph
      select(viewerRoot, [{ pageIndex: 0, start: a, end: b }]);
      const got = read(viewerRoot);
      if (got.length !== 1 || got[0].pageIndex !== 0 || got[0].start !== a || got[0].end !== b) failures.push(`[${a}, ${b}) came back as ${JSON.stringify(got.map((r) => [r.start, r.end]))}`);
    }
    expect(failures).toEqual([]);
  });

  it('selects the same letters the engine reports for the range', async () => {
    const { viewerRoot, glyphs, doc } = built;
    const pool = glyphs.glyphs.filter(visible).map((g) => g.index);
    const select = exported<SelectCharRanges>('selectCharRanges');
    for (const [a, b] of [[pool[0], pool[Math.min(20, pool.length - 1)] + 1], [pool[Math.floor(pool.length / 2)], pool[pool.length - 1] + 1], [pool[0], pool[pool.length - 1] + 1]] as const) {
      select(viewerRoot, [{ pageIndex: 0, start: a, end: b }]);
      const engine = await backend.getTextRange(doc, 0, a, b - a);
      expect(squash(String(getSelection())), `DOM selection of [${a}, ${b})`).toBe(squash(engine));
    }
  });

  it('clears the selection when given no ranges, and ignores a selection outside the layer', () => {
    const { viewerRoot, glyphs } = built;
    const select = exported<SelectCharRanges>('selectCharRanges');
    const read = exported<GetSelectionRanges>('getSelectionRanges');
    const first = glyphs.glyphs.find(visible)!.index;
    select(viewerRoot, [{ pageIndex: 0, start: first, end: first + 3 }]);
    expect(read(viewerRoot)).toHaveLength(1);
    select(viewerRoot, []);
    expect(read(viewerRoot)).toEqual([]);
    expect(String(getSelection())).toBe('');

    const outside = document.createElement('p');
    outside.textContent = 'nothing to do with the page';
    document.body.append(outside);
    getSelection()!.selectAllChildren(outside);
    expect(read(viewerRoot), 'a selection elsewhere in the document is not a char range').toEqual([]);
    outside.remove();
    getSelection()!.removeAllRanges();
  });

  it('takes the layer out of the DOM when destroyed', async () => {
    const again = await build(await generated(name, 'Run `pnpm fixtures`.'));
    const { root } = again.handle;
    expect(root.isConnected).toBe(true);
    again.handle.destroy();
    expect(root.isConnected, 'destroy() removes the layer').toBe(false);
    expect(again.viewerRoot.querySelector('[data-start]')).toBeNull();
    again.viewerRoot.remove();
    void backend.close(again.doc);
  }, SLOW);
});

describe('a real paper page keeps its text layer in step with the engine', () => {
  it('ResNet page 1: items run in text order and a range of the abstract round-trips', async () => {
    const built = await build(await classifier('learning/arxiv-1512.03385-resnet.pdf'));
    try {
      expect(squash(built.items.map((i) => i.str).join('')).replace(/-/gu, '')).toBe(squash(built.text).replace(/-/gu, ''));
      const hit = (await backend.searchPage(built.doc, 0, 'Deeper neural networks are more difficult', { matchCase: true, wholeWord: false }))[0];
      const select = exported<SelectCharRanges>('selectCharRanges');
      const read = exported<GetSelectionRanges>('getSelectionRanges');
      select(built.viewerRoot, [{ pageIndex: 0, start: hit.start, end: hit.start + hit.count }]);
      expect(read(built.viewerRoot)).toEqual([{ pageIndex: 0, start: hit.start, end: hit.start + hit.count }]);
      expect(squash(String(getSelection()))).toBe(squash('Deeper neural networks are more difficult'));
    } finally {
      built.dispose();
    }
  }, SLOW);
});

// normalizeCopiedText: "U+FB00-U+FB06 -> letters; U+0000 removed" (the interface file). Nothing else is promised, so text
// that has none of those passes through unchanged, which is what R26 asks (the copy matches the engine's text).
describe('normalizeCopiedText', () => {
  const rows: [string, string, string][] = [
    ['ff ligature', '\uFB00', 'ff'],
    ['fi ligature', 'o\uFB01ce', 'ofice'],
    ['fl ligature', '\uFB02uffy', 'fluffy'],
    ['ffi ligature', 'o\uFB03ce', 'office'],
    ['ffl ligature', 'ba\uFB04e', 'baffle'],
    ['long s t ligature', '\uFB05', 'st'],
    ['st ligature', '\uFB06', 'st'],
    ['NUL removed', 'a\u0000b', 'ab'],
    ['ligature and NUL together', '\uFB03\u0000ce', 'ffice'],
    ['plain text unchanged', 'The survey began in early spring.', 'The survey began in early spring.'],
    ['line breaks unchanged', 'one\r\ntwo\nthree', 'one\r\ntwo\nthree'],
    ['Hebrew unchanged', '\u05D1\u05E9\u05E0\u05EA 2024', '\u05D1\u05E9\u05E0\u05EA 2024'],
    ['superscript two and maths letters unchanged', 'x\u00B2 \uD835\uDC65', 'x\u00B2 \uD835\uDC65'],
    ['empty', '', ''],
  ];
  it.each(rows)('%s', (_name, input, expected) => {
    expect(exported<NormalizeCopiedText>('normalizeCopiedText')(input)).toBe(expected);
  });
});
