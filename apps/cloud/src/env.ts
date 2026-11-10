// The Worker's environment: bindings, variables, secrets, the Hono app type, and the D1 limit wrapper used locally.

import type { AuthContext } from './seams';

/** Which copy of the Worker this is. `local` is `wrangler dev`, the tests and `dev:test`: temporary storage, never deployed. */
export type Environment = 'local' | 'staging' | 'production';

export interface Env {
  // variables (wrangler.jsonc)
  ENVIRONMENT: Environment;
  /** The OAuth issuer and the address everything is tied to. No trailing slash. */
  PUBLIC_URL: string;
  /** The extension's fixed id (from its committed public key); its sign-in redirect is https://<id>.chromiumapp.org/oauth. */
  EXTENSION_ID: string;
  /** Database rows per day the text index may write (a number as text). Production 75000, staging 10000. */
  WRITE_BUDGET: string;
  /** Extra rows per day that only notes may use (a number as text). Staging 0. */
  NOTES_RESERVE: string;

  // storage
  /** Readings, notes and sync state. */
  META: D1Database;
  /** Page text shards: TEXT_0, TEXT_1, ... Use `textShards(env)` to list them in order. */
  TEXT_0: D1Database;
  TEXT_1?: D1Database;
  TEXT_2?: D1Database;
  TEXT_3?: D1Database;
  BLOBS: R2Bucket;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  /** Production only: "r2" serves the web library's files from the WEB bucket instead of the static assets (web/r2-assets.ts). */
  STATIC_SOURCE?: 'assets' | 'r2';
  /** The R2 bucket `sop-web` that holds the built web library, one folder per build. Production only. */
  WEB?: R2Bucket;
  /** Which build folder in WEB this Worker version serves (a hash of the files). Set by scripts/deploy-production.mjs. */
  WEB_BUILD?: string;
  RL_AUTH: RateLimit;
  RL_MCP: RateLimit;
  RL_API: RateLimit;

  // secrets (`wrangler secret put`, or GitHub secrets via the bootstrap workflow). Never in this repo.
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** The owner's numeric GitHub id. Any other account is refused. */
  ALLOWED_GITHUB_ID: string;
  SESSION_SECRET: string;
  /** Lets the nightly backup job read /api/export. Compared in constant time. */
  SOP_EXPORT_TOKEN: string;

  // local only: where GitHub lives. Honoured only when ENVIRONMENT is `local` (CL3), so a stray variable can never point
  // production's sign-in at another host.
  GITHUB_BASE_URL?: string;
  GITHUB_API_URL?: string;

  /** Optional: the Android app's signing certificate (SHA-256, `AA:BB:…`). When set, /.well-known/assetlinks.json lets the app
   * claim its sign-in address `<PUBLIC_URL>/app/oauth`. Not a secret. */
  ANDROID_CERT_SHA256?: string;
}

/** The Hono app type every area uses. `auth` is set by the sign-in middleware (CL3) before an /api handler runs. */
export interface AppEnv {
  Bindings: Env;
  Variables: { auth?: AuthContext };
}

/** The text shards that are bound, in order (TEXT_0, TEXT_1, ...). */
export function textShards(env: Env): D1Database[] {
  return Object.keys(env)
    .map((k) => /^TEXT_(\d+)$/.exec(k))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => (env as unknown as Record<string, D1Database>)[m[0]])
    .filter((d) => d !== undefined);
}

/** The reply every area stub gives until its slice replaces it. */
export function notImplemented(slice: string) {
  return (c: { json(body: unknown, status: 501): Response }): Response => c.json({ error: 'not_implemented', slice }, 501);
}

// ─── D1 limits that Miniflare does not enforce ─────────────────────────────────────────────────────────────────────────────

/** Cloudflare's free-plan D1 limits: 100 bound parameters per query, 50 queries per Worker invocation (a batch counts as one). */
export const D1_FREE_LIMITS = { maxBoundParams: 100, maxQueries: 50 } as const;

export class D1LimitError extends Error {
  constructor(message: string) {
    super(`D1_LIMIT: ${message}`);
    this.name = 'D1LimitError';
  }
}

/** Counts the queries one request makes. One per request; a batch is one query. */
export class QueryBudget {
  used = 0;
  constructor(readonly max: number = D1_FREE_LIMITS.maxQueries) {}
  spend(what: string): void {
    this.used += 1;
    if (this.used > this.max) throw new D1LimitError(`more than ${this.max} queries in one request (${what})`);
  }
}

const inner = new WeakMap<object, { stmt: D1PreparedStatement; params: number }>();

function limitStatement(stmt: D1PreparedStatement, budget: QueryBudget, maxParams: number, params = 0): D1PreparedStatement {
  // Like Cloudflare: binding too many values is not an error by itself; the query fails (as a rejected promise) when it runs.
  const run = <T>(what: string, go: () => Promise<T>): Promise<T> => {
    try {
      checkParams(params, maxParams);
      budget.spend(what);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return go();
  };
  const wrapped = {
    bind: (...values: unknown[]) => limitStatement(stmt.bind(...values), budget, maxParams, values.length),
    first: (column?: string) => run('first', () => (column === undefined ? stmt.first() : stmt.first(column))),
    run: () => run('run', () => stmt.run()),
    all: () => run('all', () => stmt.all()),
    raw: (options?: { columnNames?: boolean }) => run('raw', () => (options ? stmt.raw(options as { columnNames: true }) : stmt.raw())),
  };
  inner.set(wrapped, { stmt, params });
  return wrapped as unknown as D1PreparedStatement;
}

function checkParams(params: number, maxParams: number): void {
  if (params > maxParams) throw new D1LimitError(`${params} bound parameters in one query (the limit is ${maxParams})`);
}

/**
 * A D1 database that fails the way Cloudflare's free plan does and Miniflare does not: a query with more than 100 bound
 * parameters, or a request that runs more than 50 queries. A `batch()` is one query, as on Cloudflare. Failures are rejected
 * promises, as on Cloudflare. Wrap one database per request with a shared `QueryBudget`. Applied to every binding when
 * ENVIRONMENT is `local`, so a handler that would break on Cloudflare breaks here first.
 */
export function limitD1(db: D1Database, budget: QueryBudget, maxParams: number = D1_FREE_LIMITS.maxBoundParams): D1Database {
  const limited = {
    prepare: (sql: string) => limitStatement(db.prepare(sql), budget, maxParams),
    batch: (statements: D1PreparedStatement[]) => {
      try {
        const real = statements.map((s) => {
          const i = inner.get(s);
          if (i) checkParams(i.params, maxParams);
          return i?.stmt ?? s;
        });
        budget.spend('batch');
        return db.batch(real);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    exec: (sql: string) => {
      try {
        budget.spend('exec');
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      return db.exec(sql);
    },
    withSession: () => {
      throw new D1LimitError('withSession is not supported through limitD1');
    },
    dump: () => db.dump(),
  };
  return limited as unknown as D1Database;
}

/** The environment with every D1 binding limited, sharing one query budget. Use per request (or per cron run). */
export function withD1Limits(env: Env, budget: QueryBudget = new QueryBudget()): Env {
  const out: Record<string, unknown> = { ...env };
  for (const [k, v] of Object.entries(env)) {
    if (k === 'META' || /^TEXT_\d+$/.test(k)) out[k] = limitD1(v as D1Database, budget);
  }
  return out as unknown as Env;
}
