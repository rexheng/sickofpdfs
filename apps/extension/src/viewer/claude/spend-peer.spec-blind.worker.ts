// Test support only: a second "tab" for the spend test. It is a separate JavaScript context with its own IndexedDB connection,
// which is what two viewer tabs are. It loads the real spend module and adds spend when told to.
/// <reference lib="webworker" />
import { addSpend } from './spend';

type Msg = { type: 'go'; count: number; amount: number };

self.onmessage = async (e: MessageEvent<Msg>) => {
  try {
    await Promise.all(Array.from({ length: e.data.count }, () => addSpend(e.data.amount)));
    self.postMessage({ type: 'done' });
  } catch (error) {
    self.postMessage({ type: 'failed', message: String(error) });
  }
};
self.postMessage({ type: 'ready' });
