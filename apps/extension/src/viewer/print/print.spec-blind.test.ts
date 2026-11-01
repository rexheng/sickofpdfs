// Spec-blind unit tests for the print page rules (Task 27). Written from the spec and the interface file only.
// Interface file: printPageRules(pages: PageSize[]): { css: string; pageNames: string[] } -- "one `@page p-N { size: <w>pt <h>pt; margin: 0 }`
// per distinct displayed size; pageNames[i] is sheet i's `page:` name". "(width and height swapped for /Rotate 90 or 270)". "`size: landscape`
// is not used, because it falls back to the default paper size."
// PageSize (Task 15): { width, height, rotation } -- the UNROTATED size and the page's /Rotate; the page is displayed with width and height
// swapped when (rotation) is 90 or 270.
//
// The names ("p-0", "p-1", ...) are the viewer's own; the tests read them back from the CSS and do not assume the numbering.
import { describe, expect, it } from 'vitest';
import type { PageSize } from '@sop/viewer';
import { printPageRules } from './print';

const letter = (rotation: PageSize['rotation'] = 0): PageSize => ({ width: 612, height: 792, rotation });
const page = (width: number, height: number, rotation: PageSize['rotation'] = 0): PageSize => ({ width, height, rotation });

interface Rule {
  name: string;
  size: string;
  margin: string;
}

/** Every `@page <name> { ... }` rule in `css`. */
function namedRules(css: string): Rule[] {
  return [...css.matchAll(/@page\s+([\w-]+)\s*\{([^}]*)\}/g)].map((m) => ({
    name: m[1],
    size: /size\s*:\s*([^;]+)/.exec(m[2])?.[1]?.trim() ?? '',
    margin: /margin\s*:\s*([^;]+)/.exec(m[2])?.[1]?.trim() ?? '',
  }));
}

/** `612pt 792pt` -> [612, 792]; null when it is not two lengths in points. */
function points(size: string): [number, number] | null {
  const m = /^(-?[\d.]+)pt\s+(-?[\d.]+)pt$/.exec(size.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** The displayed size of sheet `i`, read back through its page name. */
function sheetSize(out: ReturnType<typeof printPageRules>, i: number): [number, number] | null {
  const rule = namedRules(out.css).find((r) => r.name === out.pageNames[i]);
  return rule ? points(rule.size) : null;
}

describe('printPageRules: one named page size per distinct displayed size', () => {
  // [what the case is, the pages, the sheet sizes expected in pt (displayed), how many rules]
  const cases: [string, PageSize[], [number, number][]][] = [
    ['one Letter page', [letter()], [[612, 792]]],
    ['three Letter pages: one size, three sheets', [letter(), letter(), letter()], [[612, 792], [612, 792], [612, 792]]],
    ['a landscape A4 after a Letter page', [letter(), page(842, 595)], [[612, 792], [842, 595]]],
    ['/Rotate 90 turns a portrait page landscape', [letter(90)], [[792, 612]]],
    ['/Rotate 270 does too', [letter(270)], [[792, 612]]],
    ['/Rotate 180 leaves the shape alone', [letter(180)], [[612, 792]]],
    ['/Rotate 90 on a landscape page makes it portrait', [page(842, 595, 90)], [[595, 842]]],
    ['A4 in fractional points', [page(595.276, 841.89)], [[595.276, 841.89]]],
    ['a slide deck: 16:9 pages', [page(960, 540), page(960, 540)], [[960, 540], [960, 540]]],
  ];

  it.each(cases)('%s', (_name, pages, sizes) => {
    const out = printPageRules(pages);
    expect(out.pageNames.length, 'one page name per sheet').toBe(pages.length);
    sizes.forEach((want, i) => {
      const got = sheetSize(out, i);
      expect(got, `sheet ${i + 1} names a rule with a size in points`).not.toBeNull();
      // Half a point either way: rounding fractional sizes (A4 is 595.276 x 841.89) is the viewer's choice.
      expect(Math.abs(got![0] - want[0]), `sheet ${i + 1} is ${want[0]} pt wide (it says ${got![0]})`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(got![1] - want[1]), `sheet ${i + 1} is ${want[1]} pt tall (it says ${got![1]})`).toBeLessThanOrEqual(0.5);
    });
    for (const rule of namedRules(out.css)) {
      expect(rule.margin === '0' || /^0(pt|px)?$/.test(rule.margin), `@page ${rule.name} has no margin (it says "${rule.margin}")`).toBe(true);
    }
  });

  it('never uses a landscape or portrait keyword (the browser falls back to the default paper)', () => {
    const out = printPageRules([letter(), page(842, 595), letter(90)]);
    expect(out.css).not.toMatch(/landscape|portrait/i);
  });
});

describe('printPageRules: names are shared by equal sizes and differ otherwise', () => {
  it('pages of one displayed size share a name, and there is one rule for it', () => {
    // 1 and 3 are Letter portrait; 2 is Letter turned by /Rotate 90 (792 x 612); 4 is a real 792 x 612 landscape page.
    const pages = [letter(), letter(90), letter(), page(792, 612)];
    const out = printPageRules(pages);
    expect(out.pageNames[0], 'equal sizes, equal name').toBe(out.pageNames[2]);
    expect(out.pageNames[1], 'a turned Letter page is the same displayed size as a landscape one').toBe(out.pageNames[3]);
    expect(out.pageNames[0], 'portrait and landscape Letter are two sizes').not.toBe(out.pageNames[1]);
    expect(namedRules(out.css).length, 'two distinct sizes, two rules').toBe(2);
  });

  it('five different shapes, five rules, and each name resolves to a rule', () => {
    const pages = [letter(), page(842, 595), letter(90), page(960, 540), page(420, 595)];
    const out = printPageRules(pages);
    expect(new Set(out.pageNames).size).toBe(5);
    expect(namedRules(out.css).length).toBe(5);
    for (const name of out.pageNames) expect(namedRules(out.css).some((r) => r.name === name), `a rule for ${name}`).toBe(true);
  });

  it('page names are usable as CSS page names (no spaces, no leading digit)', () => {
    const out = printPageRules([letter(), page(842, 595)]);
    for (const name of out.pageNames) expect(name).toMatch(/^[A-Za-z_][\w-]*$/);
  });
});

describe('printPageRules: no pages', () => {
  it('has no names and no named rules', () => {
    const out = printPageRules([]);
    expect(out.pageNames).toEqual([]);
    expect(namedRules(out.css)).toEqual([]);
  });
});
