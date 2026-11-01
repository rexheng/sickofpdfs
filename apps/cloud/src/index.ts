// The Worker entry. All real work is in the areas under src/*; this only builds the app and, in `local`, wraps every D1
// binding with the free-plan limits that Miniflare does not enforce (100 bound parameters, 50 queries per request).
import { createApp } from './routes';
import { type Env, withD1Limits } from './env';
import { scheduled as dailyJob } from './export/app';

const app = createApp();

const forThisRun = (env: Env): Env => (env.ENVIRONMENT === 'local' ? withD1Limits(env) : env);

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, forThisRun(env), ctx);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(dailyJob(event, forThisRun(env), ctx));
  },
} satisfies ExportedHandler<Env>;
