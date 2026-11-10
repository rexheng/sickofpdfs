// The web's version of apps/mobile/src/platform/app-events.ts, for the phone viewer files the web reuses: where "Back to
// library" goes when the viewer is the first page of the tab.
import { webBackHref } from '../back';

export const homeUrl = (): string => webBackHref();
