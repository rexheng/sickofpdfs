// The learning filter's network gate (Phase 3 plan, S10: "an e2e opens an `unsure` PDF and sees zero requests beyond the
// PDF"). Asked for by the controller when S8 and S10 landed; written with S11, which wires the filter into the viewer.
//
// The MIT 14.01 handout, served under a neutral name from the test server, is the one research PDF the filter cannot decide
// on its content alone ("not sure", score +1). So the tie-breaker runs: the MiniLM model, its runtime and its worker are all
// files inside the extension. The fixture's network gate (support/test.ts, `enforce`) then checks the net log: nothing but
// the test server, which here serves only the PDF itself.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { TEST_ASSETS } from '../support/server';
import { waitForStore } from '../support/store-probe.spec-blind';
import { expect, hooks, test } from '../support/test';

test.setTimeout(120_000);

interface DecisionShape {
  verdict: string;
  rule?: string;
  score?: number;
  reasons: string[];
  signals?: { id: string; weight: number; label: string }[];
}

const decisionOf = (page: Page): Promise<DecisionShape | null> =>
  hooks(page).eval((h) => (h as unknown as { save?: { decision?(): DecisionShape | null } }).save?.decision?.() ?? null);

test('a "not sure" PDF: the tie-breaker runs inside the extension, and nothing but the PDF is requested', async ({ openViewer, server, context }) => {
  const bytes = await readFile(join(TEST_ASSETS, 'classifier/learning/handout-mit-14.01-f23-handout10.pdf'));
  server.mount('/offline/', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.byteLength, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return Promise.resolve();
  });
  const workers: string[] = [];
  let embedClosed = false;
  const watch = (p: Page): void => {
    p.on('worker', (w) => {
      workers.push(w.url());
      if (/embed/i.test(w.url())) w.on('close', () => (embedClosed = true));
    });
  };
  context.on('page', watch);

  const page = await openViewer(server.url('/offline/x7.pdf'));
  await waitForStore(page);
  let decision: DecisionShape | null = null;
  await expect.poll(async () => (decision = await decisionOf(page)), { timeout: 60_000, message: 'the filter decides' }).not.toBeNull();
  const d = decision as unknown as DecisionShape;

  // Without its link and name the handout scores between "save" and "don't save", so the model was asked.
  const model = d.signals?.find((s) => s.id === 'model');
  expect(model, `the tie-breaker nudged the score (decision: ${JSON.stringify({ verdict: d.verdict, rule: d.rule, score: d.score })})`).toBeDefined();
  expect(Math.abs(model!.weight), 'by at most 2 points').toBeLessThanOrEqual(2);
  expect(workers.some((u) => /embed/i.test(u)), `the model ran in its own worker in the viewer tab (workers: ${workers.join(', ')})`).toBe(true);
  expect(workers.every((u) => u.startsWith('chrome-extension://')), 'every worker is an extension file').toBe(true);
  await expect.poll(() => embedClosed, { message: 'and the worker is ended after its one use' }).toBe(true);
  // The fixture's network gate checks the whole net log after this test: only the test server, which served the PDF.
});
