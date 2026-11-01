// CL5 replaces this file: the read routes behind `QueryApi` (search, documents, notes, activity, me).
import { Hono } from 'hono';
import { type AppEnv, notImplemented } from '../env';

export const queryApp = new Hono<AppEnv>();
for (const path of ['/api/search', '/api/documents', '/api/notes', '/api/activity', '/api/me']) queryApp.get(path, notImplemented('CL5'));
