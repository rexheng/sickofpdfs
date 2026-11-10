// The daily write meter (spec "Hosting"; plan CL4). Cloudflare's free plan allows 100,000 database rows written a day for the
// whole account, and from Sept 2026 refuses every query past it. So the Worker counts what it writes:
//   - page text stops at WRITE_BUDGET (production 75,000, staging 10,000);
//   - notes and everything else go on to WRITE_BUDGET + NOTES_RESERVE (staging: no reserve).
// A refusal is 429 with Retry-After: the seconds until midnight UTC, when Cloudflare's count starts again.

import type { Env } from '../env';

export type MeterLane = 'text' | 'notes';

export const utcDay = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);

export function secondsToUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(60, Math.ceil((next - now) / 1000));
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function limits(env: Env): { text: number; notes: number } {
  const budget = num(env.WRITE_BUDGET, 10_000);
  return { text: budget, notes: budget + num(env.NOTES_RESERVE, 0) };
}

export const usageStatement = (env: Env, now = Date.now()): D1PreparedStatement =>
  env.META.prepare('SELECT text_rows, note_rows FROM usage_day WHERE day = ?').bind(utcDay(now));

/** Whether this lane may still write today, given today's row (from `usageStatement`). */
export function allowed(env: Env, lane: MeterLane, usage: { text_rows: number; note_rows: number } | null | undefined): boolean {
  const used = (usage?.text_rows ?? 0) + (usage?.note_rows ?? 0);
  return used < limits(env)[lane];
}

/** Adds what was written. Best effort: a failed count never fails the write it counts. */
export async function addUsage(env: Env, lane: MeterLane, rows: number, now = Date.now()): Promise<void> {
  if (!(rows > 0)) return;
  const col = lane === 'text' ? 'text_rows' : 'note_rows';
  try {
    await env.META.prepare(`INSERT INTO usage_day (day, ${col}) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET ${col} = ${col} + excluded.${col}`).bind(utcDay(now), Math.ceil(rows)).run();
  } catch (e) {
    console.warn(JSON.stringify({ event: 'meter_failed', error: e instanceof Error ? e.name : 'unknown' }));
  }
}

export const rowsWritten = (results: readonly D1Result[]): number => results.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0);

export class QuotaError extends Error {
  constructor(readonly lane: MeterLane) {
    super(lane === 'text' ? 'Page text waits until tomorrow: the daily limit is reached. Notes still sync.' : 'The daily limit is reached. Sync starts again after midnight UTC.');
    this.name = 'QuotaError';
  }
}

export function quotaResponse(e: QuotaError, now = Date.now()): Response {
  return new Response(JSON.stringify({ error: 'quota', lane: e.lane, message: e.message }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(secondsToUtcMidnight(now)) },
  });
}
