/**
 * Admin API: create a dynamic demo access code in Redis.
 *
 * Behavior:
 * - Requires POST with x-admin-key (DEMO_CODE_ADMIN_SECRET).
 * - Accepts optional { code, maxUses, ttlSeconds } JSON body.
 * - Creates a code (generated or explicit) with usage + expiry constraints.
 * - Returns the new code and remaining uses on success.
 *
 * Notes:
 * - This endpoint is intended for internal/admin use only.
 * - Uses shared helpers in _dynamic_access_codes.mjs.
 */
import {
  createDynamicAccessCode,
  isDynamicCodeStoreConfigured,
} from "./_dynamic_access_codes.mjs";

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

function httpMethodFromEvent(event) {
  const m =
    event.httpMethod ||
    event.requestContext?.http?.method ||
    event.requestContext?.httpMethod;
  return String(m || "GET").toUpperCase();
}

function jsonResponse(status, body, corsOrigin) {
  const allow = corsOrigin || "*";
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Headers":
        "Content-Type, Accept, Accept-Language, X-Admin-Key",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  const corsAllow = readEnv("CORS_ALLOW_ORIGIN", "*");
  const method = httpMethodFromEvent(event);
  if (method === "OPTIONS") return jsonResponse(204, {}, corsAllow);
  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" }, corsAllow);
  }

  const adminSecret = readEnv("DEMO_CODE_ADMIN_SECRET");
  if (!adminSecret) {
    return jsonResponse(
      503,
      { ok: false, error: "Admin code API is not configured." },
      corsAllow,
    );
  }
  const providedKey = String(getHeader(event.headers, "x-admin-key") || "").trim();
  if (!providedKey || providedKey !== adminSecret) {
    return jsonResponse(403, { ok: false, error: "Forbidden" }, corsAllow);
  }

  if (!isDynamicCodeStoreConfigured()) {
    return jsonResponse(
      503,
      {
        ok: false,
        error:
          "Dynamic code store is not configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).",
      },
      corsAllow,
    );
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON" }, corsAllow);
  }

  const created = await createDynamicAccessCode({
    code: body.code != null ? String(body.code) : "",
    maxUses: body.maxUses,
    ttlSeconds: body.ttlSeconds,
  });

  if (!created.ok) {
    if (created.reason === "already_exists") {
      return jsonResponse(409, { ok: false, error: "Access code already exists." }, corsAllow);
    }
    if (created.reason === "invalid_code_format") {
      return jsonResponse(
        400,
        {
          ok: false,
          error:
            "Invalid code format. Use 4-64 chars: uppercase letters, numbers, hyphen.",
        },
        corsAllow,
      );
    }
    return jsonResponse(
      503,
      { ok: false, error: "Could not create access code right now." },
      corsAllow,
    );
  }

  return jsonResponse(
    200,
    {
      ok: true,
      code: created.code,
      remainingUses: created.remainingUses,
      ttlSeconds: created.ttlSeconds,
      createdAt: created.createdAt,
    },
    corsAllow,
  );
};
