import { describe, expect, it } from 'vitest';
import { isHeaderConditionSupported, type DnrLike } from './feature-check';

// Chrome 123 to 127 silently ignore a `responseHeaders` condition, so a redirect rule written with one would redirect
// EVERY page. Chrome 128 and newer take the condition; before 128 the same call is rejected as an unknown key. The
// probe asks Chrome with one session rule (id 123456), and the takeover only uses the rules when it passes.

type Update = Parameters<DnrLike['updateSessionRules']>[0];

/** A browser's session rules. `knowsResponseHeaders` false behaves as Chrome before 128: such a rule is rejected. */
function fakeDnr(knowsResponseHeaders: boolean) {
  const rules = new Map<number, unknown>();
  const calls: Update[] = [];
  const dnr: DnrLike = {
    updateSessionRules(options: Update) {
      calls.push(options);
      for (const rule of options.addRules ?? []) {
        if (!knowsResponseHeaders && 'responseHeaders' in (rule.condition as object)) return Promise.reject(new Error('Rule with id 123456 has an invalid condition: responseHeaders'));
        if (rules.has(rule.id)) return Promise.reject(new Error(`Rule with id ${rule.id} does not have a unique ID.`));
      }
      for (const id of options.removeRuleIds ?? []) rules.delete(id);
      for (const rule of options.addRules ?? []) rules.set(rule.id, rule);
      return Promise.resolve();
    },
  };
  return { dnr, rules, calls };
}

describe('isHeaderConditionSupported', () => {
  it('is true when the browser takes a responseHeaders condition, and leaves no probe rule behind', async () => {
    const { dnr, rules, calls } = fakeDnr(true);
    expect(await isHeaderConditionSupported(dnr)).toBe(true);
    expect([...rules.keys()], 'rules left in the browser').toEqual([]);
    expect(calls[0]?.addRules?.map((r) => r.id), 'the probe rule is id 123456').toEqual([123456]);
    expect(calls.at(-1)?.removeRuleIds, 'and it is removed').toEqual([123456]);
  });

  it('is false, and does not throw, when the browser rejects the condition (Chrome before 128)', async () => {
    const { dnr, rules } = fakeDnr(false);
    expect(await isHeaderConditionSupported(dnr)).toBe(false);
    expect([...rules.keys()], 'rules left in the browser').toEqual([]);
  });

  it('probes with a responseHeaders condition, the thing the takeover rules depend on', async () => {
    const { dnr, calls } = fakeDnr(true);
    await isHeaderConditionSupported(dnr);
    const probe = calls[0]?.addRules?.[0];
    expect(probe?.condition, 'the probe condition').toHaveProperty('responseHeaders');
  });
});
