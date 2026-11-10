// The Worker entry. All real work is in the areas under src/*; this only builds the app and, in `local`, wraps every D1
// binding with the free-plan limits that Miniflare does not enforce (100 bound parameters, 50 queries per request). In
// production it also puts the R2-backed web library files in place of the static assets.
import { createApp } from './routes';
import { type Env, withD1Limits } from './env';
import { scheduled as dailyJob } from './export/app';
import { r2Assets } from './web/r2-assets';

const app = createApp();

// Production serves the web library's files from R2 (web/r2-assets.ts); local and staging use the static assets.
const withFiles = (env: Env): Env => (env.STATIC_SOURCE === 'r2' ? { ...env, ASSETS: r2Assets(env) } : env);
const forThisRun = (env: Env): Env => withFiles(env.ENVIRONMENT === 'local' ? withD1Limits(env) : env);

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, forThisRun(env), ctx);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(dailyJob(event, forThisRun(env)));
  },
} satisfies ExportedHandler<Env>;
