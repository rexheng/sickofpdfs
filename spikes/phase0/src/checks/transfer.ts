// P0-6 transfer check: spike.html?check=transfer&mode=port|opfs|runtime&bytes=<n>
// The tab fills an ArrayBuffer of <bytes> with crypto.getRandomValues in 64 KiB slices and hashes it (SHA-256,
// hash-wasm). It then moves it to the offscreen document (entrypoints/offscreen/main.ts), which hashes what arrives:
// - port: over a MessagePort that the service worker brokers (entrypoints/background.ts). The buffer is
//   transferred, and the offscreen document echoes it back, transferred; the tab hashes what comes back.
// - opfs: the tab writes an OPFS file (createWritable) in 16 MiB slices; the offscreen document reads it as a
//   stream (getFile). One write() of the whole 300 MB took 1.0–4.0 s and 64 KiB writes (a fetch stream's
//   chunks) about 6 s, against 1.05–1.44 s in 16 MiB slices (docs/spikes/phase0-report.md, P0-6).
// - runtime: chrome.runtime.sendMessage({buffer}). It JSON-serialises, so the bytes are not expected to arrive.
// Times are the tab's performance.now(), in ms. toOffscreenMs and backMs are upper bounds: each also holds one
// small control message (the offscreen document's 'got' ack, or the tab's 'send-back' request).
import { createSHA256 } from 'hash-wasm';
import { browser } from 'wxt/browser';
import { withTimeout } from './render';

const SLICE = 64 * 1024; // the most crypto.getRandomValues fills in one call
const OPFS_WRITE_SLICE = 16 * 1024 * 1024;
const STEP_TIMEOUT_MS = 30_000;
const ms = (from: number, to = performance.now()) => Math.round((to - from) * 10) / 10;

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await createSHA256();
  hash.init();
  hash.update(bytes);
  return hash.digest('hex');
}

/** The next message of `type` on the port; an {type:'error'} message rejects. */
function next(port: MessagePort, type: string): Promise<any> {
  const message = new Promise((resolve, reject) => {
    const onMessage = ({ data }: MessageEvent) => {
      if (data?.type !== type && data?.type !== 'error') return;
      port.removeEventListener('message', onMessage);
      if (data.type === 'error') reject(new Error(data.error));
      else resolve(data);
    };
    port.addEventListener('message', onMessage);
  });
  return withTimeout(message, STEP_TIMEOUT_MS, `offscreen "${type}"`);
}

/** A MessagePort to the offscreen document, brokered by the service worker, after a hello round trip. */
async function connectOffscreen(): Promise<MessagePort> {
  const { port1, port2 } = new MessageChannel();
  port1.start();
  const worker = (await navigator.serviceWorker.ready).active;
  if (!worker) throw new Error('the extension has no active service worker');
  const hello = next(port1, 'hello');
  worker.postMessage({ type: 'connect-offscreen' }, [port2]);
  port1.postMessage({ type: 'hello' });
  await hello;
  return port1;
}

export async function run(params: URLSearchParams) {
  const mode = params.get('mode') ?? '';
  const bytes = Number(params.get('bytes'));
  if (!['port', 'opfs', 'runtime'].includes(mode)) throw new Error(`unknown mode "${mode}"`);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`bad ?bytes=${params.get('bytes')}`);

  const r = {
    mode,
    bytes,
    hashMatches: false,
    /** The byte length the offscreen document received (null when no ArrayBuffer arrived). */
    receivedBytes: null as number | null,
    error: null as string | null,
    toOffscreenMs: null as number | null,
    backMs: null as number | null,
    /** port: send to echo received, with the offscreen hash; opfs: write start to the offscreen hash; runtime: the sendMessage call. */
    totalMs: null as number | null,
    fillMs: 0,
    hashMs: 0,
    sourceSha256: '',
    offscreenSha256: null as string | null,
    /** port: the tab's hash of the echoed buffer. */
    backSha256: null as string | null,
    /** port: the sender's ArrayBuffer was detached by each postMessage (a transfer, not a copy). */
    transferred: null as boolean | null,
    /** opfs: createWritable, the writes and close in the tab; the offscreen document's getFile stream and hash. */
    writeMs: null as number | null,
    readMs: null as number | null,
    /** runtime: what arrived in place of the buffer; whether a small message got its answer first. */
    receivedAs: null as string | null,
    controlOk: null as boolean | null,
  };

  const tFill = performance.now();
  const buffer = new ArrayBuffer(bytes);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < bytes; i += SLICE) crypto.getRandomValues(view.subarray(i, i + SLICE));
  r.fillMs = ms(tFill);
  const tHash = performance.now();
  r.sourceSha256 = await sha256(view);
  r.hashMs = ms(tHash);

  const port = await connectOffscreen(); // the offscreen document exists and listens from here on
  if (mode === 'runtime') {
    // A small runtime message the offscreen document must answer first, so what happens to the buffer is about the buffer.
    const control = await withTimeout(browser.runtime.sendMessage({ type: 'p0-6:ping' }), STEP_TIMEOUT_MS, 'runtime ping').catch(() => null);
    r.controlOk = control?.pong === true;
    if (!r.controlOk) throw new Error('the offscreen document did not answer a small runtime message, so this mode would measure nothing');
  }
  try {
    if (mode === 'port') {
      const got = next(port, 'got');
      const hashed = next(port, 'hashed');
      const t0 = performance.now();
      port.postMessage({ type: 'echo', buffer }, [buffer]);
      const sentDetached = buffer.byteLength === 0;
      r.receivedBytes = (await got).bytes;
      r.toOffscreenMs = ms(t0);
      r.offscreenSha256 = (await hashed).sha256;
      const echoed = next(port, 'echo');
      const sentBack = next(port, 'sent-back');
      const t2 = performance.now();
      port.postMessage({ type: 'send-back' });
      const back: ArrayBuffer = (await echoed).buffer;
      r.backMs = ms(t2);
      r.totalMs = ms(t0);
      r.transferred = sentDetached && (await sentBack).detached === true;
      r.backSha256 = await sha256(new Uint8Array(back));
      r.hashMatches = r.offscreenSha256 === r.sourceSha256 && r.backSha256 === r.sourceSha256;
    } else if (mode === 'opfs') {
      const root = await navigator.storage.getDirectory();
      const name = `p0-6-${crypto.randomUUID()}.bin`;
      try {
        const t0 = performance.now();
        const writable = await (await root.getFileHandle(name, { create: true })).createWritable();
        for (let i = 0; i < bytes; i += OPFS_WRITE_SLICE) await writable.write(view.subarray(i, i + OPFS_WRITE_SLICE));
        await writable.close();
        r.writeMs = ms(t0);
        const read = next(port, 'opfs-read');
        port.postMessage({ type: 'opfs-read', name });
        const result = await read;
        r.totalMs = r.toOffscreenMs = ms(t0);
        r.readMs = result.readMs;
        r.receivedBytes = result.bytes;
        r.offscreenSha256 = result.sha256;
        r.hashMatches = result.bytes === bytes && result.sha256 === r.sourceSha256;
      } finally {
        await root.removeEntry(name).catch(() => undefined);
      }
    } else {
      const t0 = performance.now();
      let reply: { receivedBytes: number | null; receivedAs: string; sha256: string | null } | undefined;
      try {
        reply = await withTimeout(browser.runtime.sendMessage({ type: 'p0-6:runtime', buffer }), STEP_TIMEOUT_MS * 2, 'runtime sendMessage');
      } catch (err) {
        r.error = err instanceof Error ? err.message : String(err);
      }
      r.totalMs = r.toOffscreenMs = ms(t0);
      r.receivedBytes = reply?.receivedBytes ?? null;
      r.receivedAs = reply?.receivedAs ?? '(no reply)';
      r.offscreenSha256 = reply?.sha256 ?? null;
      r.hashMatches = r.offscreenSha256 === r.sourceSha256;
    }
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  } finally {
    port.close();
  }
  return r;
}
