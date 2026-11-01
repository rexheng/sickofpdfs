import { expect, EXTENSION_ID, hooks, test } from './support/test';
import { GATE_CONTROLS } from './support/gate-controls';

// The harness self-check: the extension loads under its stable id and the viewer opens (the gate runs after this test
// too), and, in the second test, the network gate reports a stray request made through each path the extension has to
// the network (R22), so that "no external request" elsewhere cannot be a gate that saw nothing.
test('the extension loads and the viewer page opens', async ({ sw, openViewer, server }, testInfo) => {
  expect(sw.url()).toBe(`chrome-extension://${EXTENSION_ID}/background.js`);
  const page = await openViewer(server.url('/f/paper-50.pdf'));
  expect(await hooks(page).eval((h) => typeof h)).toBe('object'); // the e2e build's test hooks are installed
  await testInfo.attach('viewer-opened', { body: await page.screenshot(), contentType: 'image/png' });
});

test.describe('the network gate catches stray requests', () => {
  test.use({ networkGate: 'observe' });

  test('one request through each extension path is reported, and the fixture server is not', async ({ context, sw, server, openViewer, netgate }) => {
    const page = await openViewer(server.url('/f/paper-50.pdf'));
    const strayOrigin = server.origin.replace('127.0.0.1', 'localhost');
    const env = { context, sw, page, stray: (path: string) => `${strayOrigin}/${path}`, fixtureUrl: (path: string) => server.url(path) };

    const made: { api: string; url: string }[] = [];
    for (const control of GATE_CONTROLS) made.push({ api: control.api, url: await control.run(env) });
    const allowedUrl = server.url('/f/allowed-control.pdf');
    await page.evaluate((u) => fetch(u).then((r) => r.status), allowedUrl); // an allowed request, made the same way

    const report = await netgate.report();
    expect(made.filter((m) => !report.external.includes(m.url)).map((m) => m.api), 'paths the gate did not see').toEqual([]);
    expect(report.external.filter((u) => u.startsWith(server.origin)), 'the fixture server is allowed').toEqual([]);
    expect(report.recording).toBe(true);
  });
});
