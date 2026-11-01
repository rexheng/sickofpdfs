import type { ClaudeReplyMeta, ConflictCopyMeta } from '../claude/types';
import type { HlcStamp } from '../hlc';
import type { Author, CommentId, DocumentId, MarkId, TabId, ThreadId } from '../ids';
import type { Anchor } from './anchor';

export type MarkStyle = 'highlight' | 'underline' | 'bold' | 'strike' | 'area';

/** A slot: tokens --sop-mark-1 … --sop-mark-5 in packages/ui. Hex values live only in the token file. */
export type MarkColor = 1 | 2 | 3 | 4 | 5;

interface Synced {
  rev: number;
  hlc: HlcStamp;
  deletedAt: number | null;
}

export interface MarkRow extends Synced {
  id: MarkId;
  documentId: DocumentId;
  style: MarkStyle;
  /** Null for bold and area. */
  color: MarkColor | null;
  /** 'text' | 'area' | 'figure'. */
  anchor: Anchor;
  pageIndex: number;
  sortKey: number;
  /** v2. Never changes after creation. */
  author: Author;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadRow extends Synced {
  id: ThreadId;
  documentId: DocumentId;
  /** Any kind. */
  anchor: Anchor;
  pageIndex: number | null;
  sortKey: number | null;
  placement: 'placed' | 'unplaced';
  /** v2. Non-null means a new thread whose first comment is unsent. Never synced. */
  draftOfTab: TabId | null;
  createdAt: number;
  updatedAt: number;
}

export interface CommentRow extends Synced {
  id: CommentId;
  threadId: ThreadId;
  documentId: DocumentId;
  author: Author;
  /** Markdown. */
  body: string;
  draftOfTab: TabId | null;
  meta: CommentMeta;
  createdAt: number;
  editedAt: number | null;
}

/** '{}' for an owner comment. */
export type CommentMeta = Record<string, never> | ClaudeReplyMeta | ConflictCopyMeta;
