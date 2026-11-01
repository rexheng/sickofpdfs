import { expect } from '@playwright/test';
import type { DetectedFigure, PageObjectInfo, Rect, StructElement, TextRun } from '../src/engine/spike-native';
import { test } from './fixtures';
import { record } from './record';

// The brief's tests, with their assertions unchanged (the iou helper is ruling R1's real intersection over union).
// Additions: each check test writes its measurements with record() before asserting, so a failing run keeps them.
// Fixtures: `fixtures:objects` (objects.pdf, tagged.pdf) and `fixtures` (the five papers).
const iou = (a: Rect, b: Rect) => {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return (w * h) / (a.width * a.height + b.width * b.height - w * h);
};
const flatten = (els: StructElement[]): StructElement[] => els.flatMap((e) => [e, ...flatten(e.children)]);
const n1 = (n: number) => Math.round(n * 10) / 10;
const n3 = (n: number) => Math.round(n * 1000) / 1000;
const box = (r: Rect) => `(${n1(r.x)}, ${n1(r.y)}, ${n1(r.width)} × ${n1(r.height)})`;
const PAPERS = ['arxiv-1512.03385-resnet', 'arxiv-1706.03762-attention', 'arxiv-1603.02754-xgboost', 'nature-s41586-021-03819-2-alphafold', 'arxiv-1802.03042-deep-hedging'];

test('P0-10: the iou helper is real intersection over union', () => {
  expect(iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 })).toBe(1);
  expect(iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 })).toBeCloseTo(50 / 150, 6);
  expect(iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 })).toBe(0);
});
test('P0-10: objects fixture enumerates images and paths with exact bounds', async ({ objectsPage }) => {
  const r = await objectsPage('objects.pdf', 0);
  const objects: PageObjectInfo[] = r.objects;
  const count = (t: string) => objects.filter((o) => o.type === t).length;
  const image = objects.find((o) => o.type === 'image');
  await record('P0-10', {
    pass: !!image && iou(image.bounds, { x: 72, y: 90, width: 216, height: 144 }) > 0.99 && count('path') >= 48,
    measured:
      `objects.pdf p1: ${objects.length} objects (${count('image')} image, ${count('path')} path, ${count('text')} text) in ${r.elapsedMs} ms, ` +
      `truncated ${r.truncated}; image ${image ? `${box(image.bounds)} ${image.image?.pixelWidth}×${image.image?.pixelHeight} px ${image.image?.filters.join('+')}` : 'none'}`,
  });
  const img = r.objects.find((o: PageObjectInfo) => o.type === 'image')!;
  expect(img.bounds).toMatchObject({ x: expect.closeTo(72, 0.5), y: expect.closeTo(90, 0.5), width: expect.closeTo(216, 0.5), height: expect.closeTo(144, 0.5) });
  expect(r.objects.filter((o: PageObjectInfo) => o.type === 'path').length).toBeGreaterThanOrEqual(48);
});
test('P0-10: captions pair with figures and a text table', async ({ objectsPage }) => {
  const { figures, detectMs } = await objectsPage('objects.pdf', 0, { detect: true });
  const truth: Record<string, Rect> = { 'Figure 1': { x: 72, y: 90, width: 216, height: 144 }, 'Figure 2': { x: 330, y: 90, width: 200, height: 140 }, 'Table 1': { x: 72, y: 420, width: 300, height: 80 } };
  const found = (figures as DetectedFigure[]).map((f) => `${f.label ?? 'unlabelled'} ${f.kind} ${f.confidence} ${box(f.rect)}${f.label && truth[f.label] ? ` IoU ${n3(iou(f.rect, truth[f.label]))}` : ''}`);
  const fig = (label: string) => (figures as DetectedFigure[]).find((f) => f.label === label);
  await record('P0-10', {
    pass:
      JSON.stringify(figures.map((f: DetectedFigure) => f.label).sort()) === JSON.stringify(['Figure 1', 'Figure 2', 'Table 1']) &&
      iou(fig('Figure 1')?.rect ?? truth['Figure 1']!, truth['Figure 1']!) >= 0.9 &&
      iou(fig('Figure 2')?.rect ?? { x: 0, y: 0, width: 1, height: 1 }, truth['Figure 2']!) >= 0.9 &&
      fig('Table 1')?.kind === 'table' &&
      figures.every((f: DetectedFigure) => f.confidence === 'high'),
    measured: `objects.pdf p1 detection in ${detectMs} ms: ${found.join('; ') || 'no figures'}`,
  });
  expect(figures.map((f: DetectedFigure) => f.label).sort()).toEqual(['Figure 1', 'Figure 2', 'Table 1']);
  expect(iou(figures.find((f: DetectedFigure) => f.label === 'Figure 1')!.rect, { x: 72, y: 90, width: 216, height: 144 })).toBeGreaterThanOrEqual(0.9);
  expect(iou(figures.find((f: DetectedFigure) => f.label === 'Figure 2')!.rect, { x: 330, y: 90, width: 200, height: 140 })).toBeGreaterThanOrEqual(0.9);
  expect(figures.find((f: DetectedFigure) => f.label === 'Table 1')!.kind).toBe('table');
  expect(figures.every((f: DetectedFigure) => f.confidence === 'high')).toBe(true);
});
test('P0-10: tagged PDF exposes Figure with alt text', async ({ objectsPage }) => {
  const r = await objectsPage('tagged.pdf', 0);
  const all = flatten(r.struct);
  const figure = all.find((e) => e.type === 'Figure');
  await record('P0-10', {
    pass: all.some((e) => e.type === 'Figure' && e.altText === 'Bar chart of test scores'),
    measured:
      `tagged.pdf p1 structure tree: ${all.length} elements (${[...new Set(all.map((e) => e.type))].join(', ')}); ` +
      (figure ? `Figure alt ${JSON.stringify(figure.altText)}, marked-content ids [${figure.markedContentIds.join(', ')}]` : 'no Figure element'),
  });
  expect(flatten((await objectsPage('tagged.pdf', 0)).struct)).toContainEqual(expect.objectContaining({ type: 'Figure', altText: 'Bar chart of test scores' }));
});
test('P0-10: getPageTextRuns gives positioned runs, and the caption sits under its image', async ({ objectsPage }) => {
  const { runs } = await objectsPage('objects.pdf', 0, { textRuns: true });
  const caption = (runs as TextRun[]).find((r) => r.text.startsWith('Figure 1: A photo.'));
  await record('P0-10', {
    pass: !!caption && Math.abs(caption.rect.x - 72) <= 1 && caption.rect.y >= 236 && caption.rect.y <= 248 && Math.abs(caption.fontSize - 9) <= 0.1 && caption.charCount === caption.text.length,
    measured: `objects.pdf p1: ${runs.length} text runs; caption run ${caption ? `${JSON.stringify(caption.text)} at ${box(caption.rect)}, ${n3(caption.fontSize)} pt, chars ${caption.charStart}+${caption.charCount}` : 'not found'}`,
  });
  const cap = runs.find((r: TextRun) => r.text.startsWith('Figure 1: A photo.'))!;
  expect(Math.abs(cap.rect.x - 72)).toBeLessThanOrEqual(1);
  expect(cap.rect.y).toBeGreaterThanOrEqual(236);
  expect(cap.rect.y).toBeLessThanOrEqual(248);
  expect(Math.abs(cap.fontSize - 9)).toBeLessThanOrEqual(0.1);
  expect(cap.charCount).toBe(cap.text.length);
});
test('P0-10: objects + detection p95 ≤ 20 ms a page on 50 real paper pages', async ({ objectsPage }) => {
  const r = await objectsPage('papers', 0, { timing: PAPERS, pages: 10 });
  const objects = r.pages.map((p: { objectCount: number }) => p.objectCount).sort((a: number, b: number) => a - b);
  const slowest = [...r.pages].sort((a, b) => b.ms - a.ms)[0];
  await record('P0-10', {
    pass: r.p95Ms <= 20 && r.maxMs <= 40 && r.resnetPage0Labels.includes('Figure 1'),
    measured:
      `${r.pages.length} paper pages (5 papers × 10): objects + detection p50 ${r.p50Ms} / p95 ${r.p95Ms} / max ${r.maxMs} ms ` +
      `(first call, text page still to load: p50 ${r.firstP50Ms} / p95 ${r.firstP95Ms} / max ${r.firstMaxMs} ms); ` +
      `objects a page median ${objects[Math.floor(objects.length / 2)]}, max ${objects.at(-1)}; ${r.figureCount} figures (${r.captionedCount} captioned); ` +
      `slowest ${slowest.name} p${slowest.pageIndex + 1} ${slowest.ms} ms; ResNet p1 labels [${r.resnetPage0Labels.join(', ')}]`,
  });
  expect(r.p95Ms).toBeLessThanOrEqual(20);
  expect(r.maxMs).toBeLessThanOrEqual(40);
  expect(r.resnetPage0Labels).toContain('Figure 1');
});
test('P0-10: a 50,000-object page stops at the cap', async ({ objectsPage }) => {
  const r = await objectsPage('objects.pdf', 1);
  await record('P0-10', {
    pass: r.truncated === true && r.elapsedMs <= 25,
    measured: `objects.pdf p2 (50,000 rectangles): stopped at ${r.objects.length} objects in ${r.elapsedMs} ms, truncated ${r.truncated}`,
  });
  expect(r.truncated).toBe(true);
  expect(r.elapsedMs).toBeLessThanOrEqual(25);
});
