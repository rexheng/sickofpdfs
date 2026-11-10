// JSON answers for /api/*. The pages get their headers from public/_headers (scripts/build.mjs); these are the Worker's own.

export function json(body: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
      'x-content-type-options': 'nosniff',
    },
  });
}

/** The site's own origin: SITE_ORIGIN when it is set, otherwise the origin this request was sent to. */
export function siteOrigin(configured: string, request: Request): string {
  return configured.trim().replace(/\/+$/, '') || new URL(request.url).origin;
}
