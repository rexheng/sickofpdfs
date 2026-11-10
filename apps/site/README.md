# apps/site

The public site (spec R111, R112): one plain page, a privacy page, the cloud sync waitlist and a real count.
A Cloudflare Worker with static files and one D1 database. Nothing here is created on Cloudflare until the owner says OK.

- `src/pages/` makes the pages. `scripts/build.mjs` writes them to `public/` (gitignored) before every `wrangler dev` and `wrangler deploy`.
- `src/worker.ts` answers `/api/*` only. Cloudflare serves the pages itself, without running the Worker.
- The ElevenReader link comes from `packages/core/src/links.ts` (`ELEVENREADER_STUDENT_URL`), unchanged.
- `public/elevenlabs-logo-black.svg` is ElevenLabs' own logo file from <https://elevenlabs.io/brand>, unaltered. Keep clear space equal to its height around it.

## API

| Call | Answer |
| --- | --- |
| `GET /api/count` | `{ waitlist: number, users: number \| null }` |
| `GET /api/waitlist` | `{ siteKey: string \| null }`: the public Turnstile key the form needs |
| `POST /api/waitlist` `{ email, turnstileToken }` | `{ ok: true }`, or `{ ok: false, reason }` with reason `invalid_email`, `bot_check`, `rate_limited`, `origin`, `bad_request` or `unavailable` |

`users` stays null until `CWS_ITEM_ID` is set. Then a daily job reads the public user count from the Chrome Web Store listing.

## Keys

Two values, never in the repo:

- `TURNSTILE_SITE_KEY`: the widget's public site key.
- `TURNSTILE_SECRET_KEY`: its secret key.

**Locally:** copy `.dev.vars.example` to `.dev.vars` and paste Cloudflare's test keys (the "always passes" pair) from
<https://developers.cloudflare.com/turnstile/troubleshooting/testing/>.

**In production:** make a Turnstile widget in the Cloudflare dashboard (Turnstile → Add widget, mode "Managed", hostname = the site's domain). Then:

```sh
npx wrangler secret put TURNSTILE_SITE_KEY --env production
npx wrangler secret put TURNSTILE_SECRET_KEY --env production
```

## Run it locally

```sh
pnpm -C apps/site db:local   # once: makes the local database in .wrangler/
pnpm -C apps/site dev        # http://localhost:8787
```

To run the daily job: `npx wrangler dev --local --test-scheduled`, then open `/__scheduled`.

## Settings (`wrangler.jsonc`, `vars`)

| Name | Meaning |
| --- | --- |
| `SITE_ORIGIN` | The site's address. Empty: the Worker uses the address it was called on. |
| `CONTACT_EMAIL` | Shown on the privacy page. A production build stops while it is empty. |
| `CWS_ITEM_ID` | The Chrome Web Store listing id. Empty: "Coming soon", and no user count. |
| `PLAY_APP_ID` | The Google Play app id, once the listing is live. Empty: "Coming soon". |

## Deploying (only with the owner's OK)

1. `npx wrangler d1 create sop_site`, and put its id in `env.production.d1_databases` (replacing `REPLACE_AT_DEPLOY`).
2. Fill `CONTACT_EMAIL` (and `SITE_ORIGIN` once there is a domain) in `env.production.vars`.
3. Make the Turnstile widget and put both keys as secrets (above).
4. `npx wrangler d1 migrations apply SITE_DB --remote --env production`
5. `npx wrangler deploy --env production`
6. Set `SOP_SITE_ORIGIN` for the extension build, so Settings → Cloud can link to the waitlist.

## Deployed (Nov 10, owner's OK)

- Account: "Ripostenigma@gmail.com's Account". Address: https://sickofpdfs-site.rexheng-policy.workers.dev
- D1 `sop_site` (id in `wrangler.jsonc`), migration 0001 applied. Turnstile widget "sickofpdfs waitlist"; both keys are Worker secrets.
- This deploy went through the Cloudflare API without Wrangler (no API token on the build machine), so the pages are served by a small wrapper Worker that holds the built files, with the same headers as `public/_headers`. With an API token, `npx wrangler deploy --env production` replaces it with the normal static-assets setup.
