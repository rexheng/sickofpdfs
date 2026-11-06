// Builds one Messages API request from a context pack and a thread.
//
// Order (contract §6), because the cache is a prefix match: the frozen tool list, the frozen system prompt, the document
// map (breakpoint 1, shared by every thread on the document), then in the first user turn the figure images with their
// text packs, then the passages, then the question. Top-level `cache_control` adds breakpoint 2 on the thread's tail.
// Two breakpoints in all; the 5-minute lifetime only. No temperature, top_p or top_k (the API rejects them), and the
// effort is fixed per role so the cache holds.
//
// No model id is written here. The model comes from the settings (`ModelChoice`), and so does the web search tool type.
import {
  CLIENT_TOOLS,
  DOC_TITLE_MAP,
  DOC_TITLE_PASSAGES,
  MAX_WEB_SEARCHES,
  SYSTEM_PROMPT,
  figureDocTitle,
  type ToolDefinition,
} from './prompts';
import type { CitableBlock, ContextPack, FigurePack, ModelChoice, ModelRole, Passage, RegionImage } from './types';

// ---- Wire shapes (only the ones this file makes) ----

export interface CacheControl { type: 'ephemeral' }
export interface TextBlockParam { type: 'text'; text: string; cache_control?: CacheControl }
export interface DocumentBlockParam {
  type: 'document'; title: string; context?: string; citations: { enabled: true };
  source: { type: 'content'; content: { type: 'text'; text: string }[] };
  cache_control?: CacheControl;
}
export interface ImageBlockParam {
  type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg'; data: string };
  /** Fail loudly rather than let the server shrink the picture until the small text is unreadable (research 06 §7.1). */
  transformations: { oversized_image: 'error' };
}
export interface SearchResultBlockParam {
  type: 'search_result'; source: string; title: string; content: { type: 'text'; text: string }[]; citations: { enabled: true };
}
/** A block held in memory from an earlier request or reply (assistant output, tool results), passed back exactly as it came. */
export interface HeldBlock { type: string; [key: string]: unknown }
export interface WebSearchToolParam { type: string; name: 'web_search'; max_uses: number }
export type ToolParam = ToolDefinition | WebSearchToolParam;
export interface MessageParam { role: 'user' | 'assistant'; content: string | (TextBlockParam | DocumentBlockParam | ImageBlockParam | HeldBlock)[] }

/**
 * One turn of the thread, oldest first. The first turn is the owner's first question as plain text (the pack is added in
 * front of it). Later turns are appended as they are: the exact blocks held in memory, or, after a reload, the stored
 * comments as plain text (use `replyBodyToPlainText` for Claude's). The last turn is the new question.
 */
export interface ThreadTurn { role: 'user' | 'assistant'; content: string | HeldBlock[] }

export interface MessagesParams {
  model: string;
  max_tokens: number;
  output_config: { effort: 'low' | 'medium' };
  cache_control: CacheControl;
  system: string;
  tools: ToolParam[];
  messages: MessageParam[];
  /** Only on Think harder, and only when the model's info lists fallback models. Send with `client.beta.messages`. */
  betas?: string[];
  fallbacks?: 'default';
}

export interface BuildOptions { role: ModelRole; model: ModelChoice; webSearch: boolean }

/** Effort is fixed per role (A2), so the cache holds. The live check may change these values; they are never a setting. */
export const EFFORT: Readonly<Record<ModelRole, 'low' | 'medium'>> = { 'default': 'low', 'think-harder': 'medium' };
/** The reply ceiling, thinking included (plan §3). */
export const MAX_TOKENS: Readonly<Record<ModelRole, number>> = { 'default': 4000, 'think-harder': 16000 };
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const EMPTY_MAP_LINE = 'This PDF has no title, abstract or headings that could be read.';
const NO_FIGURE_TEXT_LINE = 'No caption or text was found for this figure.';

// ---- Pieces ----

interface Item { text: string; cite: Pick<CitableBlock, 'pageIndex' | 'start' | 'end' | 'textSource'> }

/** `[p. 4] text`: the tag lets Claude say where something is; the chip itself comes from the citation. */
const tagged = (p: Pick<Passage, 'pageIndex' | 'text'>) => `[p. ${p.pageIndex + 1}] ${p.text}`;
const citeOf = (p: Pick<Passage, 'pageIndex' | 'start' | 'end' | 'textSource'>) => ({ pageIndex: p.pageIndex, start: p.start, end: p.end, textSource: p.textSource });
const passageKey = (p: Pick<Passage, 'pageIndex' | 'start' | 'end' | 'textSource'>) => `${p.textSource}|${p.pageIndex}|${p.start}|${p.end}`;

function mapItems(map: ContextPack['map']): Item[] {
  const source = map.abstract?.textSource ?? 'pdfium';
  const items: Item[] = [];
  if (map.title) items.push({ text: `Title: ${map.title}`, cite: { pageIndex: 0, start: 0, end: 0, textSource: source } });
  if (map.abstract) items.push({ text: `Abstract (p. ${map.abstract.pageIndex + 1}): ${map.abstract.text}`, cite: citeOf(map.abstract) });
  for (const h of map.headings) items.push({ text: `Heading (p. ${h.pageIndex + 1}): ${h.text}`, cite: { pageIndex: h.pageIndex, start: 0, end: 0, textSource: source } });
  for (const f of map.figures) items.push({ text: `${f.label} (p. ${f.pageIndex + 1}): ${f.caption}`, cite: { pageIndex: f.pageIndex, start: 0, end: 0, textSource: source } });
  if (items.length === 0) items.push({ text: EMPTY_MAP_LINE, cite: { pageIndex: 0, start: 0, end: 0, textSource: source } });
  return items;
}

function figureItems(f: FigurePack): Item[] {
  const items: Item[] = [];
  const source = f.caption?.textSource ?? f.mentions[0]?.textSource ?? 'pdfium';
  if (f.caption) items.push({ text: tagged(f.caption), cite: citeOf(f.caption) });
  if (f.insideText.trim()) {
    const what = f.label ?? 'the figure';
    items.push({ text: `[p. ${f.pageIndex + 1}] Text inside ${what} (exact, from the PDF): ${f.insideText.trim()}`, cite: { pageIndex: f.pageIndex, start: 0, end: 0, textSource: source } });
  }
  for (const m of f.mentions) items.push({ text: tagged(m), cite: citeOf(m) });
  if (items.length === 0) items.push({ text: `[p. ${f.pageIndex + 1}] ${NO_FIGURE_TEXT_LINE}`, cite: { pageIndex: f.pageIndex, start: 0, end: 0, textSource: source } });
  return items;
}

function figureContext(f: FigurePack, sees: boolean): string {
  const what = f.label ?? 'A figure';
  const dpi = Math.round(f.image.scale * 72);
  return sees
    ? `${what}, page ${f.pageIndex + 1}. The picture just above shows it, drawn at ${dpi} dpi.`
    : `${what}, page ${f.pageIndex + 1}. You cannot see the picture with this model: answer from the text below and say so.`;
}

/** The base64 of a rendered figure. `buildRequest` calls this itself; callers never encode images first. */
export async function encodeRegionImage(img: Pick<RegionImage, 'blob'>): Promise<string> {
  const bytes = new Uint8Array(await img.blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// ---- search_result blocks (client tool results) ----

const SOURCE_PREFIX = 'sop:';

/** The `source` of a search_result block names the passage, so the position of a held block can be rebuilt from the block alone. */
export function searchSource(p: Pick<Passage, 'pageIndex' | 'start' | 'end' | 'textSource'>): string {
  return `${SOURCE_PREFIX}${encodeURIComponent(p.textSource)}:${p.pageIndex}:${p.start}-${p.end}`;
}

export function parseSearchSource(source: string): Pick<CitableBlock, 'pageIndex' | 'start' | 'end' | 'textSource'> | null {
  const m = /^sop:([^:]+):(\d+):(\d+)-(\d+)$/.exec(source);
  if (!m) return null;
  const [, encoded = '', page = '', start = '', end = ''] = m;
  try {
    return { textSource: decodeURIComponent(encoded), pageIndex: Number(page), start: Number(start), end: Number(end) };
  } catch {
    return null;
  }
}

/** One passage as a search_result block, for the content of a client tool's `tool_result`. Its text is citable. */
export function searchResultFor(p: Pick<Passage, 'pageIndex' | 'start' | 'end' | 'textSource' | 'text'>): SearchResultBlockParam {
  return { type: 'search_result', source: searchSource(p), title: `Page ${p.pageIndex + 1}`, content: [{ type: 'text', text: tagged(p) }], citations: { enabled: true } };
}

/** The citable blocks of every search_result in the later turns, in order. Their ordinals count across the whole request. */
function searchResultBlocks(turns: readonly ThreadTurn[]): CitableBlock[] {
  const out: CitableBlock[] = [];
  let ordinal = 0;
  for (const turn of turns) {
    if (typeof turn.content === 'string') continue;
    for (const block of turn.content) {
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue;
      for (const item of block.content as HeldBlock[]) {
        if (item?.type !== 'search_result') continue;
        const index = ordinal++;
        const at = typeof item.source === 'string' ? parseSearchSource(item.source) : null;
        const parts = Array.isArray(item.content) ? (item.content as HeldBlock[]) : [];
        if (!at) continue;
        const title = typeof item.title === 'string' ? item.title : `Page ${at.pageIndex + 1}`;
        parts.forEach((_, j) => out.push({ title, ...at, via: { kind: 'search_result', index, block: j } }));
      }
    }
  }
  return out;
}

// ---- The builder ----

/**
 * Asynchronous because a figure image is a Blob, which can only be read asynchronously: `buildRequest` encodes the pack's
 * `RegionImage`s itself, so nobody has to remember a separate step.
 */
export async function buildRequest(
  pack: ContextPack,
  turns: readonly ThreadTurn[],
  o: BuildOptions,
): Promise<{ params: MessagesParams; blocks: CitableBlock[] }> {
  const first = turns[0];
  if (!first) throw new Error('A request needs at least the first question.');
  if (first.role !== 'user' || typeof first.content !== 'string') throw new Error('The first turn must be the owner’s question as plain text.');
  if (turns.at(-1)?.role !== 'user') throw new Error('The last turn must be a question or a tool result, not a reply.');
  if (!o.model.id) throw new Error('No model was chosen. Pick one in Settings.');

  const blocks: CitableBlock[] = [];
  const content: Exclude<MessageParam['content'], string> = [];
  let docIndex = 0;

  const addDocument = (title: string, items: Item[], extra?: { context?: string; cacheBreakpoint?: boolean }) => {
    const doc: DocumentBlockParam = {
      type: 'document', title, ...(extra?.context ? { context: extra.context } : {}), citations: { enabled: true },
      source: { type: 'content', content: items.map((it) => ({ type: 'text' as const, text: it.text })) },
      ...(extra?.cacheBreakpoint ? { cache_control: { type: 'ephemeral' as const } } : {}),
    };
    items.forEach((it, block) => blocks.push({ title, ...it.cite, via: { kind: 'document', index: docIndex, block } }));
    docIndex += 1;
    content.push(doc);
  };

  // 1. The document map. Breakpoint 1: every thread on this document shares the prefix up to here.
  addDocument(DOC_TITLE_MAP, mapItems(pack.map), { cacheBreakpoint: true });

  // 2. Each figure: the picture first (Claude reads images best before the text), then its text pack.
  const sees = o.model.imageInput;
  for (const f of pack.figures) {
    if (sees) {
      const data = await encodeRegionImage(f.image);
      content.push({ type: 'image', source: { type: 'base64', media_type: f.image.mediaType, data }, transformations: { oversized_image: 'error' } });
      for (const extra of f.more ?? []) {
        const more = await encodeRegionImage(extra);
        content.push({ type: 'image', source: { type: 'base64', media_type: extra.mediaType, data: more }, transformations: { oversized_image: 'error' } });
      }
    }
    addDocument(figureDocTitle(f.label, f.pageIndex), figureItems(f), { context: figureContext(f, sees) });
  }

  // 3. The passages: the marked paragraph first, then the ranked ones, none twice.
  const seen = new Set<string>();
  const passages: Passage[] = [];
  for (const p of [...(pack.focus ? [pack.focus] : []), ...pack.passages]) {
    const k = passageKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    passages.push(p);
  }
  if (passages.length > 0) {
    const context = pack.focus ? `The first passage is the paragraph the student marked, on page ${pack.focus.pageIndex + 1}.` : undefined;
    addDocument(DOC_TITLE_PASSAGES, passages.map((p) => ({ text: tagged(p), cite: citeOf(p) })), context ? { context } : undefined);
  }

  // 4. The question.
  content.push({ type: 'text', text: first.content });
  const messages: MessageParam[] = [{ role: 'user', content }];
  // Copies, so nothing that touches a built request (the SDK, a retry wrapper) can change the held blocks or a later request.
  for (const turn of turns.slice(1)) messages.push({ role: turn.role, content: typeof turn.content === 'string' ? turn.content : structuredClone(turn.content) });

  blocks.push(...searchResultBlocks(turns.slice(1)));

  // Deep copies: the frozen tool list must stay frozen for every later request, whatever happens to this one.
  const tools: ToolParam[] = CLIENT_TOOLS.map((t) => structuredClone(t));
  if (o.webSearch && o.model.webSearchTool) tools.push({ type: o.model.webSearchTool, name: 'web_search', max_uses: MAX_WEB_SEARCHES });

  const params: MessagesParams = {
    model: o.model.id,
    max_tokens: MAX_TOKENS[o.role],
    output_config: { effort: EFFORT[o.role] },
    cache_control: { type: 'ephemeral' },
    system: SYSTEM_PROMPT,
    tools,
    messages,
    ...(o.role === 'think-harder' && o.model.serverFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  };
  return { params, blocks };
}

/** The labels of the figures in a pack, for `ClaudeReplyMeta.figureLabels`. */
export function figureLabelsOf(pack: ContextPack): string[] {
  return pack.figures.map((f) => f.label).filter((l): l is string => l !== null);
}
