// R104: after the owner replaces the extension's files and presses Reload, Home says once "Updated to test build N. Your library is safe."
//
// How it knows: the build's manifest has `version_name` ("Test build 6"; the release script sets it, see wxt.config.ts). The library
// keeps the one it last saw in chrome.storage.local. Different, and a library with readings in it: say it, and remember the new one,
// so it shows once. A first-ever run (no stored name, nothing in the library) is not an update and stays quiet. An older build that
// kept no name (test builds 1 to 5) counts as an update when it has readings. A build with no `version_name` (a dev build) says nothing.
import { useEffect, useState } from 'react';

const SEEN_KEY = 'sop.build.seen';

/** The text to show, or null. `hasReadings` is null until the library has answered; the check waits for it. */
export function useUpdatedNote(hasReadings: boolean | null): [string | null, () => void] {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (hasReadings === null) return;
    const current = chrome.runtime.getManifest().version_name;
    if (current === undefined) return;
    void (async () => {
      const seen: unknown = (await chrome.storage.local.get(SEEN_KEY))[SEEN_KEY];
      if (seen === current) return;
      await chrome.storage.local.set({ [SEEN_KEY]: current });
      if (seen === undefined && !hasReadings) return;
      setText(`Updated to ${current.charAt(0).toLowerCase()}${current.slice(1)}. Your library is safe.`);
    })().catch(() => {});
  }, [hasReadings]);
  return [text, () => setText(null)];
}
