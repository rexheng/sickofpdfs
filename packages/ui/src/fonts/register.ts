// Registers the bundled fonts with the browser, so nothing is fetched from Google at run time.
//
// Four families are registered:
//   - "Google Sans"        the OFL variable font (wght 400-700, opsz 17-18), titles and display text
//   - "Google Sans Text"   the same files under a second name. Drive's own text face is the opsz 17 end of Google Sans
//                          (02 section 2). base.css pins opsz 17 on the text roles and opsz 18 on the display roles.
//   - "Google Sans Flex"   the OFL variable font Drive uses for menus and buttons (wght 1-1000)
//   - "Material Symbols Outlined"  the icon font (Icon.tsx), wght 100-700, drawn at opsz 20 or 24
//
// Each file URL comes from a Vite `?url` import, so the bundler copies the file into the build and the page loads it
// from its own origin (the extension, in production).
import googleSansLatin from '@fontsource-variable/google-sans/files/google-sans-latin-full-normal.woff2?url';
import googleSansLatinExt from '@fontsource-variable/google-sans/files/google-sans-latin-ext-full-normal.woff2?url';
import googleSansLatinItalic from '@fontsource-variable/google-sans/files/google-sans-latin-full-italic.woff2?url';
import googleSansLatinExtItalic from '@fontsource-variable/google-sans/files/google-sans-latin-ext-full-italic.woff2?url';
import googleSansFlexLatin from '@fontsource-variable/google-sans-flex/files/google-sans-flex-latin-full-normal.woff2?url';
import googleSansFlexLatinExt from '@fontsource-variable/google-sans-flex/files/google-sans-flex-latin-ext-full-normal.woff2?url';
import materialSymbolsOutlined from 'material-symbols/material-symbols-outlined.woff2?url';

// The unicode ranges of the two subsets, as the fontsource packages declare them.
const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF';

interface FaceSpec {
  family: string;
  url: string;
  descriptors: FontFaceDescriptors;
  /** Loaded before registerFonts() resolves. The others load when text first needs them. */
  critical: boolean;
}

/** Google Sans, once per family name: latin and latin-ext, upright and italic. */
function googleSansFaces(family: string): FaceSpec[] {
  const sans = (url: string, style: string, unicodeRange: string, critical: boolean): FaceSpec => ({
    family,
    url,
    critical,
    descriptors: { style, weight: '400 700', unicodeRange, display: 'swap' },
  });
  return [
    sans(googleSansLatin, 'normal', LATIN, true),
    sans(googleSansLatinExt, 'normal', LATIN_EXT, false),
    sans(googleSansLatinItalic, 'italic', LATIN, false),
    sans(googleSansLatinExtItalic, 'italic', LATIN_EXT, false),
  ];
}

function googleSansFlexFace(url: string, unicodeRange: string, critical: boolean): FaceSpec {
  return {
    family: 'Google Sans Flex',
    url,
    critical,
    descriptors: { style: 'oblique 0deg 10deg', weight: '1 1000', stretch: '25% 151%', unicodeRange, display: 'swap' },
  };
}

const FACES: readonly FaceSpec[] = [
  ...googleSansFaces('Google Sans'),
  ...googleSansFaces('Google Sans Text'), // the same files: Drive's text face is Google Sans at opsz 17
  googleSansFlexFace(googleSansFlexLatin, LATIN, true),
  googleSansFlexFace(googleSansFlexLatinExt, LATIN_EXT, false),
  {
    family: 'Material Symbols Outlined',
    url: materialSymbolsOutlined,
    critical: true,
    // 'block': an icon name that is still loading stays invisible instead of flashing as the word "download"
    descriptors: { style: 'normal', weight: '100 700', display: 'block' },
  },
];

const sources = new WeakMap<FontFace, string>();

/** The bundled file URL a FontFace made by registerFonts() was built from. */
export function fontFaceSource(face: FontFace): string {
  const url = sources.get(face);
  if (url === undefined) throw new Error(`fontFaceSource: "${face.family}" was not registered by registerFonts()`);
  return url;
}

let registering: Promise<void> | undefined;

/**
 * Adds the bundled fonts to `document.fonts` and waits until the ones every screen needs are loaded: the latin
 * subsets of Google Sans, Google Sans Text and Google Sans Flex, and the icon font. The latin-ext and italic faces
 * load when a page first draws a character from them. Safe to call more than once.
 *
 * A screen can call it without waiting: text then draws in the next font of its stack until the files arrive, and
 * icons stay invisible (they do not flash as words).
 */
export function registerFonts(): Promise<void> {
  registering ??= load().catch((error: unknown) => {
    registering = undefined; // let the next call try again
    throw error;
  });
  return registering;
}

async function load(): Promise<void> {
  const critical: FontFace[] = [];
  for (const spec of FACES) {
    const face = new FontFace(spec.family, `url("${spec.url}") format("woff2")`, spec.descriptors);
    sources.set(face, spec.url);
    document.fonts.add(face);
    if (spec.critical) critical.push(face);
  }
  await Promise.all(critical.map((face) => face.load()));
}
