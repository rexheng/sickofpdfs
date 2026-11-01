import type { Page } from '@playwright/test';
import { EXTENSION_ID, expect, test } from '../support/test';
import { readNetlogRequests } from '../support/netlog';
import { tinyPdf, type Site, type SiteRequest } from './support/site';
import { backToPage, clickLink, expectOurViewer, openInChromesViewer, quietFor, sendRuntimeMessage, shot, siteTest, visit } from './support/takeover';

// "What leaves your computer": opening a PDF sends "the PDF request itself" to "the site it came from ... exactly as
// in Chrome", and "anything else: nobody". The network gate in the harness fails any test that makes a request to
// another origin; the first test goes further and reads the net log for what the extension itself asked for.

test.describe('Opening a PDF', () => {
  test('makes no request beyond the PDF itself, whichever way it was opened', async ({ context, server, netgate }, testInfo) => {
    const tour = {
      link: server.url('/h/plain.pdf'),
      sniffed: server.url('/h/no-ctype.pdf'),
      embedPage: server.url('/h/iframe-page'),
      escaped: server.url('/f/paper-50.pdf'),
    };
    const page = await context.newPage();

    await visit(page, tour.link);
    await expectOurViewer(page, tour.link);
    await visit(page, tour.sniffed);
    await expectOurViewer(page, tour.sniffed);
    await visit(page, tour.embedPage);
    await expectOurViewer(page, server.url('/h/plain.pdf'), { back: tour.embedPage });
    await backToPage(page).click();
    await quietFor(page, 1500);
    await visit(page, tour.escaped);
    await expectOurViewer(page, tour.escaped);
    await openInChromesViewer(page, tour.escaped, testInfo);
    await quietFor(page, 1500);
    await shot(page, testInfo, 'end-of-the-tour');

    const report = await netgate.report(); // closes the browser
    expect(report.recording, 'the gate saw the extension').toBe(true);
    expect(report.external, 'no request to anything but the fixture server').toEqual([]);

    const requests = await readNetlogRequests(netgate.netlogPath);
    const allowed = new Set(['/h/plain.pdf', '/h/no-ctype.pdf', '/h/iframe-page', '/f/paper-50.pdf', '/__gate-ping', '/favicon.ico']);
    const asked = [...new Set(requests.filter((r) => r.url.startsWith(`${server.origin}/`)).map((r) => new URL(r.url).pathname))];
    expect(
      asked.filter((path) => !allowed.has(path)),
      'paths on the fixture server that nobody opened',
    ).toEqual([]);

    const own = requests.filter((r) => r.initiator === `chrome-extension://${EXTENSION_ID}` && !r.browserService).map((r) => new URL(r.url).pathname);
    expect(
      own.filter((path) => !['/h/plain.pdf', '/h/no-ctype.pdf', '/f/paper-50.pdf', '/h/iframe-page', '/__gate-ping'].includes(path)),
      "requests the extension's own pages and worker made, other than for a PDF being opened (or the page Back to page returns to)",
    ).toEqual([]);
  });
});

// The Referer and the cookies. A file host can insist on both: a download from a login-protected course area works
// only from that site's page and with the sign-in cookie. Opening it in our viewer must work as it does in Chrome, and
// must not hand either to anyone else.
//
// The viewer is a stub, so the test makes the viewer's request itself, the way the viewer will: it asks the extension
// to prepare the fetch (`takeover:prepare-fetch`) and then fetches the address from the extension's page.

/** The first and the last request a site got for `path`; fails with a plain message when it got none. */
function seen(site: Site, path: string): { first: SiteRequest; last: SiteRequest } {
  const all = site.requestsTo(path);
  const [first] = all;
  const last = all.at(-1);
  if (!first || !last) throw new Error(`${site.origin} got no request for ${path}`);
  return { first, last };
}

/** A course site (localhost) whose reading list links to a PDF on a file host (127.0.0.1) that wants a cookie and the course site as Referer. */
async function setUpCourse(args: { site: Site; files: Site }, openPage: () => Promise<Page>): Promise<{ pdf: string; page: Page }> {
  const { site, files } = args;
  const bytes = await tinyPdf();
  const pdf = files.url('/files/reading.pdf');
  files.route('/login', (_req, res) => {
    res.writeHead(200, { 'set-cookie': 'files_sid=s3cret; Path=/; HttpOnly', 'content-type': 'text/plain' }).end('signed in');
  });
  files.route('/files/reading.pdf', (_req, res, request) => {
    const signedIn = /(?:^|;\s*)files_sid=s3cret(?:;|$)/.test(request.headers.cookie ?? '');
    const fromCourse = (request.headers.referer ?? '').startsWith(site.origin);
    if (!signedIn || !fromCourse) return void res.writeHead(signedIn ? 403 : 401, { 'content-type': 'text/plain' }).end('not for you');
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.byteLength, 'cache-control': 'no-store' }).end(bytes);
  });
  site.html('/course', `<h1>Reading list</h1><a href="${pdf}">Reading 1 (PDF, sign-in needed)</a>`);

  const login = await openPage();
  await visit(login, files.url('/login')); // the owner is signed in to the file host
  await login.close();

  const page = await openPage();
  await visit(page, site.url('/course'));
  await clickLink(page.getByRole('link', { name: /Reading 1/ }));
  return { pdf, page };
}

/** The viewer's own request for `url`: it prepares the fetch through the extension, then fetches with the sign-in cookie. */
async function viewerFetch(viewer: Page, url: string, opts: { prepare: boolean }): Promise<{ status: number; head: string; prepared: { referer: string | null } | null }> {
  const prepared = opts.prepare ? await sendRuntimeMessage<{ referer: string | null }>(viewer, { type: 'takeover:prepare-fetch', url }) : null;
  const result = await viewer.evaluate(async (u) => {
    // `referrer: ''` sends none of its own, so any Referer on the request was put there by the extension
    const res = await fetch(u, { credentials: 'include', referrer: '' });
    return { status: res.status, head: new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5)) };
  }, url);
  return { ...result, prepared };
}

siteTest.describe('A PDF behind a sign-in cookie and a Referer check', () => {
  siteTest('the viewer\'s own request for it carries the same Referer and cookie that Chrome sent when the link was clicked', async ({ context, site, files }, testInfo) => {
    const { pdf, page } = await setUpCourse({ site, files }, () => context.newPage());
    await expectOurViewer(page, pdf);
    await shot(page, testInfo, 'our-viewer-for-the-protected-pdf');
    const byChrome = seen(files, '/files/reading.pdf').first;
    expect(byChrome.headers.referer, 'Chrome sent the course site as Referer when the link was clicked').toBe(`${site.origin}/`);

    const got = await viewerFetch(page, pdf, { prepare: true });

    expect(got.prepared?.referer, 'the extension remembered the Referer of the click').toBe(byChrome.headers.referer);
    expect({ status: got.status, head: got.head }, 'the file host serves the viewer as it served the click').toEqual({ status: 200, head: '%PDF-' });
    const byViewer = seen(files, '/files/reading.pdf').last;
    expect(byViewer.headers.referer, 'Referer on the viewer\'s request').toBe(byChrome.headers.referer);
    expect(byViewer.headers.cookie, 'sign-in cookie on the viewer\'s request').toContain('files_sid=s3cret');
  });

  siteTest('neither the Referer nor the cookie goes anywhere else: not to another site, not to another tab, not after the tab moves on', async ({ context, sw, site, files, openViewer }, testInfo) => {
    const { pdf, page } = await setUpCourse({ site, files }, () => context.newPage());
    await expectOurViewer(page, pdf);
    const clickReferer = seen(files, '/files/reading.pdf').first.headers.referer;
    const own = await viewerFetch(page, pdf, { prepare: true });
    expect(own.status, 'set-up check: the viewer\'s own request works').toBe(200);

    // 1. Other addresses, asked for from the same tab: the course site (another origin) and another address on the file host.
    const elsewhere = await page.evaluate(
      async (urls) =>
        Promise.all(urls.map(async (u) => ((await (await fetch(u, { credentials: 'include' })).json()) as { headers: Record<string, string | undefined> }).headers)),
      [site.url('/echo'), files.url('/echo')],
    );
    for (const headers of elsewhere) {
      expect(headers.referer, 'the click\'s Referer is not added to other addresses').not.toBe(clickReferer);
    }
    expect(elsewhere[0]?.cookie ?? '', 'the file host\'s cookie goes to the file host only').not.toContain('files_sid');

    // 2. Another tab asking for the same PDF gets nothing of this tab's Referer, so the file host refuses it.
    const other = await openViewer(pdf);
    const refused = await viewerFetch(other, pdf, { prepare: true });
    expect(refused.status, 'a tab that was not sent there by that click has no Referer to borrow').not.toBe(200);
    await shot(other, testInfo, 'second-tab-has-no-referer-to-borrow');

    // 3. When this tab leaves the PDF, nothing of its Referer stays registered.
    await visit(page, site.url('/course'));
    await expect
      .poll(
        () =>
          sw.evaluate(async () => {
            const rules = await chrome.declarativeNetRequest.getSessionRules();
            return rules.filter((r) => (r.action.requestHeaders ?? []).some((h) => h.header.toLowerCase() === 'referer')).length;
          }),
        { message: 'session rules that still set a Referer', timeout: 5_000 },
      )
      .toBe(0);
  });
});
