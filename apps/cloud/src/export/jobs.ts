// The daily job (CL7). Small and bounded, so one run stays inside the free plan's limits (50 D1 queries, 50 subrequests): a
// backlog drains over the next days. Every step is safe to run twice and logs only counts.

import type { Sha256 } from '@sop/core';
import type { Env } from '../env';
import { createSyncService } from '../sync/service';

const DAY = 86_400_000;
/** Trash purge (D8), replay memory and backups are kept this long. */
export const KEEP_DAYS = 30;
const STALE_UPLOAD_DAYS = 7;
const AUDIT_DAYS = 180;
const USAGE_DAYS = 90;
/** Documents purged per run (each takes a handful of queries). */
const PURGES_PER_RUN = 5;
const BACKUP_DELETES_PER_RUN = 1000;

export interface JobReport {
  appliedPruned: number;
  auditPruned: number;
  usagePruned: number;
  uploadsAborted: number;
  trashPurged: number;
  backupFilesDeleted: number;
}

export async function dailyJob(env: Env, now: number = Date.now()): Promise<JobReport> {
  const db = env.META;
  const report: JobReport = { appliedPruned: 0, auditPruned: 0, usagePruned: 0, uploadsAborted: 0, trashPurged: 0, backupFilesDeleted: 0 };

  // 1. Housekeeping rows, in one batch
  const cutoffDay = new Date(now - USAGE_DAYS * DAY).toISOString().slice(0, 10);
  const [applied, audit, usage, stale, trash] = await db.batch<Record<string, unknown>>([
    db.prepare('DELETE FROM applied_entry WHERE at < ?').bind(now - KEEP_DAYS * DAY),
    db.prepare('DELETE FROM audit WHERE at < ?').bind(now - AUDIT_DAYS * DAY),
    db.prepare('DELETE FROM usage_day WHERE day < ?').bind(cutoffDay),
    db.prepare('SELECT sha256, upload_id FROM blob_upload WHERE started_at < ? LIMIT 20').bind(now - STALE_UPLOAD_DAYS * DAY),
    db.prepare('SELECT id FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at LIMIT ?').bind(now - KEEP_DAYS * DAY, PURGES_PER_RUN * 4),
  ]);
  report.appliedPruned = applied?.meta.changes ?? 0;
  report.auditPruned = audit?.meta.changes ?? 0;
  report.usagePruned = usage?.meta.changes ?? 0;

  // 2. Uploads nobody finished in 7 days (R2 would drop them anyway; this also frees the row)
  for (const u of (stale?.results ?? []) as { sha256: string; upload_id: string }[]) {
    await env.BLOBS.resumeMultipartUpload(`pdf/${u.sha256.slice(0, 2)}/${u.sha256}.pdf`, u.upload_id).abort().catch(() => undefined);
    await db.prepare('DELETE FROM blob_upload WHERE sha256 = ? AND upload_id = ?').bind(u.sha256, u.upload_id).run();
    report.uploadsAborted++;
  }

  // 3. Trash older than 30 days is purged like Forget (D8). A document restored since then has deleted_at NULL and is kept.
  //    `deleted_at` comes from a device's clock, which can be wrong, so the server also needs 30 days of its own: no push of
  //    the document row may have reached it in that time (its replay memory, kept exactly 30 days, would show one).
  const sync = createSyncService(env);
  const candidates = ((trash?.results ?? []) as { id: string }[]).map((d) => d.id);
  const recent = new Set<string>();
  if (candidates.length) {
    const r = await db
      .prepare(`SELECT row_id FROM applied_entry WHERE table_name = 'documents' AND at > ? AND row_id IN (${candidates.map(() => '?').join(',')})`)
      .bind(now - KEEP_DAYS * DAY, ...candidates)
      .all<{ row_id: string }>();
    for (const x of r.results) recent.add(x.row_id);
  }
  for (const d of candidates.filter((id) => !recent.has(id)).slice(0, PURGES_PER_RUN).map((id) => ({ id }))) {
    try {
      await sync.purgeDocument(d.id as Sha256);
      report.trashPurged++;
    } catch (e) {
      console.warn(JSON.stringify({ event: 'trash_purge_failed', error: e instanceof Error ? e.name : 'unknown' }));
    }
  }

  // 4. Backups older than 30 days
  const oldest = new Date(now - KEEP_DAYS * DAY).toISOString().slice(0, 10);
  const listing = await env.BLOBS.list({ prefix: 'backup/', delimiter: '/' });
  for (const prefix of listing.delimitedPrefixes) {
    const date = prefix.slice('backup/'.length, -1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= oldest || report.backupFilesDeleted >= BACKUP_DELETES_PER_RUN) continue;
    const files = await env.BLOBS.list({ prefix, limit: BACKUP_DELETES_PER_RUN - report.backupFilesDeleted });
    if (files.objects.length) await env.BLOBS.delete(files.objects.map((o) => o.key));
    report.backupFilesDeleted += files.objects.length;
  }

  console.log(JSON.stringify({ event: 'daily_job', ...report }));
  return report;
}
