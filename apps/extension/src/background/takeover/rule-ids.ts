/** Session rules made while the browser runs (the escape hatch, the sticky Referer) take their ids from here. */
const COUNTER_KEY = 'ruleIdCounter';
const FIRST_ID = 1000;

// Two callers in the same tick must not read the same number.
let queue: Promise<unknown> = Promise.resolve();

/** The next free session-rule id. The counter lives in `chrome.storage.session`, so it survives the service worker sleeping. */
export function allocateRuleId(): Promise<number> {
  const next = queue.then(async () => {
    const stored: unknown = (await chrome.storage.session.get(COUNTER_KEY))[COUNTER_KEY];
    const id = typeof stored === 'number' && stored >= FIRST_ID ? stored : FIRST_ID;
    await chrome.storage.session.set({ [COUNTER_KEY]: id + 1 });
    return id;
  });
  queue = next.catch(() => undefined);
  return next;
}
