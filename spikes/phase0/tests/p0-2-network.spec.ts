import { expect } from '@playwright/test';
import { test } from './fixtures';
import { readNetlogRequests, readNetlogUrls } from './netlog';
import { record } from './record';

// readNetlogUrls covers everything pages, workers, service workers and navigations requested.
// Chromium's own background services (network time, Gaia, component updater, …) are not the
// extension's doing; they are listed in the record's note instead.
test('P0-2: nothing leaves the browser except the two PDF fetches', async ({ launchSpike, server }) => {
  const { context, netlogPath, openSpike } = await launchSpike({ netlog: true });
  await openSpike({ check: 'render', engine: 'v2-file', file: server.url('paper-50.pdf'), fonts: server.url('font-fixture.pdf') });
  await context.close();
  const urls = (await readNetlogUrls(netlogPath)).filter((u) => /^(https?|wss?):/.test(u));
  expect(urls.map((u) => new URL(u).host).every((h) => h === new URL(server.url('/')).host)).toBe(true);
  expect([...new Set(urls.map((u) => new URL(u).pathname))].sort()).toEqual(['/font-fixture.pdf', '/paper-50.pdf']);
  const services = [...new Set((await readNetlogRequests(netlogPath)).filter((r) => r.browserService).map((r) => new URL(r.url).host))];
  await record('P0-2', {
    pass: true,
    measured: `${urls.length} requested URLs in the net log, all ${new URL(server.url('/')).host}: /font-fixture.pdf, /paper-50.pdf`,
    note: `Chromium's own service requests left out: ${services.join(', ') || 'none'}`,
  });
});

// Positive control for the reader: the same check fetching from `localhost` (another host string
// for the same server) must show up, so a stray fetch by the extension would fail the test above.
test('P0-2 control: a fetch by the extension to another host shows up in the net log', async ({ launchSpike, server }) => {
  const { context, netlogPath, openSpike } = await launchSpike({ netlog: true });
  const elsewhere = server.url('paper-50.pdf').replace('://127.0.0.1:', '://localhost:');
  const r = await openSpike({ check: 'render', engine: 'v2-file', file: elsewhere });
  await context.close();
  expect(r.error).toBeNull();
  expect(await readNetlogUrls(netlogPath)).toContain(elsewhere);
});
