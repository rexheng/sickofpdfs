// The site Worker (spec R111). The pages and pictures are static files (public/, made by scripts/build.mjs) that Cloudflare
// serves without running this code. Only /api/* comes here, plus the daily job.

import { countResponse, refreshStoreUsers } from './count';
import type { Env } from './env';
import { json } from './http';
import { joinWaitlist, waitlistConfig } from './waitlist';

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (pathname === '/api/count') {
      if (method === 'GET' || method === 'HEAD') return countResponse(env);
      return notAllowed('GET');
    }
    if (pathname === '/api/waitlist') {
      if (method === 'POST') return joinWaitlist(request, env);
      if (method === 'GET' || method === 'HEAD') return waitlistConfig(env);
      return notAllowed('GET, POST');
    }
    if (pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env): Promise<void> {
    await refreshStoreUsers(env);
  },
} satisfies ExportedHandler<Env>;

function notAllowed(allow: string): Response {
  const res = json({ error: 'method_not_allowed' }, 405);
  res.headers.set('allow', allow);
  return res;
}
