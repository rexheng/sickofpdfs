import type { CommentId } from '../ids';

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
