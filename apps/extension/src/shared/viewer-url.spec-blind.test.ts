// Spec-blind tests for viewer addresses. Spec: "Clicking a PDF link ... opens it in our viewer in the same tab",
// "Reopening the same link ... shows the same notes", "Embedded PDFs ... a 'Back to page' button".
// Interface: ViewerParams { source, back, page }, parseViewerUrl, buildViewerUrl, VIEWER_PATH.
import { afterEach, describe, expect, it } from 'vitest';
import { VIEWER_PATH, buildViewerUrl, parseViewerUrl, type ViewerParams } from './viewer-url';

const BASE = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/viewer.html';
const NONE: ViewerParams = { source: null, back: null, page: null };
const params = (p: Partial<ViewerParams>): ViewerParams => ({ ...NONE, ...p });

const MOODLE = 'https://moodle.example.ac.uk/course/view.php?id=42&section=3#module-77';

const ROUND_TRIPS: { name: string; p: ViewerParams }[] = [
  { name: 'plain https link', p: params({ source: 'https://example.org/papers/a.pdf' }) },
  { name: 'nothing at all', p: NONE },
  { name: 'query with signed token and an encoded plus', p: params({ source: 'https://example.org/papers/a.pdf?token=abc&sig=x%2By%3D&n=1' }) },
  { name: 'its own #page= fragment (kept in the source, not the viewer page)', p: params({ source: 'https://example.org/a.pdf#page=3', page: 5 }) },
  { name: 'encoded ampersand and equals in a file name', p: params({ source: 'https://example.org/download?name=a%26b%3Dc.pdf&id=7' }) },
  { name: 'unicode host and path', p: params({ source: 'https://例え.jp/ファイル/論文 📄.pdf' }) },
  { name: 'raw spaces, brackets and parentheses', p: params({ source: 'https://example.org/my paper (final) [v2].pdf' }) },
  { name: 'plus signs in path and query', p: params({ source: 'https://example.org/c++/a+b.pdf?q=a+b' }) },
  { name: 'Windows file path with spaces, accents and a raw #', p: params({ source: 'file:///C:/Users/Rex Heng/Documents/Papers/déjà vu [draft] #1.pdf' }) },
  { name: 'a lone percent sign that is not an escape', p: params({ source: 'file:///C:/100%/notes 50% done.pdf' }) },
  { name: 'text that looks like the redirect form', p: params({ source: 'https://example.org/go?next=?DNR:https://other.example/a.pdf' }) },
  { name: 'text that looks like a viewer address', p: params({ source: `${BASE}?file=https%3A%2F%2Fa.example%2Fb.pdf&back=x#page=9` }) },
  { name: 'a 3,000-character address', p: params({ source: `https://example.org/${'a'.repeat(3000)}.pdf` }) },
  { name: 'back link with its own query and fragment, and a page', p: params({ source: 'https://example.org/a.pdf', back: MOODLE, page: 250 }) },
  { name: 'page 1', p: params({ source: 'https://example.org/a.pdf', page: 1 }) },
  { name: 'a back link with no source', p: params({ back: MOODLE }) },
  { name: 'relative-looking source and a back link that itself carries file= and back=', p: params({ source: '//elsewhere.example/x', back: 'https://elsewhere.example/?file=https://a.example/x.pdf&back=zzz#page=9' }) },
];

describe('buildViewerUrl then parseViewerUrl', () => {
  it.each(ROUND_TRIPS)('gives back the same params: $name', ({ p }) => {
    const built = buildViewerUrl(p, BASE);
    expect(parseViewerUrl(built)).toEqual(p);
    // The built address is still the viewer page, however awkward the pieces are.
    const url = new URL(built);
    expect(url.host).toBe('abcdefghijklmnopabcdefghijklmnop');
    expect(url.pathname).toBe('/viewer.html');
  });

  it('survives the browser rewriting the address (a tab reports it normalised)', () => {
    for (const { p } of ROUND_TRIPS) expect(parseViewerUrl(new URL(buildViewerUrl(p, BASE)).href)).toEqual(p);
  });
});

// Addresses made of characters that tend to break encoders, from a fixed seed so a failure can be repeated.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0; // mulberry32
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const NASTY = ['a', 'Z', '7', '%', '%25', '%2', '&', '=', '#', '?', '+', ' ', '/', ':', '\\', ';', ',', '[', ']', '{', '}', '|', '^', '`', '~', '@', '!', '$', '*', '(', ')', '"', "'", '<', '>', 'é', 'ß', '日', '📄', '\t', '.', '..', '-', '_', '&back=', '?file=', '#page=2', '?DNR:'];

describe('buildViewerUrl then parseViewerUrl on generated addresses', () => {
  it('gives back the same params for 400 awkward sources, back links and pages', () => {
    const rand = seededRandom(12);
    const piece = () => NASTY[Math.floor(rand() * NASTY.length)];
    const tail = () => Array.from({ length: 1 + Math.floor(rand() * 14) }, piece).join('');
    for (let i = 0; i < 400; i++) {
      const p = params({
        source: rand() < 0.9 ? `https://example.org/${tail()}` : null,
        back: rand() < 0.5 ? `https://moodle.example.ac.uk/${tail()}` : null,
        page: rand() < 0.5 ? 1 + Math.floor(rand() * 900) : null,
      });
      const built = buildViewerUrl(p, BASE);
      expect(parseViewerUrl(built), `case ${i}: ${JSON.stringify(p)} -> ${built}`).toEqual(p);
    }
  });
});

describe('parseViewerUrl on rubbish', () => {
  it.each(['', 'not a url', BASE + '?', BASE + '?file=%E0%A4%A', BASE + '?file=%', BASE + '?DNR:', BASE + '#page=', BASE + '?file=a&file=b', 'https://example.org/a.pdf', 'chrome-extension://'])(
    'does not throw on %j, and still answers in the right shape',
    (href) => {
      let got: ViewerParams | undefined;
      expect(() => {
        got = parseViewerUrl(href);
      }).not.toThrow();
      const { source, back, page } = got as ViewerParams;
      expect(source === null || typeof source === 'string').toBe(true);
      expect(back === null || typeof back === 'string').toBe(true);
      expect(page === null || (typeof page === 'number' && Number.isInteger(page))).toBe(true);
    },
  );
});

describe('parseViewerUrl on addresses it did not build', () => {
  const cases: { name: string; href: string; want: ViewerParams }[] = [
    { name: 'the bare viewer', href: BASE, want: NONE },
    { name: 'redirect form (?DNR:)', href: `${BASE}?DNR:https://example.org/a.pdf`, want: params({ source: 'https://example.org/a.pdf' }) },
    {
      name: 'redirect form keeps everything after ?DNR: as the source, even & and file= and back=',
      href: `${BASE}?DNR:https://example.org/a.pdf?token=1&back=zzz&file=q`,
      want: params({ source: 'https://example.org/a.pdf?token=1&back=zzz&file=q' }),
    },
    {
      name: 'redirect form leaves percent escapes alone',
      href: `${BASE}?DNR:https://example.org/a%20b%2Fc.pdf`,
      want: params({ source: 'https://example.org/a%20b%2Fc.pdf' }),
    },
    { name: 'redirect form with a local file', href: `${BASE}?DNR:file:///C:/Users/Rex/Papers/a.pdf`, want: params({ source: 'file:///C:/Users/Rex/Papers/a.pdf' }) },
    {
      name: 'redirect form: the #page=4 of a link like paper.pdf#page=4 is the page to open',
      href: `${BASE}?DNR:https://example.org/a.pdf#page=4`,
      want: params({ source: 'https://example.org/a.pdf', page: 4 }),
    },
    {
      name: 'file, back and page',
      href: `${BASE}?file=${encodeURIComponent('https://example.org/a.pdf?x=1&y=2#frag')}&back=${encodeURIComponent(MOODLE)}#page=12`,
      want: params({ source: 'https://example.org/a.pdf?x=1&y=2#frag', back: MOODLE, page: 12 }),
    },
    { name: 'back before file', href: `${BASE}?back=${encodeURIComponent(MOODLE)}&file=https%3A%2F%2Fexample.org%2Fa.pdf`, want: params({ source: 'https://example.org/a.pdf', back: MOODLE }) },
    { name: 'unknown parameters are ignored', href: `${BASE}?utm_source=x&file=https%3A%2F%2Fexample.org%2Fa.pdf&zoom=3`, want: params({ source: 'https://example.org/a.pdf' }) },
    { name: 'other PDF open parameters beside page', href: `${BASE}?file=https%3A%2F%2Fexample.org%2Fa.pdf#zoom=125&page=7`, want: params({ source: 'https://example.org/a.pdf', page: 7 }) },
    { name: 'a page that is not a number', href: `${BASE}?file=https%3A%2F%2Fexample.org%2Fa.pdf#page=abc`, want: params({ source: 'https://example.org/a.pdf' }) },
    { name: 'a fragment that is not a page', href: `${BASE}?file=https%3A%2F%2Fexample.org%2Fa.pdf#nameddest=intro`, want: params({ source: 'https://example.org/a.pdf' }) },
  ];

  it.each(cases)('$name', ({ href, want }) => {
    expect(parseViewerUrl(href)).toEqual(want);
  });
});

describe('buildViewerUrl', () => {
  it('writes the readable form: ?file= and ?back= (percent-encoded) and #page=N, and leaves out what is null', () => {
    const full = new URL(buildViewerUrl({ source: 'https://example.org/a.pdf?x=1&y=2', back: MOODLE, page: 12 }, BASE));
    expect(full.searchParams.get('file')).toBe('https://example.org/a.pdf?x=1&y=2');
    expect(full.searchParams.get('back')).toBe(MOODLE);
    expect(full.hash).toBe('#page=12');

    const bare = new URL(buildViewerUrl({ source: 'https://example.org/a.pdf', back: null, page: null }, BASE));
    expect(bare.searchParams.has('back')).toBe(false);
    expect(bare.hash).toBe('');
    expect(new URL(buildViewerUrl(NONE, BASE)).search).toBe('');
  });

  it('uses chrome.runtime.getURL(VIEWER_PATH) when no base is given (Node callers pass one)', () => {
    const g = globalThis as unknown as { chrome?: unknown };
    const before = g.chrome;
    g.chrome = { runtime: { getURL: (path: string) => `chrome-extension://stubid/${path}` } };
    try {
      expect(VIEWER_PATH).toBe('viewer.html');
      const built = buildViewerUrl({ source: 'https://example.org/a.pdf', back: null, page: 2 });
      expect(built.startsWith('chrome-extension://stubid/viewer.html')).toBe(true);
      expect(parseViewerUrl(built)).toEqual(params({ source: 'https://example.org/a.pdf', page: 2 }));
    } finally {
      g.chrome = before;
    }
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });
});
