/**
 * Cf Pages parity with netlify/functions/diag-maika-env.mjs (env presence hints).
 */
import { readEnv } from "../_lib/cf_http.js";

export async function onRequestGet(context) {
  const { env } = context;
  const upstream = readEnv(env, "MAIKA_RPPG_UPSTREAM");
  const set = !!(upstream && String(upstream).trim());
  /** @type {string[]} */
  const maikaKeys = [];
  for (const k of Object.keys(env)) {
    if (k.startsWith("MAIKA_")) maikaKeys.push(k);
  }
  const body = {
    maikaUpstreamConfigured: set,
    maikaEnvKeyNames: maikaKeys,
    hint: set
      ? "Env is present on Pages. If uploads still fail, check path and upstream."
      : "Set MAIKA_RPPG_UPSTREAM in Pages project env and redeploy.",
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
