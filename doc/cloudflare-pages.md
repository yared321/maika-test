# Cloudflare Pages (optional dev / second host)

Netlify remains the source of truth via `netlify.toml`. This repo adds a **parallel** setup for **Cloudflare Pages**:

- **`wrangler.toml`** — Pages output directory `site/`, project name for Wrangler.
- **`functions/`** — [Pages Functions](https://developers.cloudflare.com/pages/functions/) (Fetch / `Request` API), **not** Netlify’s `handler(event)` shape.
- **`site/_routes.json`** — Invokes Functions only for `/api/*` and `/healthz` so normal static files are not billed as Worker invocations.

## Local dev (Wrangler)

1. `npm install`
2. Copy **`.dev.vars.example`** → **`.dev.vars`** and fill secrets (same semantics as Netlify / `.env.local`). **Do not commit `.dev.vars`**.
3. Run:

   ```bash
   npm run dev:pages
   ```

   This runs `npm run build` then **`wrangler pages dev site`**. Open the URL Wrangler prints (often `http://localhost:8788`).

**Netlify-like dev without Wrangler** is still `npm run dev` (the Node `maika-dev-proxy`).

## Deploy to Cloudflare Pages

1. Create a Pages project in the dashboard and connect this Git repo, **or** use the CLI after login:

   ```bash
   npm run build
   npm run deploy:pages
   ```

   The first time, Wrangler may ask you to select or create a project.

2. In **Pages → Settings → Environment variables**, define the same bindings you use on Netlify (e.g. `DEMO_ACCESS_CODES`, `TURNSTILE_SECRET_KEY`, Upstash URL/token, `MAIKA_RPPG_*`, `DEMO_CODE_ADMIN_SECRET`, etc.).

## Route parity (Netlify redirects)

| Path | Pages Function |
|------|----------------|
| `/healthz` | `functions/healthz.js` |
| `/api/demo-verify` | `functions/api/demo-verify.js` |
| `/api/demo-code-create` | `functions/api/demo-code-create.js` |
| `/api/demo-code-revoke` | `functions/api/demo-code-revoke.js` |
| `/api/face-assess`, `/api/face-assess/...` | `functions/api/face-assess/index.js`, `functions/api/face-assess/[[path]].js` |
| `/api/diag-maika-env` | `functions/api/diag-maika-env.js` |

Shared Redis/helpers live under **`functions/_lib/`**. Dynamic codes use **`@upstash/redis/cloudflare`** (`Redis.fromEnv(env)`).
