// CL3 replaces this file: the OAuth authorization server, the /mcp and /api resource servers, GitHub sign-in locked to the
// owner's numeric id, the cookie session for the web, /api/grants, and `authenticate(req, env)`.
import { Hono } from 'hono';
import { type AppEnv, notImplemented } from '../env';

export const authApp = new Hono<AppEnv>();
for (const path of ['/authorize', '/oauth/*', '/login', '/logout', '/.well-known/*', '/api/grants', '/api/grants/*']) authApp.all(path, notImplemented('CL3'));
