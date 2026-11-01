// CL13 replaces this file: server-rendered pages and the web library. Until then everything that is not an API or sign-in route
// is served from the static assets (apps/cloud/public, built by the web slice).
import { Hono } from 'hono';
import type { AppEnv } from '../env';

export const webApp = new Hono<AppEnv>();
webApp.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
