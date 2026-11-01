// The test build's switch for the learning filter's verdict (apps/extension/src/viewer/filter/async-filter.ts,
// `FORCE_VERDICT_KEY`): with it, every PDF opened in this browser gets that verdict, so a walkthrough about the moment a
// "not sure" PDF is saved can use any paper. A production build has no such switch. The owner's own "Never save this
// file" still comes first.
import type { BrowserContext } from '@playwright/test';

export const FORCE_VERDICT_KEY = 'sop.test.filterVerdict';

/** From now on, every extension page in `context` forces `verdict` (set before the viewer's own scripts run). */
export async function forceVerdict(context: BrowserContext, verdict: 'unsure' | 'not-learning' | 'learning'): Promise<void> {
  await context.addInitScript(
    ([key, value]) => {
      if (location.protocol === 'chrome-extension:') localStorage.setItem(key, value);
    },
    [FORCE_VERDICT_KEY, verdict] as const,
  );
}
