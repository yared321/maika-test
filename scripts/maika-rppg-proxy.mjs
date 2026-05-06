#!/usr/bin/env node
/**
 * Production-oriented API proxy for face upload.
 *
 * Exposes:
 *   - /api/face-assess/* -> MAIKA_RPPG_UPSTREAM/*
 *   - /healthz    -> 200 ok
 *
 * Intended deployment:
 *   - Run as a backend service behind your domain/reverse-proxy
 *   - Keep secrets in environment variables only
 *
 * Required env:
 *   - MAIKA_RPPG_UPSTREAM (example: https://your-upstream.run.app)
 *
 * Optional env:
 *   - PORT (default 8080)
 *   - MAIKA_PUBLIC_KEY
 *   - MAIKA_CAPTCHA_TOKEN
 *   - CORS_ALLOW_ORIGIN (default "*")
 */
import http from "node:http";
import https from "node:https";

const PORT = Number(process.env.PORT) || 8080;
const PROXY_PREFIX = "/api/face-assess";
const UPSTREAM = String(process.env.MAIKA_RPPG_UPSTREAM || "").replace(/\/+$/, "");
const PUBLIC_KEY = String(process.env.MAIKA_PUBLIC_KEY || "").trim();
const CAPTCHA_TOKEN = String(process.env.MAIKA_CAPTCHA_TOKEN || "").trim();
const CORS_ALLOW_ORIGIN = String(process.env.CORS_ALLOW_ORIGIN || "*");

if (!UPSTREAM) {
  console.error("Missing required env: MAIKA_RPPG_UPSTREAM");
  process.exit(1);
}

function stripHopByHop(headers) {
  const out = { ...headers };
  const drop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const k of Object.keys(out)) {
    if (drop.has(k.toLowerCase())) delete out[k];
  }
  return out;
}

function corsHeaders(req) {
  const reqHdr = req.headers["access-control-request-headers"];
  return {
    "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      reqHdr || "Content-Type, Accept, Accept-Language",
    "Access-Control-Max-Age": "86400",
  };
}

function proxyAssess(req, res) {
  const localUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const upstreamPath = localUrl.pathname.slice(PROXY_PREFIX.length) || "/";
  const upstreamUrl = new URL(upstreamPath + localUrl.search, UPSTREAM + "/");
  const isHttps = upstreamUrl.protocol === "https:";
  const lib = isHttps ? https : http;

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  const headers = stripHopByHop(req.headers);
  headers.host = upstreamUrl.host;

  // Never trust client-sent key/captcha headers in production.
  delete headers["x-maika-public-key"];
  delete headers["X-Maika-Public-Key"];
  delete headers["x-maika-captcha-token"];
  delete headers["X-Maika-Captcha-Token"];

  // Inject server-side secrets/keys from environment.
  if (PUBLIC_KEY) headers["X-Maika-Public-Key"] = PUBLIC_KEY;
  if (CAPTCHA_TOKEN) headers["X-Maika-Captcha-Token"] = CAPTCHA_TOKEN;

  const preq = lib.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (isHttps ? 443 : 80),
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: req.method,
      headers,
    },
    (pres) => {
      const out = stripHopByHop(pres.headers);
      out["access-control-allow-origin"] = CORS_ALLOW_ORIGIN;
      res.writeHead(pres.statusCode || 502, out);
      pres.pipe(res);
    },
  );

  preq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end(`Proxy error: ${err && err.message ? err.message : err}`);
  });

  req.pipe(preq);
}

const server = http.createServer((req, res) => {
  const localUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (localUrl.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  if (
    localUrl.pathname === PROXY_PREFIX ||
    localUrl.pathname.startsWith(PROXY_PREFIX + "/")
  ) {
    proxyAssess(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.error(
    `MAIKA API proxy listening on :${PORT}\n` +
      `  ${PROXY_PREFIX}/... -> ${UPSTREAM}/...`,
  );
});
