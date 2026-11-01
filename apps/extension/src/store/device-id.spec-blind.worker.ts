// Test support only: one "context" (a tab, the store worker) that asks for the device id and reports it. Each worker is its own copy of
// the module, so several of them at once are the same race as several tabs opening on a fresh install.
/// <reference lib="webworker" />
import { ensureDeviceId } from './device-id';

self.onmessage = async () => {
  try {
    const id = await ensureDeviceId();
    const again = await ensureDeviceId();
    (self as unknown as Worker).postMessage({ ok: true, id, again });
  } catch (error) {
    (self as unknown as Worker).postMessage({ ok: false, error: String(error) });
  }
};
