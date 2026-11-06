// Regression walkthroughs for the TB6 fix round, slice C1 (R105, and the code-security critic's findings 1 and 2). The owner's
// rule: no network traffic except what the owner turns on. Every request that reaches Anthropic (here the replay double) is
// counted and read.
//
// 1. A "not sure" PDF that the first note saves is not the owner's choice for Claude: the first @Claude question asks "Send … to
//    Anthropic?" with Cancel focused, says "Waiting for you to confirm…" meanwhile, and Cancel sends nothing ("Not sent. Nothing was
//    charged."). After one Send, the next question in the tab does not ask again.
// 2. A "not sure" PDF that is not in the library (its save failed): after Send, the request holds only the passages. It offers no
//    tools and no web search, and a page tool Claude calls anyway reads nothing. The card number on page 7 never reaches the double.
// 3. The same PDF, with its page 7 readable: the R91 check finds the card number before anything leaves, and nothing is sent.
// 4. A save that lands while the dialog waits (another tab saves it: D9, text not searchable) never skips the last check.
// 5. R105b, judged per reading, not per tab (Phase 4 security read, N1 and N2): a reading a note saved asks after a reload and in a
//    second tab, and Cancel sends nothing. The dialog says the thread's earlier note goes too. After one Send, a reload does not
//    ask, and the reading behaves like any saved one (Claude may look up its pages). The Send is kept on this computer, and Forget
//    removes it: reopened and saved again by a note, the reading asks again.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeReplay } from '../support/claude-replay';
import { forceVerdict } from '../support/filter-verdict';
import { expect, hooks, test } from '../support/test';
import {
  agreementsKept, answerThenTool, bodiesHold, breakPageText, CARD, claudeLine, claudeRows, messages, paperWithCardOnPage7, plainAnswer, repliesSettle,
  scenario, sendDialog, setUpClaude, typeAndSend,
} from './support/claude';
import { WALKTHROUGH_DIR } from './support/fixtures.spec-blind';
import { chipOf, forgetThisPdf, saveFromChip } from './support/library-p3.spec-blind';
import {
  ATTENTION, SENTENCE_1, SENTENCE_3, cardWith, libraryId, openPaper, replyBox, selectPassage, startNote, waitSaved, type TlFixture,
} from './support/marks.spec-blind';
import type { Page } from '@playwright/test';
import { shot } from './support/takeover';

test.use({ networkGate: 'claude' });
test.setTimeout(150_000);

const CARD_FILE = '2h-paper-card-p7.pdf';
const CARD_PAPER: TlFixture = { name: 'card-p7', file: `walkthroughs/${CARD_FILE}`, page: 0, dir: 'ltr' };
const HARBOUR = { from: 'The fisherman unloads', to: 'market opens.' };

test.beforeAll(async () => {
  await writeFile(join(WALKTHROUGH_DIR, CARD_FILE), await paperWithCardOnPage7());
});

test('R105: a note saves a "not sure" PDF, and the first @Claude question still asks first; Cancel sends nothing', async ({ context, openViewer, server }, testInfo) => {
  await forceVerdict(context, 'unsure');
  const page = await openPaper(openViewer, server, ATTENTION);
  await expect(page.getByRole('button', { name: /^not sure/i }), 'the filter is not sure about this PDF').toBeVisible({ timeout: 30_000 });
  const replay = claudeReplay(server);
  await replay.attach(page);
  await setUpClaude(page);
  replay.use('ask-passage');

  await selectPassage(page, ATTENTION, SENTENCE_1);
  await startNote(page);
  await typeAndSend(page, '@Claude what does this sentence say?');
  await waitSaved(page); // the note saved the PDF (R67): that is not the owner's choice for Claude
  const dialog = sendDialog(page);
  await expect(dialog, 'the first question asks before anything is sent').toBeVisible({ timeout: 40_000 });
  await expect(dialog.getByRole('button', { name: 'Cancel' }), 'Cancel is the default').toBeFocused();
  // The note saved the PDF, so the dialog must not say it is not in the library (C3 follow-up, R105).
  await expect(dialog, 'it says what is true: the owner did not choose this PDF').toContainText(/you haven.t chosen to save this pdf yourself/i);
  await expect(dialog, 'and not "not in your library"').not.toContainText(/not in your library/i);
  await expect(claudeLine(page, /waiting for you to confirm/i), 'the reply says it waits for the owner').toBeVisible();
  await expect(claudeLine(page, /waiting for you to confirm/i).getByRole('button', { name: /stop/i }), 'with no Stop').toHaveCount(0);
  await shot(page, testInfo, 'ask-first-dialog');

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  const notSent = claudeLine(page, /not sent\. nothing was charged/i);
  await expect(notSent, 'Cancel leaves "Not sent. Nothing was charged."').toBeVisible();
  expect(messages(replay.requests()), 'Cancel sent nothing to Anthropic').toHaveLength(0);
  await shot(page, testInfo, 'cancel-not-sent');

  // Ask again: the same reply asks the same question once more. This time the owner says Send.
  await expect(notSent.getByRole('button', { name: /try again/i }), 'nothing went wrong, so no "Try again"').toHaveCount(0);
  await notSent.getByRole('button', { name: /^ask again$/i }).click();
  await expect(dialog, 'asking again asks first again').toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Send' }).click();
  await repliesSettle(page);
  const first = messages(replay.requests());
  expect(first, 'one request, after Send').toHaveLength(1);
  expect(first[0].toolNames, 'the first question offers no tools: only the passages the owner agreed to').toEqual([]);
  expect(first[0].webSearch, 'and no web search').toBeNull();

  // After one Send, a later question on this reading does not ask again.
  await cardWith(page, 'what does this sentence say?').click();
  const reply = replyBox(page);
  await reply.click();
  await typeAndSend(page, '@Claude and in one line?');
  await expect.poll(() => messages(replay.requests()).length, { timeout: 40_000 }).toBe(2);
  await expect(dialog, 'no second question').toHaveCount(0);
  await repliesSettle(page);
  await shot(page, testInfo, 'second-question-no-dialog');
});

test('Security 1: a "not sure" PDF not in the library sends only the pack; the card number on page 7 never reaches Anthropic', async ({ context, openViewer, server }, testInfo) => {
  await forceVerdict(context, 'unsure');
  const page = await openPaper(openViewer, server, CARD_PAPER);
  await expect(page.getByRole('button', { name: /^not sure/i })).toBeVisible({ timeout: 30_000 });
  const replay = claudeReplay(server);
  await replay.attach(page);
  await setUpClaude(page);
  // Claude answers by asking for page 7 (a client tool), then answers from what it was given.
  replay.use({ steps: [answerThenTool(scenario('ask-passage').steps![0], { name: 'get_pages', input: { pages: [7] } }), plainAnswer('The passages do not say more.')] });
  await breakPageText(page, true); // the note's save fails: the PDF stays out of the library

  await selectPassage(page, CARD_PAPER, HARBOUR);
  await startNote(page);
  await page.keyboard.type('@Claude what does this paper say?', { delay: 15 });
  await expect(chipOf(page), 'the save failed: the PDF is not in the library').toContainText(/couldn.t save/i, { timeout: 30_000 });
  await page.keyboard.press('Enter');
  const dialog = sendDialog(page);
  await expect(dialog).toBeVisible({ timeout: 40_000 });
  await expect(dialog, 'the dialog promises nothing else goes').toContainText(/nothing else is sent/i);
  await shot(page, testInfo, 'unsaved-dialog');
  await breakPageText(page, false); // every page reads again: page 7 could be read now
  await dialog.getByRole('button', { name: 'Send' }).click();
  await repliesSettle(page);

  const sent = messages(replay.requests());
  testInfo.annotations.push({ type: 'requests', description: JSON.stringify(sent.map((r) => ({ tools: r.toolNames, web: r.webSearch, searchResults: r.searchResultCount, messages: r.messageCount }))) });
  expect(sent.length, 'the question, then the answer to the tool call').toBe(2);
  for (const r of sent) {
    expect(r.toolNames, 'no client tools are offered').toEqual([]);
    expect(r.webSearch, 'and no web search').toBeNull();
    expect(r.searchResultCount, 'no page was read for Claude').toBe(0);
  }
  expect(bodiesHold(sent, CARD), 'the card number on page 7 never reaches Anthropic').toBe(false);
  expect(bodiesHold(sent, 'Payment details'), 'nor anything else of page 7').toBe(false);
  await shot(page, testInfo, 'unsaved-answered');
});

test('Security 1 (R91, at the turn): a "not sure" PDF not in the library, with a card number on page 7: Ask again refuses before anything leaves', async ({ context, openViewer, server }, testInfo) => {
  await forceVerdict(context, 'unsure');
  const page = await openPaper(openViewer, server, CARD_PAPER);
  await expect(page.getByRole('button', { name: /^not sure/i })).toBeVisible({ timeout: 30_000 });
  const replay = claudeReplay(server);
  await replay.attach(page);
  await setUpClaude(page);
  replay.use('ask-passage');
  await breakPageText(page, true); // the save fails, and nothing could read page 7 yet
  await selectPassage(page, CARD_PAPER, HARBOUR);
  await startNote(page);
  await page.keyboard.type('@Claude what does this paper say?', { delay: 15 });
  await expect(chipOf(page)).toContainText(/couldn.t save/i, { timeout: 30_000 });
  await page.keyboard.press('Enter');
  const dialog = sendDialog(page);
  await expect(dialog).toBeVisible({ timeout: 40_000 });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  const notSent = claudeLine(page, /not sent\. nothing was charged/i);
  await expect(notSent).toBeVisible();
  // Page 7 reads again. Ask again makes no new note, so no save runs: the turn's own R91 check reads every page.
  await breakPageText(page, false);
  await expect(notSent.getByRole('button', { name: /try again/i }), 'nothing went wrong, so no "Try again"').toHaveCount(0);
  await notSent.getByRole('button', { name: /^ask again$/i }).click();
  await expect(claudeLine(page, /card, bank or id numbers/i), 'the thread says why, in plain words').toBeVisible({ timeout: 40_000 });
  await expect(sendDialog(page), 'no dialog: there is nothing to agree to').toHaveCount(0);
  expect(messages(replay.requests()), 'nothing was sent').toHaveLength(0);
  expect(await libraryId(page), 'and nothing was saved').toBeNull();
  await shot(page, testInfo, 'card-refused-at-turn');
});

test('R105 and R91 (at the save): the Enter that saves finds the card number; the note asks Claude, so no save question, and the thread says why', async ({ context, openViewer, server }, testInfo) => {
  await forceVerdict(context, 'unsure');
  const page = await openPaper(openViewer, server, CARD_PAPER);
  await expect(page.getByRole('button', { name: /^not sure/i })).toBeVisible({ timeout: 30_000 });
  const replay = claudeReplay(server);
  await replay.attach(page);
  await setUpClaude(page);
  replay.use('ask-passage');
  await breakPageText(page, true);
  await selectPassage(page, CARD_PAPER, HARBOUR);
  await startNote(page);
  await page.keyboard.type('@Claude what does this paper say?', { delay: 15 });
  await expect(chipOf(page)).toContainText(/couldn.t save/i, { timeout: 30_000 });
  await breakPageText(page, false); // page 7 can be read: the check reads every page
  await page.keyboard.press('Enter');
  // The Enter tries the save again; R91 finds the card number, and the PDF is "not learning". The note asks Claude, so the save
  // question answers itself No (R105): nothing is kept, and the thread says why Claude does not answer.
  await expect.poll(async () => (await claudeRows(page)).map((r) => r.error ?? ''), { timeout: 40_000, message: 'the refusal is a row in the thread' }).toContainEqual(expect.stringMatching(/card, bank or id numbers/i));
  await expect(page.getByText(/save this pdf to keep your notes/i), 'no save question for Claude’s sake').toHaveCount(0);
  await cardWith(page, 'what does this paper say?').click();
  await expect(claudeLine(page, /card, bank or id numbers/i), 'the thread says why, in plain words').toBeVisible();
  await expect(sendDialog(page), 'no dialog: there is nothing to agree to').toHaveCount(0);
  expect(messages(replay.requests()), 'nothing was sent').toHaveLength(0);
  expect(await libraryId(page), 'and nothing was saved').toBeNull();
  await shot(page, testInfo, 'card-refused');
});

test('Security 2: the PDF is saved (D9) in another tab while the dialog waits: Send still sends nothing', async ({ context, openViewer, server }, testInfo) => {
  await forceVerdict(context, 'unsure');
  const a = await openPaper(openViewer, server, CARD_PAPER);
  await expect(a.getByRole('button', { name: /^not sure/i })).toBeVisible({ timeout: 30_000 });
  const replay = claudeReplay(server);
  await replay.attach(a);
  await setUpClaude(a);
  replay.use('ask-passage');
  await breakPageText(a, true); // the save fails, and the check before the dialog cannot read page 7 either
  await selectPassage(a, CARD_PAPER, HARBOUR);
  await startNote(a);
  await a.keyboard.type('@Claude what does this paper say?', { delay: 15 });
  await expect(chipOf(a)).toContainText(/couldn.t save/i, { timeout: 30_000 });
  await a.keyboard.press('Enter');
  const dialog = sendDialog(a);
  await expect(dialog).toBeVisible({ timeout: 40_000 });
  await breakPageText(a, false);

  // The owner saves the same PDF in another tab. R91 finds the card number: saved without searchable text (D9).
  const b = await openPaper(openViewer, server, CARD_PAPER);
  await expect(b.getByRole('button', { name: /^not sure/i })).toBeVisible({ timeout: 30_000 });
  await saveFromChip(b);
  const id = await waitSaved(b);
  await expect.poll(() => hooks(b).eval(async (h, doc) => (await h.store!.getDocument(doc as never))?.indexText ?? null, id), { timeout: 20_000 }).toBe(false);
  await expect.poll(() => hooks(a).eval((h) => h.save.state().kind), { timeout: 30_000, message: 'the first tab follows: saved' }).toBe('saved');
  await a.bringToFront();
  await shot(a, testInfo, 'saved-d9-dialog-still-open');

  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(claudeLine(a, /card, bank or id numbers/i), 'the last check reads the saved reading: it refuses').toBeVisible({ timeout: 30_000 });
  expect(messages(replay.requests()), 'nothing was sent').toHaveLength(0);
  expect((await claudeRows(a)).every((r) => r.status === 'error'), 'and no answer was written').toBe(true);
  await shot(a, testInfo, 'd9-refused');
});

/** The reloaded or newly opened tab is in front, has drawn its text, and knows the PDF is in the library. */
async function readyAndSaved(page: Page): Promise<void> {
  await page.bringToFront(); // a tab behind another one does not draw its notes
  await page.waitForSelector('[data-page-index="0"] span[data-start]', { timeout: 40_000 });
  await expect.poll(() => hooks(page).eval((h) => h.save.state().kind), { timeout: 30_000, message: 'the PDF is in the library' }).toBe('saved');
}

/**
 * A reply in the thread of the note that says `words`, typed and sent as the owner does. Where the margin shows numbered markers
 * instead of cards (R98: the cards do not fit), the owner opens the thread from its marker, `marker`.
 */
async function replyIn(page: Page, words: string | RegExp, reply: string, marker: number): Promise<void> {
  const card = cardWith(page, words).first();
  if (!(await card.isVisible())) await page.getByRole('button', { name: new RegExp(`^note ${marker}\\. open it in the notes panel`, 'i') }).click();
  await card.click();
  await replyBox(page).click();
  await typeAndSend(page, reply);
}

test('R105b: judged per reading: a reload and a second tab ask until one Send; then no more asking; after Forget it asks again', async ({ context, openViewer, server }, testInfo) => {
  test.setTimeout(240_000);
  await forceVerdict(context, 'unsure');
  const a = await openPaper(openViewer, server, ATTENTION);
  await expect(a.getByRole('button', { name: /^not sure/i }), 'the filter is not sure about this PDF').toBeVisible({ timeout: 30_000 });
  const replay = claudeReplay(server);
  await replay.attach(a);
  await setUpClaude(a);

  // A plain note saves the PDF. Its row says so: "Your first note saved it", which is not the owner's choice for Claude.
  await selectPassage(a, ATTENTION, SENTENCE_1);
  await startNote(a);
  await typeAndSend(a, 'a plain note to keep');
  const id = await waitSaved(a);
  const reasons = await hooks(a).eval(async (h, doc) => (await h.store!.getDocument(doc as never))?.saveReasons ?? null, id);
  expect(reasons, 'only the note saved it').toEqual(['Your first note saved it']);

  // 1. After a reload, the first @Claude question still asks. Cancel sends nothing.
  await a.reload();
  await readyAndSaved(a);
  replay.use('ask-passage');
  await a.keyboard.press('Escape');
  await selectPassage(a, ATTENTION, SENTENCE_3);
  await startNote(a);
  await typeAndSend(a, '@Claude what does this sentence say?');
  const dialogA = sendDialog(a);
  await expect(dialogA, 'a reload asks again').toBeVisible({ timeout: 40_000 });
  await expect(dialogA, 'it says what is true').toContainText(/you haven.t chosen to save this pdf yourself/i);
  expect(messages(replay.requests()), 'nothing is sent while the dialog asks').toHaveLength(0);
  await shot(a, testInfo, 'r105b-reload-asks');
  await dialogA.getByRole('button', { name: 'Cancel' }).click();
  await expect(claudeLine(a, /not sent\. nothing was charged/i), 'Cancel leaves "Not sent"').toBeVisible();
  expect(messages(replay.requests()), 'Cancel after a reload sent nothing').toHaveLength(0);

  // 2. A second tab asks too. Its question is a reply in that thread, so the dialog says the earlier note goes too (N2).
  const b = await openPaper(openViewer, server, ATTENTION);
  await readyAndSaved(b);
  await replyIn(b, 'what does this sentence say?', '@Claude and in one line?', 2);
  const dialogB = sendDialog(b);
  await expect(dialogB, 'a second tab asks too').toBeVisible({ timeout: 40_000 });
  await expect(dialogB, 'the earlier note in the thread goes too, and the dialog says so').toContainText(/your earlier note in this thread goes too\. nothing else is sent/i);
  expect(messages(replay.requests()), 'nothing is sent while the second tab asks').toHaveLength(0);
  await shot(b, testInfo, 'r105b-second-tab-asks');
  await dialogB.getByRole('button', { name: 'Cancel' }).click();
  const notSentB = claudeLine(b, /not sent\. nothing was charged/i);
  await expect(notSentB).toBeVisible();
  expect(messages(replay.requests()), 'Cancel in the second tab sent nothing').toHaveLength(0);
  expect(await agreementsKept(b), 'no Send, so nothing is kept').toBe(0);

  // The owner says Send once, in the second tab: only the pack goes (no tools), and the Send is kept on this computer.
  await notSentB.getByRole('button', { name: /^ask again$/i }).click();
  await expect(dialogB, 'Ask again asks first again').toBeVisible({ timeout: 20_000 });
  await dialogB.getByRole('button', { name: 'Send' }).click();
  await repliesSettle(b);
  const sent = messages(replay.requests());
  expect(sent, 'one request, after Send').toHaveLength(1);
  expect(sent[0].toolNames, 'the first answer has only the passages the owner agreed to').toEqual([]);
  expect(sent[0].webSearch, 'and no web search').toBeNull();
  expect(bodiesHold(sent, 'what does this sentence say?'), 'the earlier note went, as the dialog said').toBe(true);
  await expect.poll(() => agreementsKept(b), { message: 'the Send is kept for the reading' }).toBe(1);

  // 3. After that Send, a reload does not ask. The reading behaves like any saved one: Claude may look up its pages.
  await a.bringToFront();
  await a.reload();
  await readyAndSaved(a);
  replay.use({ steps: [answerThenTool(scenario('ask-passage').steps![0], { name: 'get_pages', input: { pages: [9] } }), plainAnswer('Page 9 says what it says.')] });
  await replyIn(a, 'what does this sentence say?', '@Claude and what about page 9?', 2);
  await expect.poll(() => messages(replay.requests()).length, { timeout: 40_000, message: 'it is sent without asking' }).toBe(3);
  await expect(sendDialog(a), 'no dialog after the Send').toHaveCount(0);
  await repliesSettle(a);
  const later = messages(replay.requests()).slice(1);
  expect(later[0].toolNames, 'the page tools are offered').toEqual(expect.arrayContaining(['get_pages']));
  expect(later[1].searchResultCount, 'and page 9 was read for Claude').toBeGreaterThan(0);
  await shot(a, testInfo, 'r105b-after-send-reload-no-dialog');

  // 4. Forget removes the Send with the reading. Reopened, and saved again by a note, the reading asks again.
  const { asked } = await forgetThisPdf(a);
  expect(asked, 'Forget asks first (the PDF has notes)').toBe(true);
  await expect.poll(async () => (await libraryId(a)) === null, { timeout: 30_000, message: 'the PDF is forgotten' }).toBe(true);
  await expect.poll(() => agreementsKept(a), { timeout: 10_000, message: 'Forget removes the Send' }).toBe(0);
  const count = messages(replay.requests()).length;
  const c = await openPaper(openViewer, server, ATTENTION);
  await expect(c.getByRole('button', { name: /^not sure/i }), 'not sure again').toBeVisible({ timeout: 30_000 });
  replay.use('ask-passage');
  await selectPassage(c, ATTENTION, SENTENCE_1);
  await startNote(c);
  await typeAndSend(c, '@Claude what does this sentence say?');
  await waitSaved(c); // the note saved it again: a new reading, which the owner has not said Send for
  const dialogC = sendDialog(c);
  await expect(dialogC, 'after Forget and reopening, it asks again').toBeVisible({ timeout: 40_000 });
  expect(messages(replay.requests()), 'nothing more was sent').toHaveLength(count);
  await shot(c, testInfo, 'r105b-after-forget-asks');
  await dialogC.getByRole('button', { name: 'Cancel' }).click();
  await expect(claudeLine(c, /not sent\. nothing was charged/i)).toBeVisible();
  expect(messages(replay.requests()), 'Cancel sent nothing').toHaveLength(count);
});
