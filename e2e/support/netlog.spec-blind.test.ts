// Spec-blind tests for the network gate's reader (spec: "a build test fails on any other request";
// "during every end-to-end run nothing may leave except the PDF itself and allowed calls").
// netlogExternalUrls(path, allowedOrigin) lists what left the browser for anywhere but allowedOrigin.
// The net logs below copy the shape of a real Chromium --log-net-log file (checked against Chromium):
// URL_REQUEST_START_JOB events whose params carry url, initiator and request_type.
// The real-browser side of the gate (positive controls for each path) is in e2e/network-gate.spec-blind.spec.ts.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { netlogExternalUrls } from './netlog';

const ALLOWED = 'http://127.0.0.1:5000';
const EXT = 'chrome-extension://nfmemddnlcfkmecdmmmbochaompejpio';
const NOT_AN_ORIGIN = 'not an origin';

const TYPES = { REQUEST_ALIVE: 2, URL_REQUEST_START_JOB: 135, URL_REQUEST_REDIRECTED: 137, URL_REQUEST_DELEGATE_CONNECTED: 140 };

interface Req {
  url: string;
  initiator?: string;
  type?: 'other' | 'main frame' | 'subframe';
}

function events(reqs: Req[]): string[] {
  return reqs.flatMap((r, i) => {
    const id = 10 + i;
    const source = { id, start_time: String(1000 + i), type: 1 };
    return [
      { type: TYPES.REQUEST_ALIVE, phase: 1, source, time: String(1000 + i), params: { priority: 'IDLE', traffic_annotation: 46188932, url: r.url } },
      {
        type: TYPES.URL_REQUEST_START_JOB,
        phase: 1,
        source,
        time: String(1000 + i),
        params: {
          initiator: r.initiator ?? EXT,
          load_flags: 8256,
          method: 'GET',
          network_isolation_key: 'null null',
          request_type: r.type ?? 'other',
          site_for_cookies: 'SiteForCookies: {site=null; schemefully_same=false}',
          url: r.url,
        },
      },
    ].map((e) => JSON.stringify(e));
  });
}

/** A finished net log, like the file Chromium writes on a clean shutdown. */
const complete = (reqs: Req[]) =>
  `{"constants":${JSON.stringify({ logEventTypes: TYPES })},"events":[\n${events(reqs).join(',\n')}\n],"polledData":{}}\n`;
/** The file as it stands when the browser did not shut down cleanly: the events array is never closed. */
const unterminated = (reqs: Req[], trailingComma: boolean) =>
  `{"constants":${JSON.stringify({ logEventTypes: TYPES })},"events":[\n${events(reqs).join(',\n')}${trailingComma ? ',' : ''}\n`;

// What Chromium itself asks the network for in an idle profile (seen in a real log): not the extension's doing.
const BROWSER_SERVICES: Req[] = [
  { url: 'http://clients2.google.com/time/1/current?cup2key=10:abc&cup2hreq=e3b0c442', initiator: NOT_AN_ORIGIN },
  { url: 'https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', initiator: NOT_AN_ORIGIN },
  { url: 'https://www.google.com/async/folae?async=_fmt:pb&udm=50', initiator: NOT_AN_ORIGIN },
  { url: 'https://update.googleapis.com/service/update2/json?cup2key=16:abc', initiator: NOT_AN_ORIGIN },
];

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sop-netlog-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;
async function external(text: string, allowed = ALLOWED): Promise<string[]> {
  const path = join(dir, `netlog-${counter++}.json`);
  await writeFile(path, text);
  return [...new Set(await netlogExternalUrls(path, allowed))].sort();
}

describe('netlogExternalUrls: what counts as leaving', () => {
  const EXTERNAL_CASES: { name: string; req: Req }[] = [
    { name: 'fetch from the extension to another site', req: { url: 'https://api.example.com/v1/collect' } },
    { name: 'same machine, other port', req: { url: 'http://127.0.0.1:5001/a.pdf' } },
    { name: 'a port that merely starts with the allowed one', req: { url: 'http://127.0.0.1:50001/a.pdf' } },
    { name: 'the allowed origin used as a user name', req: { url: 'http://127.0.0.1:5000@evil.example/a.pdf' } },
    { name: 'another name for the same machine (localhost)', req: { url: 'http://localhost:5000/a.pdf' } },
    { name: 'the allowed host over https', req: { url: 'https://127.0.0.1:5000/a.pdf' } },
    { name: 'a frame loaded by the extension', req: { url: 'https://ads.example.net/frame', type: 'subframe' } },
    { name: 'a web socket', req: { url: 'wss://stream.example.com/socket' } },
    { name: 'a tab the extension opened (a navigation with no initiating origin)', req: { url: 'https://example.com/opened-by-tabs-create', initiator: NOT_AN_ORIGIN, type: 'main frame' } },
    { name: 'a navigation started from the viewer page', req: { url: 'https://example.com/navigated', type: 'main frame' } },
    { name: 'a request from a web page, not the extension', req: { url: 'https://tracker.example/pixel.gif', initiator: 'https://some-site.example' } },
  ];

  it.each(EXTERNAL_CASES)('reports: $name', async ({ req }) => {
    expect(await external(complete([req]))).toEqual([req.url]);
  });

  const INTERNAL_CASES: { name: string; req: Req }[] = [
    { name: 'the PDF from the allowed origin', req: { url: `${ALLOWED}/f/paper.pdf` } },
    { name: 'the allowed origin with a query string', req: { url: `${ALLOWED}/f/paper.pdf?token=a&b=c` } },
    { name: 'the extension loading its own files', req: { url: `${EXT}/viewer.html`, initiator: EXT } },
    { name: 'a Chromium service (no initiating origin, not a navigation)', req: BROWSER_SERVICES[0] },
    { name: 'Chromium sign-in probe', req: BROWSER_SERVICES[1] },
    { name: 'Chromium component updater', req: BROWSER_SERVICES[3] },
  ];

  it.each(INTERNAL_CASES)('ignores: $name', async ({ req }) => {
    expect(await external(complete([req]))).toEqual([]);
  });

  it('a mixed log reports exactly the requests the extension should not have made', async () => {
    const log = complete([
      ...BROWSER_SERVICES,
      { url: `${ALLOWED}/f/paper.pdf` },
      { url: `${EXT}/viewer.html`, initiator: EXT },
      { url: 'https://api.example.com/v1/collect' },
      { url: `${ALLOWED}/f/paper.pdf` },
      { url: 'https://example.com/opened-by-tabs-create', initiator: NOT_AN_ORIGIN, type: 'main frame' },
      { url: 'https://api.example.com/v1/collect' },
    ]);
    expect(await external(log)).toEqual(['https://api.example.com/v1/collect', 'https://example.com/opened-by-tabs-create']);
  });
});

describe('netlogExternalUrls: the file', () => {
  it('reads a log Chromium did not close (the browser was killed), with or without a trailing comma', async () => {
    const reqs: Req[] = [{ url: `${ALLOWED}/f/paper.pdf` }, { url: 'https://api.example.com/v1/collect' }];
    expect(await external(unterminated(reqs, false))).toEqual(['https://api.example.com/v1/collect']);
    expect(await external(unterminated(reqs, true))).toEqual(['https://api.example.com/v1/collect']);
  });

  it('says nothing left when nothing was requested', async () => {
    expect(await external(complete([]))).toEqual([]);
    expect(await external(complete(BROWSER_SERVICES))).toEqual([]);
  });

  it('fails loudly on a log it cannot read, never "nothing left"', async () => {
    const path = join(dir, 'missing.json');
    await expect(netlogExternalUrls(path, ALLOWED)).rejects.toThrow();
    const garbage = join(dir, 'garbage.json');
    await writeFile(garbage, 'this is not a net log');
    await expect(netlogExternalUrls(garbage, ALLOWED)).rejects.toThrow();
  });
});
