// "Listen with ElevenReader" (R112): the open PDF goes to the ElevenReader app, to be read aloud. Only when the owner taps the
// menu row; nothing is sent before.
// - ElevenReader installed and taking PDFs (checked on the phone each time, by its package id): Android's share goes straight
//   to it, with the PDF. The PDF is written to the app's cache for ElevenReader to read; the copy is deleted the next time the
//   app starts, or at the next share.
// - Otherwise (not installed, or in a browser): the owner's ElevenReader student offer opens in the phone's browser.
import { readRuntime } from '@ext/viewer/runtime';
import { ELEVENREADER_STUDENT_URL } from '@sop/core';
import { navigate } from '../platform/chrome-shim';
import { isNativeApp, SopPlatform } from '../platform/native';

/** The PDF crosses to the Android side in pieces this big (a multiple of 3, so each piece is whole base64). */
const CHUNK = 3 * 1024 * 1024;

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((typeof reader.result === 'string' ? reader.result : '').replace(/^data:[^,]*,/u, ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

function openOffer(): void {
  navigate(ELEVENREADER_STUDENT_URL);
}

export async function listenWithElevenReader(): Promise<void> {
  const doc = readRuntime().doc?.() ?? null;
  if (!isNativeApp() || doc === null) return openOffer();
  const { canShare } = await SopPlatform.elevenReader().catch(() => ({ canShare: false }));
  if (!canShare) return openOffer();
  try {
    const { blob, displayName } = doc.loaded;
    const { id } = await SopPlatform.shareBegin({ name: displayName });
    for (let at = 0; at < blob.size; at += CHUNK) await SopPlatform.shareChunk({ id, data: await base64(blob.slice(at, at + CHUNK)) });
    await SopPlatform.shareEnd({ id });
  } catch (e) {
    console.warn('sickofpdfs: the PDF could not be shared to ElevenReader', e instanceof Error ? e.message : String(e));
    openOffer();
  }
}
