// The offscreen document: the receiving end of P0-6's transfers (src/checks/transfer.ts is the tab's end).
// It hashes (SHA-256, hash-wasm) whatever it receives.
//
// A MessagePort to a tab arrives from the service worker as {type:'port'} with ports[0]. On it:
//   ← {type:'hello'}                → {type:'hello'}
//   ← {type:'echo', buffer}         → {type:'got', bytes} at once, then {type:'hashed', sha256}; the buffer is kept
//   ← {type:'send-back'}            → {type:'echo', buffer} (the kept buffer, transferred), then {type:'sent-back', detached}
//   ← {type:'opfs-read', name}      → {type:'opfs-read', bytes, sha256, readMs}: the OPFS file, read as a stream
//   any failure                     → {type:'error', error}
// chrome.runtime.onMessage:
//   {type:'p0-6:ping'}              → {pong: true}
//   {type:'p0-6:runtime', buffer}   → {receivedBytes, receivedAs, sha256}: what arrived in place of the buffer
import { createSHA256 } from 'hash-wasm';
import { browser } from 'wxt/browser';

async function sha256(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<{ sha256: string; bytes: number }> {
  const hash = await createSHA256();
  hash.init();
  let bytes = 0;
  for await (const chunk of chunks) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

function serve(port: MessagePort): void {
  let held: ArrayBuffer | null = null;
  port.onmessage = async ({ data }: MessageEvent) => {
    try {
      switch (data?.type) {
        case 'hello':
          port.postMessage({ type: 'hello' });
          return;
        case 'echo': {
          if (!(data.buffer instanceof ArrayBuffer)) throw new Error('echo without an ArrayBuffer');
          held = data.buffer;
          port.postMessage({ type: 'got', bytes: data.buffer.byteLength });
          port.postMessage({ type: 'hashed', ...(await sha256([new Uint8Array(data.buffer)])) });
          return;
        }
        case 'send-back': {
          if (!held) throw new Error('send-back before echo');
          const buffer = held;
          held = null;
          port.postMessage({ type: 'echo', buffer }, [buffer]);
          port.postMessage({ type: 'sent-back', detached: buffer.byteLength === 0 });
          return;
        }
        case 'opfs-read': {
          const t0 = performance.now();
          const root = await navigator.storage.getDirectory();
          const file = await (await root.getFileHandle(String(data.name))).getFile();
          const result = await sha256(streamChunks(file.stream()));
          port.postMessage({ type: 'opfs-read', ...result, readMs: Math.round((performance.now() - t0) * 10) / 10 });
          return;
        }
        default:
          throw new Error(`unknown message ${JSON.stringify(data?.type)}`);
      }
    } catch (err) {
      port.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  };
}

navigator.serviceWorker.onmessage = (e: MessageEvent) => {
  const port = e.ports[0];
  if (e.data?.type === 'port' && port) serve(port);
};

/** What arrived in place of an ArrayBuffer, for the record. */
function describeValue(v: unknown): string {
  if (v instanceof ArrayBuffer) return `an ArrayBuffer of ${v.byteLength} bytes`;
  if (v === undefined) return 'undefined (the field was dropped)';
  const json = JSON.stringify(v);
  return `${v === null ? 'null' : typeof v} ${json.length > 40 ? `${json.slice(0, 40)}…` : json}`;
}

browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message?.type === 'p0-6:ping') {
    sendResponse({ pong: true });
    return false;
  }
  if (message?.type !== 'p0-6:runtime') return false;
  const buffer: unknown = message.buffer;
  const reply = { receivedBytes: buffer instanceof ArrayBuffer ? buffer.byteLength : null, receivedAs: describeValue(buffer), sha256: null as string | null };
  if (!(buffer instanceof ArrayBuffer)) {
    sendResponse(reply);
    return false;
  }
  sha256([new Uint8Array(buffer)]).then(
    (h) => sendResponse({ ...reply, sha256: h.sha256 }),
    (err) => sendResponse({ ...reply, error: String(err) }),
  );
  return true; // sendResponse is called later
});
