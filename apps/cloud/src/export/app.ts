// CL7 replaces this file: GET /api/export/:table, PUT /api/backup/:date/:part (both take the export token), and the daily job.
import { Hono } from 'hono';
import { type AppEnv, type Env, notImplemented } from '../env';

export const exportApp = new Hono<AppEnv>();
exportApp.all('/api/export/*', notImplemented('CL7'));
exportApp.all('/api/backup/*', notImplemented('CL7'));

/** The cron trigger (17 3 * * *): prune backups, stale uploads and old audit rows, purge Trash after 30 days. */
export const scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => Promise<void> = () => Promise.resolve();
