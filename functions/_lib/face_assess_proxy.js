/** @typedef {Record<string, string | undefined>} CfEnv */

import { readEnv } from "./cf_http.js";

const PROXY_PREFIX = "/api/face-assess";

function stripHopByHop(hdrs) {
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
  const out = new Headers();
  hdrs.forEach((value, key) => {
    if (!drop.has(key.toLowerCase())) out.append(key, value);
  });
  return out;
}

function corsOptionsHeaders(request, allowOrigin) {
  const reqHdr =
    request.headers.get("access-control-request-headers") ||
    "Content-Type, Accept, Accept-Language";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": reqHdr,
    "Access-Control-Max-Age": "86400",
  };
}

function responseHeadersFromFetch(res, corsAllowOrigin) {
  const out = new Headers(res.headers);
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
  drop.forEach((k) => out.delete(k));
  out.set("access-control-allow-origin", corsAllowOrigin);
  return out;
}

/**
 * Proxies `/api/face-assess/*` → MAIKA_RPPG_UPSTREAM (parity with Netlify face-assess-proxy).
 * @param {Request} request
 * @param {CfEnv} env
 */
export async function proxyFaceAssess(request, env) {
  const corsAllowOrigin = readEnv(env, "CORS_ALLOW_ORIGIN", "*");
  const upstreamBase = readEnv(env, "MAIKA_RPPG_UPSTREAM").replace(/\/+$/, "");
  const publicKey = readEnv(env, "MAIKA_PUBLIC_KEY");
  const captchaToken = readEnv(env, "MAIKA_CAPTCHA_TOKEN");

  if (!upstreamBase) {
    return new Response("Missing MAIKA_RPPG_UPSTREAM", {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": corsAllowOrigin,
      },
    });
  }

  const url = new URL(request.url);
  let pathname = url.pathname.split("?")[0] || "";
  pathname = pathname.replace(/\/+$/, "") || "/";

  if (
    pathname !== PROXY_PREFIX &&
    !pathname.startsWith(`${PROXY_PREFIX}/`)
  ) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: corsOptionsHeaders(request, corsAllowOrigin),
    });
  }

  const upstreamPathTail = pathname.slice(PROXY_PREFIX.length) || "/";
  const normalizedPath =
    upstreamPathTail.startsWith("/") ? upstreamPathTail : `/${upstreamPathTail}`;
  const upstreamUrl = `${upstreamBase}${normalizedPath}${url.search}`;

  let upstreamHost = "";
  try {
    upstreamHost = new URL(upstreamBase).host;
  } catch (_) {}

  const fwdHeaders = stripHopByHop(request.headers);
  fwdHeaders.delete("x-maika-public-key");
  fwdHeaders.delete("X-Maika-Public-Key");
  fwdHeaders.delete("x-maika-captcha-token");
  fwdHeaders.delete("X-Maika-Captcha-Token");
  fwdHeaders.delete("Host");
  if (upstreamHost) fwdHeaders.set("Host", upstreamHost);

  if (publicKey) fwdHeaders.set("X-Maika-Public-Key", publicKey);
  if (captchaToken) fwdHeaders.set("X-Maika-Captcha-Token", captchaToken);

  /** @type {RequestInit} */
  const init = {
    method,
    headers: fwdHeaders,
    redirect: "manual",
  };

  if (method !== "GET" && method !== "HEAD") {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 0) init.body = buf;
  }

  try {
    const upstreamRes = await fetch(upstreamUrl, init);
    const outBody = await upstreamRes.text();
    return new Response(outBody, {
      status: upstreamRes.status || 502,
      headers: responseHeadersFromFetch(upstreamRes, corsAllowOrigin),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Proxy error: ${msg}`, {
      status: 502,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": corsAllowOrigin,
      },
    });
  }
}
