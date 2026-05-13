import { readEnv, jsonResponse } from "../_lib/cf_http.js";

export async function onRequestGet(context) {
  const { env } = context;
  const turnstileSiteKey = readEnv(env, "TURNSTILE_SITE_KEY");

  return jsonResponse(
    env,
    "CORS_ALLOW_ORIGIN",
    200,
    {
      ok: true,
      turnstileSiteKey,
      turnstileEnabled: !!turnstileSiteKey,
    },
    { "Cache-Control": "no-store" },
  );
}
