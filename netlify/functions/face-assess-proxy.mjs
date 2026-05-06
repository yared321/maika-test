/**
 * Netlify Function: proxies /api/face-assess/* to MAIKA_RPPG_UPSTREAM.
 * Uses Lambda-compatible `handler` so runtime env vars from the dashboard are reliably in `process.env`.
 * @see https://docs.netlify.com/build/functions/environment-variables/
 */

const PROXY_PREFIX = "/api/face-assess";

function readEnv(key, fallback = "") {
  const p =
    typeof process !== "undefined" && process.env
      ? process.env[key]
      : undefined;
  if (p != null && String(p).trim() !== "") return String(p).trim();
  return fallback;
}

function getHeader(headers, name) {
  const want = String(name).toLowerCase();
  if (!headers) return "";
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return headers[k];
  }
  return "";
}

function eventHeadersToFetchHeaders(headers, multiHeaders) {
  const h = new Headers();
  if (multiHeaders && Object.keys(multiHeaders).length) {
    for (const [key, vals] of Object.entries(multiHeaders)) {
      const list = Array.isArray(vals) ? vals : [vals];
      for (const v of list) if (v != null && v !== "") h.append(key, v);
    }
    return h;
  }
  for (const [key, val] of Object.entries(headers || {})) {
    if (val != null && val !== "") h.append(key, String(val));
  }
  return h;
}

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

function corsOptionsHeaders(headers, allowOrigin) {
  const reqHdr =
    getHeader(headers, "access-control-request-headers") ||
    "Content-Type, Accept, Accept-Language";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": reqHdr,
    "Access-Control-Max-Age": "86400",
  };
}

function resolvePathname(event) {
  const oh =
    getHeader(event.headers, "x-netlify-original-pathname") ||
    getHeader(event.headers, "X-Netlify-Original-Pathname");
  if (oh) {
    const base = oh.split("?")[0];
    return base.startsWith("/") ? base : `/${base}`;
  }
  const p = event.path || event.rawPath || "";
  return String(p.split("?")[0] || "");
}

function resolveSearch(event) {
  if (typeof event.rawQuery === "string" && event.rawQuery.length)
    return `?${event.rawQuery}`;
  const q = event.queryStringParameters;
  if (q && Object.keys(q).length)
    return `?${new URLSearchParams(q).toString()}`;
  const p = event.path || event.rawPath || "";
  const i = p.indexOf("?");
  return i >= 0 ? p.slice(i) : "";
}

/** API Gateway REST vs HTTP API v2 both appear on Netlify; v2 uses requestContext.http.method. */
function httpMethodFromEvent(event) {
  const m =
    event.httpMethod ||
    event.requestContext?.http?.method ||
    event.requestContext?.httpMethod;
  return String(m || "GET").toUpperCase();
}

function responseHeadersFromFetch(res, corsAllowOrigin) {
  const out = {};
  res.headers.forEach((v, k) => {
    out[k] = v;
  });
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
  out["access-control-allow-origin"] = corsAllowOrigin;
  return out;
}

export const handler = async (event, _context) => {
  const corsAllowOrigin = readEnv("CORS_ALLOW_ORIGIN", "*");
  const upstreamBase = readEnv("MAIKA_RPPG_UPSTREAM").replace(/\/+$/, "");
  const publicKey = readEnv("MAIKA_PUBLIC_KEY");
  const captchaToken = readEnv("MAIKA_CAPTCHA_TOKEN");

  if (!upstreamBase) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": corsAllowOrigin,
      },
      body: "Missing MAIKA_RPPG_UPSTREAM",
    };
  }

  const pathname = resolvePathname(event);
  const search = resolveSearch(event);

  if (
    pathname !== PROXY_PREFIX &&
    !pathname.startsWith(`${PROXY_PREFIX}/`)
  ) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "Not found",
    };
  }

  const method = httpMethodFromEvent(event);

  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsOptionsHeaders(event.headers, corsAllowOrigin),
      body: "",
    };
  }

  const upstreamPath =
    pathname.slice(PROXY_PREFIX.length) || "/";
  const base = upstreamBase;
  const normalizedPath =
    upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`;
  const qs = search.startsWith("?") ? search : "";
  const upstreamUrl = `${base}${normalizedPath}${qs}`;

  let upstreamHost = "";
  try {
    upstreamHost = new URL(base).host;
  } catch (_) {}

  const fwdHeaders = stripHopByHop(
    eventHeadersToFetchHeaders(
      /** @type {Record<string,string>} */
      event.headers || {},
      /** @type {Record<string,string[]>} */
      event.multiValueHeaders,
    ),
  );

  fwdHeaders.delete("x-maika-public-key");
  fwdHeaders.delete("X-Maika-Public-Key");
  fwdHeaders.delete("x-maika-captcha-token");
  fwdHeaders.delete("X-Maika-Captcha-Token");
  fwdHeaders.delete("Host");
  if (upstreamHost) fwdHeaders.set("Host", upstreamHost);

  if (publicKey) fwdHeaders.set("X-Maika-Public-Key", publicKey);
  if (captchaToken) fwdHeaders.set("X-Maika-Captcha-Token", captchaToken);

  let body =
    /** @type {Buffer | undefined} */
    undefined;
  if (method !== "GET" && method !== "HEAD" && event.body) {
    const buf = Buffer.from(
      event.body,
      event.isBase64Encoded ? "base64" : "utf8",
    );
    if (buf.length > 0) body = buf;
  }

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method,
      headers: fwdHeaders,
      body,
      redirect: "manual",
    });
    const outBody = await upstreamRes.text();
    return {
      statusCode: upstreamRes.status || 502,
      headers: responseHeadersFromFetch(upstreamRes, corsAllowOrigin),
      body: outBody,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      statusCode: 502,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": corsAllowOrigin,
      },
      body: `Proxy error: ${msg}`,
    };
  }
};
