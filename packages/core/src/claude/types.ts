import type { CommentId, DocumentId, ThreadId } from '../ids';
import type { Anchor } from '../model/anchor';

// packages/core/src/claude/types.ts (Phase 4 owns; Phase 2 stores the JSON as-is and preserves unknown fields)
export type ModelRole = 'default' | 'think-harder';
export interface PageCitation { n: number; pageIndex: number; start: number; end: number; textSource: string; quote: string }
export interface WebSource { n: number; url: string; title: string; citedText: string | null }
export interface ReplyError { code: 'interrupted' | 'network' | 'no-key' | 'bad-key' | 'refused' | 'over-cap' | 'rate-limited' | 'server' | 'cancelled'; message: string /* plain words */ }
export interface ClaudeReplyMeta {
  kind: 'claude-reply'; v: 1;
  role: ModelRole | null;            // null when Claude wrote it through the connector
  status: 'pending' | 'streaming' | 'done' | 'error'; error: ReplyError | null;
  questionId: CommentId | null;      // the owner comment that asked
  citations: PageCitation[]; webSources: WebSource[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; webSearches: number; usd: number } | null;
  scope: 'passages' | 'whole-document'; figureLabels: string[]; via: 'viewer' | 'connector';
}
export interface ConflictCopyMeta { kind: 'conflict-copy'; v: 1; of: CommentId; device: string }   // shown as "Edited on another device" (Phase 5)

// ---- Contract §6 and plan §8 (Phase 4) ----

/**
 * Contract addition A1: the value of the settings rows `claude.model.default` and `claude.model.thinkHarder`.
 * The id is data from the Models API; code never compares ids (contracts D1).
 */
export interface ModelChoice {
  id: string;
  displayName: string;
  /** From the Models API `line` (haiku, sonnet, opus, ...). Never inferred from the id. */
  line: string | null;
  imageInput: boolean;
  /** The web search tool type this model accepted when setup probed it; null when none did. */
  webSearchTool: string | null;
  maxInputTokens: number | null;
  checkedAt: number;
  /** Set at setup when the model's info lists fallback models. Only Think harder uses it (plan §3, "Refusals and errors"). */
  serverFallback?: boolean;
}

/** blocks[i] = the i-th citable text block sent. `via` (A5) says where in the request it sits, so both citation location types map back. */
export interface CitableBlock {
  title: string; pageIndex: number; start: number; end: number; textSource: string;
  via?: { kind: 'document' | 'search_result'; index: number; block: number };
}

// Structural copies of the contract §6 shapes that slices B (passages.ts) and C (render-region.ts, figure-pack.ts) own.
// They are identical to the contract text; B and C should re-export these rather than declare their own.
/** A paragraph cut at sentence ends to at most 300 tokens (contract §6). */
export interface Passage { documentId: DocumentId; pageIndex: number; start: number; end: number; textSource: string; text: string; rank: number; tokens: number /* ceil(chars / 4) */ }
export interface DocumentMap { title: string | null; abstract: Passage | null; headings: { text: string; pageIndex: number }[]; figures: { label: string; pageIndex: number; caption: string }[] }
export interface RegionImage { blob: Blob; mediaType: 'image/png' | 'image/jpeg'; width: number; height: number; scale: number /* px per pt = dpi / 72 */; visualTokens: number }
export interface FigurePack { label: string | null; pageIndex: number; image: RegionImage; caption: Passage | null; insideText: string; mentions: Passage[] /* <= 3 */;
  /** Slice C: further pictures sent after `image`: the enlarged crop of a small mark, or a scan's page for context. */
  more?: RegionImage[] }

export interface ClaudeTurnRequest { documentId: DocumentId; threadId: ThreadId; questionId: CommentId; replyId: CommentId; role: ModelRole;
  scope: 'passages' | 'whole-document'; webSearch: boolean; focus: Anchor | null /* the thread's anchor */ }
export interface ContextPack { map: DocumentMap; focus: Passage | null; passages: Passage[]; figures: FigurePack[]; blocks: CitableBlock[]; estimate: { inputTokens: number; usd: number } }
export type ClientTool = 'search_document' | 'get_pages' | 'get_figure';   // run in the viewer; every result counts against the turn's budget
export type ClaudeStreamEvent =
  | { type: 'status'; status: 'pending' | 'streaming' } | { type: 'text'; delta: string }
  | { type: 'citation'; citation: PageCitation } | { type: 'web-source'; source: WebSource }
  | { type: 'tool'; tool: ClientTool | 'web_search'; state: 'running' | 'done'; label: string /* "Searching the web for …" */ }
  | { type: 'done'; meta: ClaudeReplyMeta } | { type: 'error'; error: ReplyError };

// ---- Plain words for every error the owner can see ----

/** Plain, short sentences. The Settings button ("Open Settings") is added by the UI for `no-key`, `bad-key` and `over-cap`. */
export const REPLY_ERROR_MESSAGES: Readonly<Record<ReplyError['code'], string>> = {
  'interrupted': 'This reply was cut off. Press Try again.',
  'network': "Couldn't reach Claude. Check your internet, then press Try again.",
  'no-key': 'Add your Claude key in Settings.',
  'bad-key': "That Claude key didn't work. Check it in Settings.",
  'refused': 'Claude declined to answer this.',
  'over-cap': "You've reached this month's Claude spending limit. Raise it in Settings to ask more.",
  'rate-limited': 'Claude is busy right now. Wait a moment, then press Try again.',
  'server': 'Claude had a problem. Press Try again.',
  'cancelled': 'You stopped this reply.',
};

export function replyError(code: ReplyError['code']): ReplyError {
  return { code, message: REPLY_ERROR_MESSAGES[code] };
}
