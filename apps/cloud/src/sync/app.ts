// CL4 replaces this file: devices, head, pull and push, text and blob uploads, thumbnails, Forget, and the write meter.
import { Hono } from 'hono';
import { type AppEnv, notImplemented } from '../env';

export const syncApp = new Hono<AppEnv>();
for (const path of ['/api/devices', '/api/sync/*', '/api/text/*', '/api/blobs/*', '/api/thumbs/*']) syncApp.all(path, notImplemented('CL4'));
syncApp.delete('/api/documents/:sha', notImplemented('CL4'));
