// The web's version of apps/mobile/src/platform/native.ts, for the phone viewer files the web reuses (vite.config.ts,
// PHONE_PLATFORM). A web page is never the Android app, so nothing here is ever called.
export const isNativeApp = (): boolean => false;

const nothing = (): Promise<never> => Promise.reject(new Error('not the phone app'));

/** Every call refuses: the phone files only call it inside the app (`isNativeApp()`). */
export const SopPlatform = {
  setPageSelection: nothing,
  elevenReader: nothing,
  shareBegin: nothing,
  shareChunk: nothing,
  shareEnd: nothing,
};
