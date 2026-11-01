// Spec-blind browser tests for Task 13: icons.
// Spec "Type and icons": Material Symbols Outlined at weight 400, unfilled, filled when selected.
// The PDF file icon is Material Design Icons file-pdf-box, in Drive's PDF red #fc413d (research 02, section 1 item 5 and section 6.3).
// Published usage: tokens.css first, because the icon colours come from the token variables.
import '../tokens/tokens.css';
import { createElement } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { render } from '../../test/render';
import { registerFonts } from '../fonts/register';
import { FileTypeIcon } from './FileTypeIcon';
import { Icon } from './Icon';
import { ICON_NAMES } from './names';

beforeAll(async () => {
  await registerFonts();
  await document.fonts.load('24px "Material Symbols Outlined"', 'info');
});

describe('Icon', () => {
  it('renders every name in ICON_NAMES as one 24 px Material Symbol, and the spec logo icon menu_book is among them', () => {
    expect(ICON_NAMES).toContain('menu_book');
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);

    // A name the font does not know shows as its own word, which is much wider than one 24 px glyph.
    const rendered = ICON_NAMES.map((name) => {
      const el = render(createElement(Icon, { name, size: 24 }));
      return { name, text: el.textContent?.trim(), width: el.getBoundingClientRect().width };
    });
    const broken = rendered.filter((r) => r.text !== r.name || Math.abs(r.width - 24) > 2);
    expect(broken).toEqual([]);
  });

  it('is unfilled by default and fills when `filled` is set (Material Symbols FILL axis 0 to 1)', () => {
    const plain = render(createElement(Icon, { name: 'info', size: 24 }));
    const filled = render(createElement(Icon, { name: 'info', size: 24, filled: true }));
    const fillOf = (el: HTMLElement): string | null =>
      /['"]FILL['"]\s+(\d)/.exec(getComputedStyle(el).fontVariationSettings)?.[1] ?? null;

    // No explicit FILL setting also means unfilled, because the font's default FILL is 0.
    expect([null, '0']).toContain(fillOf(plain));
    expect(fillOf(filled)).toBe('1');
  });
});

describe('FileTypeIcon', () => {
  it('kind "pdf" draws a filled file-pdf-box glyph in Drive\'s PDF red rgb(252, 65, 61) at the requested size', () => {
    const el = render(createElement(FileTypeIcon, { kind: 'pdf', size: 24 }));
    const svg = el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg');
    if (!svg) throw new Error('FileTypeIcon rendered no svg');
    const path = svg.querySelector('path');
    if (!path) throw new Error('FileTypeIcon svg has no path');
    expect(path.getAttribute('d')).toBeTruthy();

    expect(Math.abs(el.getBoundingClientRect().width - 24)).toBeLessThanOrEqual(1);

    // Check what is painted: the computed fill of the path. "Filled" means the paint is not 'none'.
    // If the fill is currentColor, the painted colour is the path's own colour.
    const fill = getComputedStyle(path).fill;
    const painted = fill === 'none' ? 'none' : fill.startsWith('rgb') ? fill : getComputedStyle(path).color;
    expect(painted).toBe('rgb(252, 65, 61)');
  });
});
