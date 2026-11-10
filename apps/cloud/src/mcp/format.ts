// How the connector shows things: 1-based pages, 'user' for the owner, ISO times, short strings, and a result envelope.
import { CONNECTOR_LIMITS, type ConnectorErrorCode, type McpAuthor } from '@sop/core/connector';

export const authorOut = (a: 'me' | 'claude'): McpAuthor => (a === 'me' ? 'user' : 'claude');
export const authorIn = (a: McpAuthor): 'me' | 'claude' => (a === 'user' ? 'me' : 'claude');
export const iso = (ms: number): string => new Date(ms).toISOString();

export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** A link to the reading in the web library: `/d/<sha>?page=N#c=<comment>`. */
export function docUrl(base: string, doc: string, page?: number | null, commentId?: string): string {
  return `${base}/d/${doc}${page ? `?page=${page}` : ''}${commentId ? `#c=${commentId}` : ''}`;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** The size of a result as Claude receives it. */
export const sizeOf = (data: unknown): number => JSON.stringify(data).length;

export function ok(data: Record<string, unknown>): ToolResult {
  const text = JSON.stringify(data);
  // A hard stop. Each tool trims its own result with a cursor first, so this should never fire.
  if (text.length > CONNECTOR_LIMITS.outputMaxChars) return fail('internal', 'That result was too long. Ask for fewer items.');
  return { content: [{ type: 'text', text }], structuredContent: data };
}

export function fail(code: ConnectorErrorCode, message: string, retryable = false): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code, message, retryable }) }] };
}
