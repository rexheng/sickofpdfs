// The app's own Android plugin (android/app/src/main/java/com/sickofpdfs/reader/SopPlatformPlugin.java): the PDFs Android hands
// the app ("Open with", Share), the system file picker, the Back button and links that leave the app. Nothing here goes to the
// network.
import { Capacitor, type PluginListenerHandle, registerPlugin } from '@capacitor/core';

/** A PDF Android gave the app, copied into the app's cache until the viewer has read it (then `release` removes the copy). */
export interface IncomingPdf {
  /** The copy's id: the viewer's address carries it (`viewer.html?incoming=<id>`). */
  id: string;
  /** The file's own name, as the app that sent it gave it ("Week 3 reading.pdf"). */
  name: string;
  size: number;
  /** The copy's path on the phone. `webUrl(path)` is the address the WebView reads it from. */
  path: string;
}

interface SopPlatformPlugin {
  /** The PDF that started the app or reached it since, if one waits. It is handed out once. */
  takeIncoming(): Promise<{ pdf: IncomingPdf | null }>;
  /** A PDF handed out earlier, by id; null once it was released. */
  incoming(o: { id: string }): Promise<{ pdf: IncomingPdf | null }>;
  /** Removes the cached copy of a PDF the viewer has read. */
  release(o: { id: string }): Promise<void>;
  /** Android's file picker for PDFs. null when the person backed out. */
  pickPdf(): Promise<{ pdf: IncomingPdf | null }>;
  /** Opens a web link in the phone's browser (the owner clicked it). */
  openExternal(o: { url: string }): Promise<void>;
  /** Goes back a page in the app, or leaves the app when there is none. */
  goBack(): Promise<void>;
  /** Colours the status and navigation bars: dark for the viewer, light for the library. */
  setBars(o: { dark: boolean }): Promise<void>;
  /**
   * R112: whether the ElevenReader app is on the phone (`installed`) and takes a shared PDF (`canShare`). Asked of Android each
   * time, by the app's package id.
   */
  elevenReader(): Promise<{ installed: boolean; canShare: boolean }>;
  /** Starts a PDF to share to ElevenReader: a new file in the app's cache, with this name. */
  shareBegin(o: { name: string }): Promise<{ id: string }>;
  /** Adds the next piece of the PDF (base64). */
  shareChunk(o: { id: string; data: string }): Promise<void>;
  /** Hands the PDF to ElevenReader with Android's share. Rejects when ElevenReader would not take it. */
  shareEnd(o: { id: string }): Promise<void>;
  /** The pages hold a text selection or not: Android's own Copy/Share bar is kept closed over one (MainActivity). */
  setPageSelection(o: { on: boolean }): Promise<void>;
  /** About the phone's web engine: for the app check in Settings. */
  webViewInfo(): Promise<{ version: string; packageName: string }>;
  addListener(event: 'incoming', cb: (e: { pdf: IncomingPdf }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'back', cb: () => void): Promise<PluginListenerHandle>;
}

export const SopPlatform = registerPlugin<SopPlatformPlugin>('SopPlatform');

/** True inside the Android app; false in a desktop browser (the web build, Playwright). */
export const isNativeApp = (): boolean => Capacitor.isNativePlatform();

/** The address the WebView reads a file of the app's own storage from. */
export const webUrl = (path: string): string => Capacitor.convertFileSrc(path);
