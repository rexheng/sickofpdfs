import { expect } from '@playwright/test';
import { test } from './fixtures';
import { record } from './record';

// The brief's P0-6a–c, with their assertions unchanged and two more: 6a's buffer must be detached on both sides
// (a transfer, not a copy), and 6c's offscreen document must have replied unless the call errored. Each test
// writes its measurements with record() before asserting, so a failing run keeps them. No fixture files are needed.
// P0-6d and P0-6e (the 1 GiB open limit) are not run, by the user's decision; every record says so in `deferred`.
const MB300 = 300 * 1024 * 1024;
const DEFERRED = "1 GiB open limit not measured (stubbed by user decision); MAX_OPEN_BYTES stays 1 GiB, and larger files go to Chrome's viewer per the spec";

test('P0-6a: 300 MB ArrayBuffer tab→offscreen and back over an SW-brokered MessagePort', async ({ spikePage }) => {
  const r = await spikePage({ check: 'transfer', mode: 'port', bytes: MB300 });
  await record('P0-6', {
    pass: r.hashMatches === true && r.transferred === true && r.toOffscreenMs < 1000 && r.backMs < 1000,
    measured:
      `6a port: 300 MiB to offscreen ${r.toOffscreenMs} ms, back ${r.backMs} ms, round trip with the offscreen hash ${r.totalMs} ms; ` +
      `detached after each send ${r.transferred}; SHA-256 ${r.hashMatches ? 'matches both ways' : 'differs'}`,
    ...(r.error ? { note: `6a: ${r.error}` } : {}),
    deferred: DEFERRED,
  });
  expect(r.hashMatches).toBe(true);
  expect(r.transferred).toBe(true); // detached on both sides: a transfer, not a copy
  expect(r.toOffscreenMs).toBeLessThan(1000);
  expect(r.backMs).toBeLessThan(1000);
});
test('P0-6b: 300 MB via OPFS (tab createWritable, offscreen getFile stream)', async ({ spikePage }) => {
  const r = await spikePage({ check: 'transfer', mode: 'opfs', bytes: MB300 });
  await record('P0-6', {
    pass: r.hashMatches === true && r.totalMs < 5000,
    measured: `6b OPFS: 300 MiB in ${r.totalMs} ms (tab write ${r.writeMs} ms, offscreen stream and hash ${r.readMs} ms); SHA-256 ${r.hashMatches ? 'matches' : 'differs'}`,
    ...(r.error ? { note: `6b: ${r.error}` } : {}),
    deferred: DEFERRED,
  });
  expect(r.hashMatches).toBe(true);
  expect(r.totalMs).toBeLessThan(5000);
});
test('P0-6c: 300 MB via chrome.runtime.sendMessage does not arrive intact, as the spec assumes', async ({ spikePage }) => {
  // sendMessage JSON-serialises: an ArrayBuffer arrives as {} (receivedBytes null), or the call throws on the size limit
  const r = await spikePage({ check: 'transfer', mode: 'runtime', bytes: MB300 });
  await record('P0-6', {
    pass:
      r.hashMatches === false && (r.receivedBytes ?? 0) < MB300 && (r.receivedBytes === null || r.error !== null) && (r.error !== null || r.receivedAs !== '(no reply)'),
    measured:
      `6c runtime.sendMessage: the 300 MiB ArrayBuffer arrived as ${r.receivedAs} (receivedBytes ${r.receivedBytes}, error ${r.error ?? 'none'}) ` +
      `in ${r.totalMs} ms; small control message ${r.controlOk ? 'answered' : 'NOT answered'}`,
    deferred: DEFERRED,
  });
  expect(r.hashMatches).toBe(false);
  expect(r.receivedBytes ?? 0).toBeLessThan(MB300);
  expect(r.receivedBytes === null || r.error !== null).toBe(true);
  expect(r.error !== null || r.receivedAs !== '(no reply)').toBe(true); // without an error, the offscreen document must have replied
});
