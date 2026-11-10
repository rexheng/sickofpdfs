// The door for the library reads (/api/search ... and /mcp): who is calling, and may they read. The sign-in code (CL3) does the
// real checking; this only asks it, or uses what its middleware already set, and checks the scope.
import type { Context } from 'hono';
import type { AppEnv } from './env';
import { type AuthContext, wiring } from './seams';

export function unauthorized(env: { PUBLIC_URL: string }, resource: 'api' | 'mcp', error = 'invalid_token'): Response {
  const metadata = `${env.PUBLIC_URL}/.well-known/oauth-protected-resource/${resource}`;
  return new Response(JSON.stringify({ error, error_description: 'sign in first' }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'www-authenticate': `Bearer resource_metadata="${metadata}"` },
  });
}

export function forbidden(env: { PUBLIC_URL: string }, resource: 'api' | 'mcp', scope: string): Response {
  const metadata = `${env.PUBLIC_URL}/.well-known/oauth-protected-resource/${resource}`;
  return new Response(JSON.stringify({ error: 'insufficient_scope', error_description: `this token needs the ${scope} permission` }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${metadata}"` },
  });
}

/** The caller, or the Response to send. A cookie session may do everything its owner may; a token needs one of `scopes`. */
export async function requireScope(c: Context<AppEnv>, resource: 'api' | 'mcp', scopes: string[]): Promise<AuthContext | Response> {
  let auth: AuthContext | Response | undefined = c.get('auth');
  if (auth === undefined) {
    if (wiring.authenticate === null) return unauthorized(c.env, resource);
    auth = await wiring.authenticate(c.req.raw, c.env);
  }
  if (auth instanceof Response) return auth;
  if (auth.kind === 'bearer' && !scopes.some((s) => auth.scopes.includes(s))) return forbidden(c.env, resource, scopes[0] ?? '');
  return auth;
}
