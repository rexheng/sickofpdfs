// Spec-blind user test for Task 13: a small sample in light and in dark viewer chrome, saved for visual review.
// It asserts only the basics: both screenshots exist and differ, and body text resolves to Google Sans Text.
// Screenshots: test-results/ui-tokens-light.png and test-results/ui-tokens-dark.png (repo root).
import { createElement, type CSSProperties, type ReactElement } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../src/base.css';
import { registerFonts } from '../src/fonts/register';
import { FileTypeIcon } from '../src/icons/FileTypeIcon';
import { Icon } from '../src/icons/Icon';
import '../src/tokens/tokens.css';
import { render } from './render';
import { tokenNamesWithColour } from './token-probe.spec-blind';

const firstFamily = (el: Element): string =>
  getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim();

// A var() for the token whose value is this colour on the scope. Names are not fixed, so the value is the key.
function tokenVar(scope: Element, rgb: string): string | undefined {
  const name = tokenNamesWithColour(scope, rgb)[0];
  return name ? `var(${name})` : undefined;
}

// One element with data-theme="dark", used to look up the dark viewer-chrome tokens.
let darkScopeEl: HTMLElement | undefined;
function darkScope(): HTMLElement {
  if (!darkScopeEl) {
    darkScopeEl = document.createElement('div');
    darkScopeEl.setAttribute('data-theme', 'dark');
    document.body.append(darkScopeEl);
  }
  return darkScopeEl;
}

function specimen(dark: boolean): ReactElement {
  const frame: CSSProperties = dark
    ? {
        background: tokenVar(darkScope(), 'rgb(27, 27, 27)'),
        color: tokenVar(darkScope(), 'rgb(227, 227, 227)'),
        padding: 24,
        width: 380,
      }
    : { padding: 24, width: 380 };
  const divider = dark
    ? tokenVar(darkScope(), 'rgb(68, 71, 70)')
    : tokenVar(document.documentElement, 'rgb(196, 199, 197)');

  const line = (text: string, size: number, lineHeight: number, body = false) =>
    createElement(
      'p',
      {
        style: { fontSize: size, lineHeight: `${lineHeight}px`, margin: '4px 0' },
        ...(body ? { 'data-sample-body': '' } : {}),
      },
      text,
    );

  return createElement(
    'div',
    // The dark frame is the viewer root: data-theme="dark" makes its var() references resolve to the dark values.
    { style: frame, 'data-sample': dark ? 'dark' : 'light', ...(dark ? { 'data-theme': 'dark' } : {}) },
    line('Page title 24/32', 24, 32),
    line('Viewer file name 18/20', 18, 20),
    line('Body text and file rows 14/20', 14, 20, true),
    line('Tooltip 12/16', 12, 16),
    createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 12, height: 48, borderBottom: `1px solid ${divider}` } },
      createElement(FileTypeIcon, { kind: 'pdf', size: 24 }),
      createElement('span', { style: { fontSize: 14 } }, 'slides.pdf'),
    ),
    createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 16, marginTop: 12 } },
      createElement(Icon, { name: 'home', size: 24 }),
      createElement(Icon, { name: 'home', size: 24, filled: true }),
      createElement(Icon, { name: 'search', size: 24 }),
      createElement(Icon, { name: 'star', size: 24 }),
      createElement(Icon, { name: 'settings', size: 24 }),
      createElement(Icon, { name: 'download', size: 20 }),
      createElement(Icon, { name: 'print', size: 20 }),
      createElement(FileTypeIcon, { kind: 'pdf', size: 18 }),
    ),
  );
}

describe('light and dark sample for visual review', () => {
  beforeAll(async () => {
    await registerFonts();
    await document.fonts.load('14px "Google Sans Text"', 'Aa');
  });

  it('renders the light and dark samples, body text resolves to Google Sans Text, and both screenshots are saved', async () => {
    await page.viewport(900, 1200);
    const light = render(specimen(false));
    const dark = render(specimen(true));
    await document.fonts.ready;

    expect(firstFamily(light.querySelector('[data-sample-body]')!)).toBe('Google Sans Text');
    expect(firstFamily(dark.querySelector('[data-sample-body]')!)).toBe('Google Sans Text');
    expect(document.fonts.check('14px "Google Sans Text"')).toBe(true);

    const lightShot = await page.screenshot({
      element: light,
      path: '../../../test-results/ui-tokens-light.png',
      base64: true,
    });
    const darkShot = await page.screenshot({
      element: dark,
      path: '../../../test-results/ui-tokens-dark.png',
      base64: true,
    });

    expect(lightShot.base64.length).toBeGreaterThan(2000);
    expect(darkShot.base64.length).toBeGreaterThan(2000);
    expect(lightShot.base64).not.toBe(darkShot.base64);
  });
});
