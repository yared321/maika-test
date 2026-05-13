import {
  revokeDynamicAccessCode,
  isDynamicCodeStoreConfigured,
} from "../_lib/dynamic_access_codes.js";
import {
  readEnv,
  corsAllow,
  getRequestHeader,
  jsonResponse,
} from "../_lib/cf_http.js";

const ADMIN_CORS = {
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Accept-Language, X-Admin-Key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();
  const allow = corsAllow(env);

  if (method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allow,
        ...ADMIN_CORS,
      },
    });
  }

  if (method !== "POST") {
    return jsonResponse(
      env,
      "CORS_ALLOW_ORIGIN",
      405,
      { ok: false, error: "Method not allowed" },
      ADMIN_CORS,
    );
  }

  const adminSecret = readEnv(env, "DEMO_CODE_ADMIN_SECRET");
  if (!adminSecret) {
    return jsonResponse(
      env,
      "CORS_ALLOW_ORIGIN",
      503,
      { ok: false, error: "Admin code API is not configured." },
      ADMIN_CORS,
    );
  }
  const providedKey = String(getRequestHeader(request, "x-admin-key") || "").trim();
  if (!providedKey || providedKey !== adminSecret) {
    return jsonResponse(
      env,
      "CORS_ALLOW_ORIGIN",
      403,
      { ok: false, error: "Forbidden" },
      ADMIN_CORS,
    );
  }

  if (!isDynamicCodeStoreConfigured(env)) {
    return jsonResponse(
      env,
      "CORS_ALLOW_ORIGIN",
      503,
      {
        ok: false,
        error:
          "Dynamic code store is not configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).",
      },
      ADMIN_CORS,
    );
  }

  /** @type {Record<string, unknown>} */
  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      env,
      "CORS_ALLOW_ORIGIN",
      400,
      { ok: false, error: "Invalid JSON" },
      ADMIN_CORS,
    );
  }

  const code = body.code != null ? String(body.code) : "";
  const revoked = await revokeDynamicAccessCode(env, code);

  if (!revoked.ok) {
    if (revoked.reason === "invalid_code_format") {
      return jsonResponse(
        env,
        "CORS_ALLOW_ORIGIN",
        400,
        { ok: false, error: "Invalid access code format." },
        ADMIN_CORS,
      );
    }
    return jsonResponse(
      env,
      "CORS_ALLOW_ORIGIN",
      503,
      { ok: false, error: "Could not revoke code." },
      ADMIN_CORS,
    );
  }

  return jsonResponse(
    env,
    "CORS_ALLOW_ORIGIN",
    200,
    {
      ok: true,
      code: revoked.code,
      removed: revoked.removed,
    },
    ADMIN_CORS,
  );
}
