// Helpers for the @Claude privacy walkthroughs (TB6 fix round, slice C1, R105). The Claude calls go to the recorded-response
// double (e2e/support/claude-replay.ts); a test counts what reached it. No real key is ever used: keys are built at run time and
// are obvious fakes.
import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { CLAUDE_FIXTURES, type ClaudeRequestRecord, type Scenario, type ScenarioStep } from '../../support/claude-replay';
import { expect, hooks, seedSecret } from '../../support/test';

/** A fake key, built at run time so that no key-shaped text is written in the repo. */
export const fakeKey = (): string => ['sk', 'ant', 'fake', 'c1', Math.random().toString(36).slice(2, 10), 'z'.repeat(40)].join('-');

export function scenario(name: string): Scenario {
  return JSON.parse(readFileSync(`${CLAUDE_FIXTURES}${name}.json`, 'utf8')) as Scenario;
}

/** The owner's model choices, as Settings → Claude stores them, from the double's model list (a haiku and an opus line). */
export async function setUpClaude(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  const list = (scenario('models-default').models as { data: Record<string, unknown>[] }).data;
  const choice = (line: string) => {
    const m = list.find((x) => x.line === line)!;
    return { id: m.id, displayName: m.display_name, line: m.line, imageInput: true, webSearchTool: 'web_search_20250305', maxInputTokens: 200_000, checkedAt: Date.now() };
  };
  await seedSecret(page, fakeKey());
  await hooks(page).eval(
    async (h, a) => {
      const s = h.store!;
      await s.setSetting('claude.model.default', a.def);
      await s.setSetting('claude.model.thinkHarder', a.hard);
      for (const [k, v] of Object.entries(a.extra)) await s.setSetting(k, v);
    },
    { def: choice('haiku'), hard: choice('opus'), extra },
  );
}

/** Claude's rows in the open PDF's thread state: status, words, and the error line. */
export async function claudeRows(page: Page): Promise<{ id: string; status: string; role: string | null; body: string; error: string | null; draftOfTab: string | null }[]> {
  return hooks(page).eval((h) =>
    h.annotations!.state().comments.filter((c) => c.author === 'claude').map((c) => {
      const m = c.meta as { status?: string; role?: string | null; error?: { message: string } | null };
      return { id: c.id, status: m.status ?? '', role: m.role ?? null, body: c.body, error: m.error?.message ?? null, draftOfTab: c.draftOfTab };
    }),
  );
}

/** The Messages requests that reached the double. */
export const messages = (records: ClaudeRequestRecord[]): ClaudeRequestRecord[] => records.filter((r) => r.path === '/v1/messages');

/** Whether any request body holds `needle` anywhere (a page's words, a card number). */
export const bodiesHold = (records: ClaudeRequestRecord[], needle: string): boolean => records.some((r) => JSON.stringify(r.body).includes(needle));

/** The "Send … to Anthropic?" question (R105). */
export const sendDialog = (page: Page): Locator => page.getByRole('dialog').filter({ hasText: /to anthropic\?/i });

/** A Claude row in the thread whose words are `text`. */
export const claudeLine = (page: Page, text: RegExp): Locator => page.locator('[data-claude-status]').filter({ hasText: text });

/**
 * The first step of a scenario, changed so the answer also calls a client tool (`stop_reason: tool_use`): what Claude does when the
 * passages do not answer. The text before the call is kept.
 */
export function answerThenTool(base: ScenarioStep, tool: { name: string; input: unknown }): ScenarioStep {
  const events = JSON.parse(JSON.stringify(base.events ?? [])) as { data: Record<string, unknown> }[];
  // Citations point at the request's blocks; a request that holds fewer cannot be cited, so the tool round's text has none.
  for (const e of events) {
    const delta = e.data.delta as Record<string, unknown> | undefined;
    if (delta?.type === 'citations_delta') e.data = { type: 'ping' };
  }
  const md = events.findIndex((e) => e.data.type === 'message_delta');
  const index = Math.max(-1, ...events.map((e) => (typeof e.data.index === 'number' ? e.data.index : -1))) + 1;
  events.splice(
    md,
    0,
    { data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_c1_${index}`, name: tool.name, input: {} } } },
    { data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } } },
    { data: { type: 'content_block_stop', index } },
  );
  const delta = events[events.findIndex((e) => e.data.type === 'message_delta')];
  (delta.data.delta as Record<string, unknown>).stop_reason = 'tool_use';
  return { events };
}

/** A plain one-line answer with no citations, for the requests after a tool round. */
export function plainAnswer(text: string): ScenarioStep {
  return {
    events: [
      { data: { type: 'message_start', message: { id: 'msg_c1', type: 'message', role: 'assistant', model: '$model', content: [], stop_reason: null, usage: { input_tokens: 900, output_tokens: 1 } } } },
      { data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
      { data: { type: 'content_block_stop', index: 0 } },
      { data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } } },
      { data: { type: 'message_stop' } },
    ],
  };
}

/** Types a question in the open note box and sends it, as the owner does. */
export async function typeAndSend(page: Page, words: string): Promise<void> {
  await page.keyboard.type(words, { delay: 15 });
  await page.keyboard.press('Enter');
}

/**
 * A 12-page "paper" whose page 7 holds a card number and an IBAN (the same shape as the filter walkthrough's): R91 finds them
 * only by reading every page.
 */
export async function paperWithCardOnPage7(): Promise<Uint8Array> {
  const prose = (i: number): string[] => [
    `Part ${i}`,
    'The fisherman unloads the quay and the harbour wall at dawn, before the market opens.',
    'The boats come back with the tide, and the nets are dried along the beach in the afternoon.',
    'In winter the harbour is quiet, and the town mends its boats and its houses for the spring.',
    'The old lighthouse keeper writes down the weather, the tides and the boats that come and go.',
  ];
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 12; i++) {
    const lines =
      i === 1
        ? ['arXiv:2301.12345v2 [cs.LG] 3 Feb 2023', 'Notes on a small harbour town', 'Jane Example', ...prose(1).slice(1)]
        : i === 7
          ? ['Appendix C. Payment details', 'Card number 4111 1111 1111 1111', 'IBAN GB82 WEST 1234 5698 7654 32']
          : i === 12
            ? ['References', 'A. Author. Harbour towns. Journal of Things, 2020.', 'B. Writer. Small boats. Journal of Stuff, 2019.']
            : prose(i);
    const p = doc.addPage([595, 842]);
    lines.forEach((t, k) => p.drawText(t, { x: 50, y: 780 - k * 22, size: 12, font }));
  }
  return doc.save();
}

/** The card number on page 7 of `paperWithCardOnPage7`, as the double would see it in a request. */
export const CARD = '4111 1111 1111 1111';

/**
 * Makes this tab's saves fail while `on` (pages 3 to 8 cannot be read, as when the engine stumbles), so the PDF stays "not sure"
 * and not in the library: the path where only the owner's Send lets anything go. Off again, every page reads as usual.
 */
export async function breakPageText(page: Page, on: boolean): Promise<void> {
  await hooks(page).eval((h, value) => {
    const g = globalThis as Record<string, unknown>;
    g.__c1Break = value;
    const b = h.backend as unknown as { getPageText(doc: unknown, i: number): Promise<string>; __c1Real?: (doc: unknown, i: number) => Promise<string> };
    if (b.__c1Real === undefined) {
      const real = b.getPageText.bind(b);
      b.__c1Real = real;
      b.getPageText = (doc, i) => (g.__c1Break === true && i >= 2 && i < 8 ? Promise.reject(new Error('engine-failed: test')) : real(doc, i));
    }
  }, on);
}

/** Waits for the reply to settle: no Claude row is pending or streaming. */
export async function repliesSettle(page: Page, timeout = 60_000): Promise<void> {
  await expect.poll(async () => (await claudeRows(page)).every((r) => r.status === 'done' || r.status === 'error') && (await claudeRows(page)).length > 0, { timeout }).toBe(true);
}
