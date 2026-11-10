// The claude.ai connector's tools: inputs and results (contracts §8, plan CL6). Pages are 1-based and `author` reads
// 'user' | 'claude' here; inside the Worker pages are 0-based and the owner is 'me'. The mapping happens only at the MCP edge.
import type { Sha256 } from '../ids';

export type McpAuthor = 'user' | 'claude';
export type AnchorKind = 'text' | 'area' | 'figure' | 'point' | 'page' | 'document';

/** Limits the tools enforce (the server checks them; the input schemas repeat them so Claude sees them). */
export const CONNECTOR_LIMITS = {
  queryMax: 300,
  searchLimitMax: 25,
  searchLimitDefault: 10,
  listLimitMax: 25,
  listLimitDefault: 15,
  readPagesSpanMax: 50,
  /** Accepted for `max_chars`; the reply as a whole is still cut at `outputMaxChars`. */
  readCharsMax: 120_000,
  readCharsDefault: 30_000,
  annotationsLimitMax: 25,
  annotationsLimitDefault: 15,
  activityDaysMax: 90,
  activityLimitMax: 40,
  quoteMin: 3,
  quoteMax: 500,
  bodyMax: 4_000,
  /** No reply is longer than this many characters; longer results continue with a cursor. */
  outputMaxChars: 40_000,
  /** Claude may add this many comments an hour. */
  commentsPerHour: 60,
} as const;

export type ConnectorErrorCode =
  | 'quote_not_found' // retryable: the quote is not on that page
  | 'quote_ambiguous' // retryable: the quote is on that page more than once
  | 'thread_not_found'
  | 'document_not_synced' // the reading is not in the library Claude can see (not synced, in Trash or private)
  | 'comment_not_yours' // Claude can change only its own comments
  | 'comments_off' // the owner switched Claude's comments off
  | 'rate_limited'
  | 'bad_input'
  | 'not_found'
  | 'internal';

export interface SearchLibraryInput { query: string; scope?: 'all' | 'pages' | 'notes' | 'titles'; doc?: Sha256; limit?: number }
export interface SearchLibraryHit { kind: 'reading' | 'page' | 'note'; doc: Sha256; title: string; page?: number; snippet: string; author?: McpAuthor; thread_id?: string; url: string }
export interface SearchLibraryResult { hits: SearchLibraryHit[] }

export interface ListDocumentsInput { kind?: 'paper' | 'book' | 'slides' | 'other'; starred?: boolean; has_notes?: boolean; title_contains?: string; sort?: 'recent' | 'added' | 'title'; limit?: number; cursor?: string }
export interface ListDocumentsResult {
  documents: { doc: Sha256; title: string; authors: string[]; year: number | null; kind: string; pages: number; last_opened: string | null; note_count: number; url: string }[];
  next_cursor: string | null;
}

export interface GetDocumentInput { doc: Sha256 }
export interface GetDocumentResult {
  doc: Sha256; title: string; authors: string[]; year: number | null; doi: string | null; arxiv_id: string | null; kind: string; pages: number; starred: boolean;
  locations: { kind: 'url' | 'file'; value: string }[]; text_available: boolean; notes_by_page: Record<number, number>; url: string;
}

export interface ReadPagesInput { doc: Sha256; from: number; to: number; max_chars?: number }
export interface ReadPagesResult { pages: { page: number; text: string }[]; next_from: number | null }

export interface GetAnnotationsInput { doc: Sha256; page_from?: number; page_to?: number; author?: 'any' | McpAuthor; limit?: number; cursor?: string }
export interface GetAnnotationsResult {
  marks: { id: string; style: string; color: number | null; page: number; quote: string; author: McpAuthor }[];
  threads: {
    id: string; page: number | null; anchor: AnchorKind; quote: string | null;
    comments: { id: string; author: McpAuthor; body: string; created_at: string; edited_at: string | null }[];
  }[];
  next_cursor: string | null;
}

export interface RecentActivityInput { days?: number; limit?: number }
export interface RecentActivityResult { items: { at: string; kind: 'opened' | 'added' | 'note' | 'claude-note'; doc: Sha256; title: string; page?: number; snippet?: string }[] }

export interface AddCommentInput { doc: Sha256; page?: number; quote?: string; reply_to?: string; body: string; request_id: string }
export interface AddCommentResult { thread_id: string; comment_id: string; anchored: 'quote' | 'page' | 'document' | 'reply'; url: string }

/** `body` or `delete: true`. Claude's own comments only (D3). */
export interface UpdateCommentInput { id: string; body?: string; delete?: boolean }
export interface UpdateCommentResult { comment_id: string; edited_at: string | null; deleted?: boolean }

export const READ_TOOLS = ['search_library', 'list_documents', 'get_document', 'read_pages', 'get_annotations', 'recent_activity'] as const;
export const WRITE_TOOLS = ['add_comment', 'update_comment'] as const;
