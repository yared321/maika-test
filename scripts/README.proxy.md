# MAIKA Production Deployment Guide

This guide is production-only.

## Architecture

- Static site serves `site/` content.
- Proxy service runs `scripts/maika-rppg-proxy.mjs`.
- Browser calls same-origin API path: `/api/face-assess/v1/web/assess`.

## 1) Prepare required values

Required:

- `MAIKA_RPPG_UPSTREAM` (upstream base URL)  
  Example: `https://your-upstream.run.app`

Optional:

- `MAIKA_PUBLIC_KEY`
- `MAIKA_CAPTCHA_TOKEN`
- `CORS_ALLOW_ORIGIN` (recommended to set to your site origin)
- `PORT` (default `8080`)

Notes:

- Use upstream base host only (no trailing `/v1/web/assess` path).
- Keep all secrets in deployment environment variables only.

## 2) Deploy static site

Deploy the `site/` folder to your static hosting/CDN.

## 3) Deploy proxy service

Run this command in the proxy service runtime:

```bash
npm run start:proxy
```

Health endpoint:

- `/healthz` -> returns `ok`

## 4) Configure production routing (required)

Your production router/load balancer must send:

- `/*` -> static site service
- `/api/face-assess/*` -> proxy service

Without this route split, browser uploads will fail.

## 5) Verify after deployment

1. Open your live demo page.
2. Run face upload flow.
3. In browser Network tab, confirm upload requests go to:
   - `/api/face-assess/v1/web/assess`
4. Confirm request succeeds (2xx) and response payload is returned.

## 6) Troubleshooting

- `404` on `/api/face-assess/...` -> route split not configured.
- `502` from proxy -> upstream URL/network issue.
- `401/403` from upstream -> invalid/missing key/token env vars.
- CORS error -> set `CORS_ALLOW_ORIGIN` correctly.
