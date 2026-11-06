// The client tools (contract §6 `ClientTool`): when the passages Claude was given do not answer the question, it can ask the viewer
// to look further in THIS PDF. They run here, in the viewer tab, and only read the open PDF:
// - `search_document`: up to 3 passages for some words (the same passage search as the pack);
// - `get_pages`: the text of up to 3 whole pages, one paragraph per block;
// - `get_figure`: a figure by its label, as a picture drawn here plus the text inside it and its caption.
//
// Passages go back as `search_result` blocks, so Claude can cite them and their chips land on the paragraph. A figure goes back as a
// plain picture and text (search_result blocks hold text only, and a tool result cannot mix the two kinds).
//
// Every result counts against the turn's budget (plan §3): 6,000 tokens and 3 calls by default, 15,000 tokens and 5 calls for Think
// harder. Past it, the tool answers that the limit was reached, and Claude answers with what it has. The tool input is Claude's output,
// so it is checked, never trusted.
import {
  encodeRegionImage, passageSpans, searchResultFor, type ClientTool, type FigurePack, type ModelChoice, type ModelRole, type Passage,
} from '@sop/core';
import { buildFigurePack, figuresNamedIn } from './figure-pack';
import type { ContextBuilder } from './context';

/** Plan §3: what the client tools may add in one turn. */
export const TOOL_BUDGET: Readonly<Record<ModelRole, { tokens: number; calls: number }>> = {
  'default': { tokens: 6000, calls: 3 },
  'think-harder': { tokens: 15_000, calls: 5 },
};

const SEARCH_RESULTS = 3;
const SEARCH_TOKENS = 1200;
const MAX_PAGES = 3;
const PAGE_MAX_TOKENS = 2500;

type Block = { type: string; [key: string]: unknown };

/** One tool call Claude made: a `tool_use` block of its message. */
export interface ToolCall { id: string; name: string; input: unknown }

/** The answer to one tool call: a `tool_result` block for the next user turn. */
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string | Block[]; is_error?: boolean }

export interface ToolRunner {
  /** Runs the calls of one message (Claude may make several at once) and answers all of them, in order. */
  run(calls: readonly ToolCall[], signal?: AbortSignal): Promise<ToolResultBlock[]>;
  /** What the tools have added so far in this turn. */
  used(): { tokens: number; calls: number };
}

export const isClientTool = (name: string): name is ClientTool => name === 'search_document' || name === 'get_pages' || name === 'get_figure';

/** The `tool_use` blocks of a final message. */
export function toolCallsOf(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((b: unknown) => {
    if (b === null || typeof b !== 'object') return [];
    const r = b as Record<string, unknown>;
    return r.type === 'tool_use' && typeof r.id === 'string' && typeof r.name === 'string' ? [{ id: r.id, name: r.name, input: r.input }] : [];
  });
}

const tokensOfText = (s: string) => Math.ceil(s.length / 4);
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createToolRunner(o: { context: ContextBuilder; role: ModelRole; model: ModelChoice; pageCount: number }): ToolRunner {
  const budget = TOOL_BUDGET[o.role];
  let tokens = 0;
  let calls = 0;

  const limit = (id: string): ToolResultBlock => ({
    type: 'tool_result', tool_use_id: id, is_error: true,
    content: 'The limit for looking further in this PDF was reached for this question. Answer with what you have, and say what is missing.',
  });
  const bad = (id: string, why: string): ToolResultBlock => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: why });

  /** Passages as search_result blocks, as many as fit what is left of the budget. */
  const asResults = (id: string, passages: readonly Passage[], none: string): ToolResultBlock => {
    const blocks: Block[] = [];
    for (const p of passages) {
      const t = tokensOfText(p.text) + 12;
      if (tokens + t > budget.tokens) break;
      tokens += t;
      blocks.push(searchResultFor(p) as unknown as Block);
    }
    if (blocks.length === 0) return { type: 'tool_result', tool_use_id: id, content: passages.length === 0 ? none : limit(id).content };
    return { type: 'tool_result', tool_use_id: id, content: blocks };
  };

  async function searchDocument(c: ToolCall): Promise<ToolResultBlock> {
    const query = isRec(c.input) && typeof c.input.query === 'string' ? c.input.query.trim().slice(0, 300) : '';
    if (query === '') return bad(c.id, 'search_document needs some words to look for.');
    const found = await o.context.passages(query, Math.min(SEARCH_TOKENS, budget.tokens - tokens));
    return asResults(c.id, found.slice(0, SEARCH_RESULTS), `Nothing in this PDF matched “${query}”.`);
  }

  async function getPages(c: ToolCall): Promise<ToolResultBlock> {
    const raw = isRec(c.input) && Array.isArray(c.input.pages) ? c.input.pages : [];
    const pages = [...new Set(raw.filter((p): p is number => typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= o.pageCount))].slice(0, MAX_PAGES);
    if (pages.length === 0) return bad(c.id, `get_pages needs page numbers from 1 to ${o.pageCount}.`);
    const passages: Passage[] = [];
    const deps = o.context.figureDeps;
    for (const n of pages) {
      const pageIndex = n - 1;
      const text = await deps.text.text(pageIndex);
      let pageTokens = 0;
      for (const s of passageSpans(text)) {
        pageTokens += tokensOfText(s.text);
        if (pageTokens > PAGE_MAX_TOKENS) break;
        passages.push({ documentId: deps.documentId, pageIndex, start: s.start, end: s.end, textSource: deps.text.source(pageIndex), text: s.text, rank: passages.length, tokens: tokensOfText(s.text) });
      }
    }
    return asResults(c.id, passages, `Page${pages.length > 1 ? 's' : ''} ${pages.join(', ')} ha${pages.length > 1 ? 've' : 's'} no text that could be read.`);
  }

  async function getFigure(c: ToolCall, signal?: AbortSignal): Promise<ToolResultBlock> {
    const label = isRec(c.input) && typeof c.input.label === 'string' ? c.input.label.trim().slice(0, 60) : '';
    if (label === '') return bad(c.id, 'get_figure needs a figure label, such as "Figure 4".');
    const [target] = await figuresNamedIn(o.context.figureDeps, label);
    if (!target) return bad(c.id, `No figure labelled “${label}” was found in this PDF.`);
    const pack: FigurePack = await buildFigurePack(o.context.figureDeps, target, { role: o.role, ...(signal ? { signal } : {}) });
    const lines = [
      `${pack.label ?? 'Figure'} (page ${pack.pageIndex + 1}).`,
      pack.caption ? `Caption: ${pack.caption.text}` : '',
      pack.insideText.trim() ? `Text inside the figure (exact, from the PDF): ${pack.insideText.trim()}` : '',
      ...pack.mentions.map((m) => `[p. ${m.pageIndex + 1}] ${m.text}`),
    ].filter(Boolean);
    const words = lines.join('\n');
    const imageTokens = o.model.imageInput ? pack.image.visualTokens : 0;
    if (tokens + imageTokens + tokensOfText(words) > budget.tokens) return limit(c.id);
    tokens += imageTokens + tokensOfText(words);
    const content: Block[] = [];
    if (o.model.imageInput) content.push({ type: 'image', source: { type: 'base64', media_type: pack.image.mediaType, data: await encodeRegionImage(pack.image) } });
    content.push({ type: 'text', text: o.model.imageInput ? words : `${words}\n(This model cannot see pictures: answer from the text.)` });
    return { type: 'tool_result', tool_use_id: c.id, content };
  }

  return {
    used: () => ({ tokens, calls }),
    async run(list, signal) {
      const out: ToolResultBlock[] = [];
      for (const c of list) {
        if (!isClientTool(c.name)) {
          out.push(bad(c.id, `There is no tool called ${c.name.slice(0, 40)}.`));
          continue;
        }
        if (calls >= budget.calls || tokens >= budget.tokens) {
          out.push(limit(c.id));
          continue;
        }
        calls += 1;
        try {
          if (c.name === 'search_document') out.push(await searchDocument(c));
          else if (c.name === 'get_pages') out.push(await getPages(c));
          else out.push(await getFigure(c, signal));
        } catch {
          out.push(bad(c.id, 'That could not be read from the PDF just now.'));
        }
      }
      return out;
    },
  };
}
