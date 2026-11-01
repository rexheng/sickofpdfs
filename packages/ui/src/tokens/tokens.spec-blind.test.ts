/// <reference types="node" />
// Spec-blind test for Task 13: the Drive token VALUES.
// Source: spec "Visual design" (colours, shape and layout) and docs/research/02-drive-visual-spec.md section 3.
// The interface does not fix token names, so each check looks for the value declared in the token file.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readToken = (file: string): string => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');

// Every declared custom property value in the CSS blocks whose selector passes `keep`. Comments are removed first.
function declaredValues(css: string, keep: (selector: string) => boolean): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const values: string[] = [];
  for (const block of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!keep(block[1].trim())) continue;
    for (const declaration of block[2].split(';')) {
      const m = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(declaration);
      if (m) values.push(m[2]);
    }
  }
  return values;
}

// Lower-case hex, with 3-digit hex expanded, so #FFF and #ffffff compare equal.
function normaliseHex(value: string): string {
  const s = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : s;
}

// The light block is the one whose selector list includes exactly :root (for example ":root, [data-theme='light']").
// The block regex can pull a preceding @import line into the selector, so split on ';' as well as ','.
const isLightBlock = (selector: string): boolean =>
  selector.split(/[,;]/).some((part) => part.trim() === ':root');

// Spec "Colours" table and research 02 section 3.1 (light set), the four most visible roles.
const KEY_LIGHT_COLOURS: Array<[role: string, hex: string]> = [
  ['primary (buttons, links, focus ring)', '#0b57d0'],
  ['surface (white content card)', '#ffffff'],
  ['on-surface (primary text)', '#1f1f1f'],
  ['divider (row dividers)', '#c4c7c5'],
];

// Research 02 section 3 "Dark tokens" (the viewer chrome, not the dark PDF pages), the three most visible roles.
const KEY_DARK_CHROME_COLOURS: Array<[role: string, hex: string]> = [
  ['viewer canvas (surface-container-low)', '#1b1b1b'],
  ['toolbar pill (surface-container-highest)', '#333537'],
  ['on-surface (dark text)', '#e3e3e3'],
];

describe('Drive light tokens (tokens.css)', () => {
  it('declares the key Drive colours: primary, surface, on-surface and divider', () => {
    const declared = new Set(declaredValues(readToken('tokens.css'), isLightBlock).map(normaliseHex));
    const missing = KEY_LIGHT_COLOURS.filter(([, hex]) => !declared.has(hex));
    expect(missing).toEqual([]);
  });

  it('declares the key Drive sizes: 48 px rows, 16 px content-card corners and 14/20 body text', () => {
    const values = declaredValues(readToken('tokens.css'), isLightBlock).map((v) => v.trim());
    const found = {
      'row height 48px': values.includes('48px'),
      'content card radius 16px': values.includes('16px'),
      'body text 14px/20px': values.some((v) => /\b14px\s*\/\s*20px\b/.test(v)),
    };
    expect(Object.entries(found).filter(([, ok]) => !ok).map(([name]) => name)).toEqual([]);
  });
});

describe('Drive dark viewer-chrome tokens (tokens-dark.css)', () => {
  it('declares the dark viewer-chrome colours: viewer canvas, toolbar pill and on-surface', () => {
    const declared = new Set(declaredValues(readToken('tokens-dark.css'), () => true).map(normaliseHex));
    const missing = KEY_DARK_CHROME_COLOURS.filter(([, hex]) => !declared.has(hex));
    expect(missing).toEqual([]);
  });
});
