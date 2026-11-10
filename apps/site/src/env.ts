// The site Worker's environment: settings (wrangler.jsonc `vars`), secrets and bindings.

export interface Env {
  // settings (wrangler.jsonc). Empty text means "not set".
  /** The site's address, such as https://sickofpdfs.com, with no trailing slash. Empty: the address the Worker was called on. */
  SITE_ORIGIN: string;
  /** The Chrome Web Store listing id (32 letters a–p). Empty until the listing exists: then `users` stays null. */
  CWS_ITEM_ID: string;

  // secrets: .dev.vars locally, `wrangler secret put` in production. Never in the repo.
  /** Turnstile's public site key. Kept out of the repo like the secret, so the repo holds no key-shaped text. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;

  // bindings
  SITE_DB: D1Database;
  ASSETS: Fetcher;
  RL_WAITLIST: RateLimit;
}
