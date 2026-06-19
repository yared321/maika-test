# MAIKA Production Deployment Guide

This guide is production-only.

## Architecture

- Static site serves `site/` content.
- Either:
  - **Netlify Functions** — `netlify/functions/face-assess-proxy.mjs` (see below), or
  - a separate **Node proxy** — `scripts/maika-rppg-proxy.mjs` behind your own router.
- Browser calls same-origin API paths under `/api/face-assess/v1/web/`:
  - `assess-baseline` — first (baseline) wizard scan
  - `assess-post` — second (post-music) scan, requires `baseline_token`
  - `assess` — legacy single-step path (standalone/non-wizard uploads only)

---

## Option A — Netlify Functions (this repo)

Uses `netlify.toml` (publish `site/`, rewrite `/api/face-assess/*` → the function) plus `netlify/functions/face-assess-proxy.mjs`. Secrets are the same as the Node proxy; inject them in the Netlify UI under **Site configuration → Environment variables** (scope **Functions**).

**Health check:** `GET /healthz` (served by `netlify/functions/healthz.mjs`).

**Important platform limits** (see [Netlify Functions overview](https://docs.netlify.com/build/functions/overview/)):

- Synchronous functions: **60s** execution budget (including waiting on the upstream assess call). The demo client uses a longer timeout; slow upstreams may hit this limit before the browser does.
- Buffered request/response payloads: **6 MB** (multipart video uploads count as binary; Netlify notes **~4.5 MB** effective size after Base64 handling for binary bodies). Large recordings may need the standalone Node proxy instead.
- Response streaming has different limits; this function returns the upstream response body as streamed when possible, but the **incoming** multipart body is still subject to the request cap.

**Deploy:** connect the repo to Netlify (build command can be empty; `netlify.toml` sets `publish = "site"`). No separate `PORT` is used for the proxy on Netlify.

**Local check:** `netlify dev` from the repo root (loads redirects and functions).

**If the function returns `Missing MAIKA_RPPG_UPSTREAM`:**

1. After creating or editing variables in the Netlify UI, **run a new deploy** that runs the Netlify **build** (env is attached when functions are packaged). Use **Deploys → Trigger deploy → Clear cache and deploy**, or `netlify deploy --build --prod`. Uploading **only** the `site/` folder in the dashboard **does not** repackage functions with new env — use CLI `--build`, Git-backed deploys, or a full deploy workflow.
2. Open `https://YOUR_SITE/.netlify/functions/diag-maika-env` — if `"maikaUpstreamConfigured": false`, Netlify never injected the variable into this Lambda (wrong site, wrong deploy type, or need redeploy).
3. If the repo is public, check **Sensitive variable policy**.
4. Key must be exactly `MAIKA_RPPG_UPSTREAM` under this **site**.

---

## Option B — Standalone Node proxy (`maika-rppg-proxy.mjs`)

### 1) Prepare required values

Required:

- `MAIKA_RPPG_UPSTREAM` (upstream base URL)  
  Example: `https://your-upstream.run.app`

Optional:

- `MAIKA_PUBLIC_KEY`
- `MAIKA_CAPTCHA_TOKEN`
- `CORS_ALLOW_ORIGIN` (recommended to set to your site origin)
- `PORT` (default `8080`; used only by the standalone Node proxy, not by Netlify Functions)

Notes:

- Use upstream base host only (no trailing `/v1/web/assess` path).
- Keep all secrets in deployment environment variables only.

### 2) Deploy static site

Deploy the `site/` folder to your static hosting/CDN.

### 3) Deploy proxy service

Run this command in the proxy service runtime:

```bash
npm run start:proxy
```

Health endpoint:

- `/healthz` -> returns `ok`

### 4) Configure production routing (required)

Your production router/load balancer must send:

- `/*` -> static site service
- `/api/face-assess/*` -> proxy service

Without this route split, browser uploads will fail.

### 5) Verify after deployment

1. Open your live demo page.
2. Run face upload flow.
3. In browser Network tab, confirm wizard upload requests go to:
   - `/api/face-assess/v1/web/assess-baseline` (step 1)
   - `/api/face-assess/v1/web/assess-post` with `baseline_token` (step 3)
4. Confirm each request succeeds (2xx) and response payload is returned.

### 6) Troubleshooting

- `404` on `/api/face-assess/...` -> route split not configured (standalone proxy), or rewrite/function misconfiguration on Netlify.
- `502` from proxy -> upstream URL/network issue.
- `401/403` from upstream -> invalid/missing key/token env vars.
- CORS error -> set `CORS_ALLOW_ORIGIN` correctly.
- **Netlify Functions:** `413`/payload errors or flaky uploads → body likely over ~4.5 MB effective; use Option B or shorter recordings.
- **Netlify Functions:** timeout / `504`-style failures while upstream is still scoring → synchronous **60s** limit exceeded; shorten processing or host the proxy outside Netlify.
