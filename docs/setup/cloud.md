# Your own cloud (Release 2): one-time setup

This puts your library on your own Cloudflare account, so it syncs between your computers, your phone and the web.
It takes about 40 minutes. You need no developer tools on your PC: everything runs in your browser and on GitHub.

**Nothing is created on Cloudflare until you run step 6 yourself.** Do staging first. Do production only after staging works.

## What you will have at the end

- **Staging**: a practice copy at `https://sickofpdfs-staging.<your-subdomain>.workers.dev`. Build agents may use it. It has its own small databases and its own GitHub sign-in.
- **Production**: your real library at `https://sickofpdfs.<your-subdomain>.workers.dev`. It changes only when you tag a release, and only after a restore point is saved.
- Only your GitHub account can sign in. Anyone else sees "This library is private".

## Steps

### 1. Cloudflare account (5 minutes)

1. Sign in to [dash.cloudflare.com](https://dash.cloudflare.com) (or make a free account).
2. Open **Workers & Pages**. If it asks, pick your **workers.dev subdomain**. Choose carefully: the extension and the Claude connector are tied to this address.
3. Open **R2** and turn it on. Cloudflare may ask for a card. Your use stays inside the free amount.
4. Copy your **Account ID** (on the right of the Workers & Pages overview). You need it in step 4.

### 2. A Cloudflare API token for the first setup (5 minutes)

**My Profile → API Tokens → Create Token → Custom token.** Give it these permissions, for your account only:

| Permission | Level |
| --- | --- |
| Account · D1 | Edit |
| Account · Workers R2 Storage | Edit |
| Account · Workers KV Storage | Edit |
| Account · Workers Scripts | Edit |
| Account · Account Settings | Read |
| User · Memberships | Read |
| User · User Details | Read |

Copy the token. You see it only once.

### 3. Two GitHub OAuth Apps (10 minutes)

GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**. Make two:

| | Staging | Production |
| --- | --- | --- |
| Application name | sickofpdfs staging | sickofpdfs |
| Homepage URL | `https://sickofpdfs-staging.<your-subdomain>.workers.dev` | `https://sickofpdfs.<your-subdomain>.workers.dev` |
| Authorization callback URL | `https://sickofpdfs-staging.<your-subdomain>.workers.dev/oauth/github/callback` | `https://sickofpdfs.<your-subdomain>.workers.dev/oauth/github/callback` |

Leave "Enable Device Flow" off. For each app, copy the **Client ID** and make a **client secret**.

### 4. Secrets in the repository (10 minutes)

In **rexheng/sickofpdfs → Settings → Secrets and variables → Actions → New repository secret**, add:

| Name | What to put in it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | your Account ID from step 1 |
| `ALLOWED_GITHUB_ID` | your GitHub account's **number**. Open `https://api.github.com/users/<your GitHub name>` and copy the `"id"` value |
| `SESSION_SECRET` | a long random text, at least 32 characters. A password manager can make one |
| `GH_OAUTH_STAGING_CLIENT_ID` | the staging app's Client ID |
| `GH_OAUTH_STAGING_CLIENT_SECRET` | the staging app's client secret |
| `GH_OAUTH_PRODUCTION_CLIENT_ID` | the production app's Client ID |
| `GH_OAUTH_PRODUCTION_CLIENT_SECRET` | the production app's client secret |

GitHub does not allow secret names that start with `GITHUB_`, so the app secrets start with `GH_OAUTH_`.

You do not make the other Worker secrets yourself. The setup makes them from `SESSION_SECRET`, one set for staging and a different set for production, so a staging secret can never open production:

- `SESSION_SECRET` (on the Worker): signs the web library's sign-in.
- `SOP_EXPORT_TOKEN`: lets the nightly backup read your library. Nothing else can use it.

### 5. Two GitHub environments (2 minutes)

**Settings → Environments → New environment**: make `staging` and `production`. For `production`, tick **Required reviewers** and add yourself. Then nothing changes production without your click.

### 6. Create staging (5 minutes) — this is OK #1

1. **Actions → Bootstrap cloud → Run workflow.** Choose `staging`. Leave **Only print what would happen** ticked. Run it, and read what it would do.
2. Run it again with that box **unticked**. It creates two databases, a bucket, a key-value store and the Worker, sets the secrets, saves the new ids in the repository, and runs the smoke test.
3. Open the staging address. You see "Sign in". Sign in with GitHub.

### 7. Create production — this is OK #2

Only after staging works. Run **Bootstrap cloud** with `production` (print first, then for real). Then tag a release (`v…`) and run **Deploy cloud (production)** on that tag. It saves a restore point first.

### 8. Swap to a narrower token

The first token can create things. After step 7, make a second token with only **D1 Edit**, **Workers Scripts Edit** and **Account Settings Read**, and put it in `CLOUDFLARE_API_TOKEN` instead.

### 9. Connect your apps

- **Extension**: Settings → Cloud → Connect, and sign in with GitHub.
- **Claude**: claude.ai → Settings → Connectors → Add custom connector. Name it "My readings", use the address ending in `/mcp`, choose **Use Claude's published identity**, and sign in with GitHub. On the next page, **Allow** lets Claude read and add comments; **Allow reading only** lets it read.
- **Turning Claude off**: the web library's Settings has a switch. Off means Claude gets nothing until you turn it on again.

## Day to day

| Workflow | When | What it does |
| --- | --- | --- |
| Cloud CI | by hand | checks the code and runs the tests; no secrets |
| Deploy cloud (staging) | by hand | updates staging, then the smoke test |
| Deploy cloud (production) | by hand, on a `v…` tag | restore point, then update, then the smoke test |
| Cloud backup | by hand now; nightly after setup | copies your library into the Worker's own storage, kept 30 days |

To turn on the nightly backup, remove the `#` signs in front of `schedule:` in `.github/workflows/cloud-backup.yml`.

## If something goes wrong

- **Undo a bad production update.** Open the run of **Deploy cloud (production)**. Its summary shows one line per database, like `wrangler d1 time-travel restore sop_meta --bookmark … --env production`. Running those lines puts the databases back to just before the update. Restore points last 7 days.
- **The daily limit.** Cloudflare's free plan allows 100,000 database rows written a day. Page text stops at 75,000 (staging 10,000), so your notes always have room. Text continues after midnight UTC. Notes are never refused before page text is.
- **A computer is lost.** In the web library's Settings, remove its connection. Its sign-in stops working at once.

## What is where (for whoever helps you)

- `apps/cloud/wrangler.jsonc`: the three copies (`local`, `staging`, `production`). Ids are placeholders until bootstrap fills them.
- `apps/cloud/scripts/`: `bootstrap.mjs`, `restore-point.mjs`, `smoke.mjs`, `backup.mjs`, `env-info.mjs`. Each one has `--dry-run` or works against the local Worker (`pnpm -C apps/cloud dev:test`).
- The Worker's addresses are listed in the Phase 5–6 plan, "Contract additions", CA3 and CA11.
