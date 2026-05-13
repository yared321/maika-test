/**
 * Small helpers for Pages Functions: read `env`, CORS allow-origin, headers,
 * and JSON responses. Used by `functions/api/*`; no route logic here.
 */

/** @typedef {Record<string, string | undefined>} CfEnv */

/**
 * Read string env bindings (Pages dashboard + wrangler [.dev.vars]).
 * @param {CfEnv} env
 * @param {string} key
 * @param {string} [fallback]
 */
export function readEnv(env, key, fallback = "") {
  const p = env[key];
  if (p != null && String(p).trim() !== "") return String(p).trim();
  return fallback;
}

/**
 * @param {CfEnv} env
 * @param {string} corsKey
 */
export function corsAllow(env, corsKey = "CORS_ALLOW_ORIGIN") {
  const v = readEnv(env, corsKey, "");
  return v || "*";
}

/** @param {Request} request */
export function getRequestHeader(request, name) {
  return request.headers.get(name) || "";
}

/** @param {CfEnv} env */
export function jsonResponse(env, corsKey, status, body, extraHeaders = {}) {
  const allow = corsAllow(env, corsKey);
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": allow,
      ...extraHeaders,
    },
  });
}
