// Spec-blind browser tests for Task 31, the form bounce: `probeRefetch` and `runFormBounce`, in real Chromium against the e2e fixture server.
//
// Sources:
//   spec, Reading basics, "Forms": "PDFs with real fillable fields (text boxes, choices or checkboxes listed as form fields, or XFA) are
//     classified first and saved if they are learning PDFs, then reopen in Chrome's own viewer to be filled, through a one-time allow rule
//     for that link and tab. Link boxes that LaTeX adds to papers do not count. If the link can't be fetched again, our view stays, with
//     a banner."
//   interface file (Tasks 30+31):
//     probeRefetch(source): "http(s): GET Range bytes=0-1023 -> 200/206 and starts with %PDF-"
//     runFormBounce(ctx): "runs after the save decision settles ... 1. hasFillableFields(await backend.getFormInfo(doc))
//       2. For http(s), send takeover:prepare-fetch, then probeRefetch. 3. On bounce: show the notice for 1500 ms, then send
//       takeover:open-in-chrome. 4. On stay-with-banner: show FormBanner."
//   packages/viewer/src/backend/forms.ts: hasFillableFields is true for XFA and for a fillable widget, false for a bare /AcroForm.
//   CLAUDE.md: "no network traffic except what the owner turns on": a paper that is not a form costs its server no extra request.
//
// The service worker is replaced by a recorder (`chrome.runtime.sendMessage`), the engine by a backend that answers getFormInfo with what
// PDFium found on the real files (docs/spikes/phase0-report.md, P0-7: HMRC SA100 and NBER w29000), and the save controller by a fake that
// settles when the test says. The web is the fixture server (`/f/` serves test-assets with Range, `/mock` answers as told).
//
// GUESSES (written down in task-30-tests-report.md): G7 (no link: banner), G9 (the stay and banner answers are returned only after the
// save decision settled, so `open-in-chrome` is never sent while the filter is deciding; the tests check only that), G10 (the 1500 ms
// notice is not shorter than 1.4 s).
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import type { PdfBackend, SaveController, SaveState } from '@sop/viewer';
import type { OpenedDocument } from '../open-document';
import { probeRefetch, runFormBounce } from './form-bounce';

const ORIGIN = inject('fixtureOrigin' as never) as unknown as string;
const DOC_ID = 'ab'.repeat(32);
let counter = 0;
/** A different address each time, so a request in the page's resource timing belongs to one test. */
const unique = (path: string) => `${ORIGIN}${path}${path.includes('?') ? '&' : '?'}spec-blind=${++counter}`;
const PAPER = () => unique('/f/paper-50.pdf');
const GONE = () => unique('/f/spec-blind-missing.pdf');
const mock = (o: Record<string, string>) => unique(`/mock?${new URLSearchParams(o).toString()}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Sent {
  type: string;
  url?: string;
  at: number;
}
const sent: Sent[] = [];
const opens = (url?: string) => sent.filter((m) => m.type === 'takeover:open-in-chrome' && (url === undefined || m.url === url));
const prepares = (url: string) => sent.filter((m) => m.type === 'takeover:prepare-fetch' && m.url === url);
/** When the page started asking `url` (performance.now() time), or null if it never did. */
const requestedAt = (url: string): number | null => {
  const entry = performance.getEntriesByType('resource').find((e) => e.name === url);
  return entry ? entry.startTime : null;
};

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'spec-blind',
      sendMessage: vi.fn((m: { type: string; url?: string }) => {
        sent.push({ type: m.type, url: m.url, at: performance.now() });
        if (m.type === 'takeover:prepare-fetch') return Promise.resolve({ referer: null });
        if (m.type === 'takeover:open-in-chrome') return Promise.resolve({ ok: true });
        return Promise.resolve(undefined);
      }),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

function fakeSave(initial: SaveState) {
  let state = initial;
  const subscribers = new Set<(s: SaveState) => void>();
  const controller = {
    get state() {
      return state;
    },
    subscribe: (cb: (s: SaveState) => void) => {
      subscribers.add(cb);
      return () => void subscribers.delete(cb);
    },
    start: () => Promise.resolve(),
    requestSave: () => Promise.resolve(),
    firstMark: () => Promise.resolve(),
    undo: () => Promise.resolve(),
    answerAsk: () => Promise.resolve(),
  } as unknown as SaveController;
  return {
    controller,
    settle(next: SaveState) {
      state = next;
      for (const cb of [...subscribers]) cb(next);
    },
  };
}

const SAVED: SaveState = { kind: 'saved', documentId: DOC_ID as never, undoable: false };
const UNSURE: SaveState = { kind: 'unsure', reasons: ['No filter yet: your first mark saves it'] };

/** What PDFium reported for real files (phase 0 report, P0-7). */
const FORM_INFO = {
  sa100: { formType: 'acroform', firstFillablePage: 2, pagesWalked: 3 },
  nber: { formType: 'acroform', firstFillablePage: null, pagesWalked: 133 },
  xfa: { formType: 'xfa-foreground', firstFillablePage: null, pagesWalked: 0 },
  xfaFull: { formType: 'xfa-full', firstFillablePage: null, pagesWalked: 0 },
  none: { formType: 'none', firstFillablePage: null, pagesWalked: 0 },
} as const;

function context(info: (typeof FORM_INFO)[keyof typeof FORM_INFO], source: string | null, save: SaveState = SAVED) {
  const fake = fakeSave(save);
  const getFormInfo = vi.fn(() => Promise.resolve(info));
  const backend = { getFormInfo } as unknown as PdfBackend;
  const opened = { open: { doc: { id: 'doc-handle' }, pageCount: 3, pages: [], metadata: {}, encrypted: false }, loaded: { sourceUrl: source }, password: null } as unknown as OpenedDocument;
  return { ctx: { opened, backend, save: fake.controller, source }, fake, getFormInfo };
}

describe('probeRefetch: can the link be fetched again?', () => {
  it.each([
    { name: 'a PDF that answers the range request (206)', url: PAPER, want: true },
    { name: 'a server that ignores the range and sends the PDF whole (200)', url: () => mock({ contentType: 'application/pdf', body: '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n' }), want: true },
    { name: 'a login page served as a PDF (200, but not a PDF)', url: () => mock({ contentType: 'application/pdf', body: '<!doctype html><form>Please sign in</form>' }), want: false },
    { name: 'a link that has expired (403)', url: () => mock({ status: '403', contentType: 'text/html', body: 'This link has expired.' }), want: false },
    { name: 'a link that is gone (404)', url: GONE, want: false },
    { name: 'an empty answer', url: () => mock({ contentType: 'application/pdf', body: '' }), want: false },
    { name: 'a server that is not there (connection refused): false, never an error', url: () => 'http://127.0.0.1:1/form.pdf', want: false },
  ])('$name -> $want', async ({ url, want }) => {
    await expect(probeRefetch(url())).resolves.toBe(want);
  });
});

describe('runFormBounce', () => {
  it.each([
    { name: 'a LaTeX paper whose only widgets are link boxes (NBER w29000)', info: FORM_INFO.nber },
    { name: 'a PDF with no form at all', info: FORM_INFO.none },
  ])('$name: stays, sends nothing to Chrome, and costs its server no extra request', async ({ info }) => {
    const source = PAPER();
    const { ctx, getFormInfo } = context(info, source);

    await expect(runFormBounce(ctx)).resolves.toBe('stay');
    await sleep(1700); // longer than the notice would last

    expect(getFormInfo).toHaveBeenCalledTimes(1);
    expect(sent, 'no allow rule is asked for, and nothing is opened').toEqual([]);
    expect(requestedAt(source), 'the probe is not made for a PDF that is not a form').toBeNull();
  });

  it.each([
    { name: 'a form with fillable fields (HMRC SA100)', info: FORM_INFO.sa100 },
    { name: 'an XFA form (foreground)', info: FORM_INFO.xfa },
    { name: 'an XFA form (full)', info: FORM_INFO.xfaFull },
  ])('$name: asks for the allow rule, probes the link, shows the notice for about 1.5 s, then opens it in Chrome once', async ({ info }) => {
    const source = PAPER();
    const { ctx } = context(info, source);
    const started = performance.now();

    await expect(runFormBounce(ctx)).resolves.toBe('bounce');
    await expect.poll(() => opens(source).length, { timeout: 5000 }).toBe(1);

    const [prepare] = prepares(source);
    expect(prepare, 'takeover:prepare-fetch for this link').toBeDefined();
    const probeAt = requestedAt(source);
    expect(probeAt, 'the link was fetched again to see that it works').not.toBeNull();
    expect(prepare.at, 'the Referer is arranged before the link is fetched again').toBeLessThanOrEqual(probeAt!);
    expect(opens(source)[0].at - started, 'G10: the notice shows for 1500 ms before Chrome takes the tab').toBeGreaterThanOrEqual(1400);
    await sleep(500);
    expect(opens(), 'the tab is sent once').toHaveLength(1);
  });

  it('a form whose link cannot be fetched again: stays with a banner, and never sends the tab away', async () => {
    const { ctx } = context(FORM_INFO.sa100, GONE());

    await expect(runFormBounce(ctx)).resolves.toBe('stay-with-banner');
    await sleep(1700);

    expect(opens(), 'our viewer stays').toEqual([]);
  });

  it('a form that has no link (a file the person picked): stays with a banner (G7)', async () => {
    const { ctx } = context(FORM_INFO.sa100, null);

    await expect(runFormBounce(ctx)).resolves.toBe('stay-with-banner');
    await sleep(1700);

    expect(opens()).toEqual([]);
  });

  it('waits for the save decision: the tab is not sent away while the filter is still deciding, and it is sent after (G9)', async () => {
    const source = PAPER();
    const { ctx, fake } = context(FORM_INFO.sa100, source, { kind: 'checking' });
    void runFormBounce(ctx);

    await sleep(2000); // longer than the notice and the probe together
    expect(opens(), 'a learning form is saved first; Chrome does not take the tab before that').toEqual([]);

    fake.settle(SAVED);
    await expect.poll(() => opens(source).length, { timeout: 5000 }).toBe(1);
  });

  it('a form judged "not sure" or not learning still goes to Chrome, and nothing is saved by the bounce itself', async () => {
    const source = PAPER();
    const { ctx } = context(FORM_INFO.sa100, source, UNSURE);

    await expect(runFormBounce(ctx)).resolves.toBe('bounce');
    await expect.poll(() => opens(source).length, { timeout: 5000 }).toBe(1);
  });
});
