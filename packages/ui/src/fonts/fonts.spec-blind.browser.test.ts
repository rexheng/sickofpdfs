// Spec-blind browser tests for Task 13: fonts.
// Spec "Visual design", "Type and icons": Google Sans for titles, Google Sans Text for body and rows,
// Google Sans Flex for menus and buttons; all bundled, nothing loaded from the internet.
import { beforeAll, describe, expect, it } from 'vitest';
// Published usage: tokens.css first, then base.css, which reads the token variables.
import '../tokens/tokens.css';
import '../base.css';
import { fontFaceSource, registerFonts } from './register';

const FAMILIES = ['Google Sans', 'Google Sans Text', 'Google Sans Flex', 'Material Symbols Outlined'];

const unquote = (family: string): string => family.replace(/^["']|["']$/g, '');
const facesOf = (family: string): FontFace[] => [...document.fonts].filter((face) => unquote(face.family) === family);
const firstFamily = (el: Element): string =>
  getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim();

beforeAll(async () => {
  await registerFonts();
  // Ask the browser to load each face for real, using glyphs the faces must cover.
  for (const family of FAMILIES) await document.fonts.load(`16px "${family}"`, 'Aa home');
});

describe('registerFonts', () => {
  it('loads all four families from bundled files, with no request to Google', () => {
    const notLoaded = FAMILIES.filter((family) => !facesOf(family).some((face) => face.status === 'loaded'));
    expect(notLoaded).toEqual([]);

    const sources = FAMILIES.flatMap((family) => facesOf(family).map((face) => fontFaceSource(face)));
    expect(sources.length).toBeGreaterThanOrEqual(FAMILIES.length);
    const remote = sources.filter((src) => {
      const url = new URL(src, location.href);
      return url.protocol !== 'data:' && url.origin !== location.origin;
    });
    expect(remote).toEqual([]);

    const googleFontRequests = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /fonts\.(googleapis|gstatic)\.com/.test(name));
    expect(googleFontRequests).toEqual([]);
  });
});

describe('text uses the bundled Google Sans faces', () => {
  it('body text is Google Sans Text and titles are Google Sans', async () => {
    const body = document.createElement('p');
    body.textContent = 'Drive-style body text in a file row';
    const title = document.createElement('h1');
    title.textContent = 'Welcome';
    document.body.append(body, title);
    await document.fonts.ready;

    expect(firstFamily(body)).toBe('Google Sans Text');
    expect(firstFamily(title)).toBe('Google Sans');
    expect(document.fonts.check('14px "Google Sans Text"')).toBe(true);
    expect(document.fonts.check('24px "Google Sans"')).toBe(true);
  });
});
