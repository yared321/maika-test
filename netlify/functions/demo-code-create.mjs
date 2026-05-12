/**
 * Admin API: create a dynamic demo access code in Redis.
 *
 * Behavior:
 * - Requires POST with x-admin-key (DEMO_CODE_ADMIN_SECRET).
 * - Accepts optional { code, maxUses, ttlSeconds, number } JSON body.
 * - `number` (default 1, max 100): how many random codes to create with the same
 *   maxUses, ttlSeconds, and createdAt timestamp (batch). `code` is not allowed when number > 1.
 * - Creates code(s) with usage + expiry constraints.
 * - On success always returns `codes`: a list of { code, remainingUses } for every
 *   created code (length 1 when number is omitted or 1).
 *
 * Notes:
 * - This endpoint is intended for internal/admin use only.
 * - Uses shared helpers in _dynamic_access_codes.mjs.
 */
import {
  createDynamicAccessCode,
  createDynamicAccessCodesBatch,
  isDynamicCodeStoreConfigured,
} from "./_dynamic_access_codes.mjs";

const MAX_CODES_PER_REQUEST = 100;

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

  const rawNumber = body.number;
  let batchCount = 1;
  if (rawNumber != null && rawNumber !== "") {
    const n = Number(rawNumber);
    if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
      return jsonResponse(
        400,
        { ok: false, error: "number must be a positive integer." },
        corsAllow,
      );
    }
    batchCount = Math.min(n, MAX_CODES_PER_REQUEST);
    if (n > MAX_CODES_PER_REQUEST) {
      return jsonResponse(
        400,
        {
          ok: false,
          error: `number must be at most ${MAX_CODES_PER_REQUEST}.`,
        },
        corsAllow,
      );
    }
  }

  const explicitCode = body.code != null ? String(body.code) : "";
  if (batchCount > 1 && explicitCode.trim() !== "") {
    return jsonResponse(
      400,
      {
        ok: false,
        error: "Cannot set code when creating multiple (number > 1); omit code for batch.",
      },
      corsAllow,
    );
  }

  if (batchCount > 1) {
    const batch = await createDynamicAccessCodesBatch({
      count: batchCount,
      maxUses: body.maxUses,
      ttlSeconds: body.ttlSeconds,
    });

    if (!batch.ok) {
      if (batch.reason === "invalid_code_format") {
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
        {
          ok: false,
          error: "Could not create access codes right now.",
          reason: batch.reason,
          atIndex: batch.atIndex,
        },
        corsAllow,
      );
    }

    const first = batch.codes[0];
    return jsonResponse(
      200,
      {
        ok: true,
        maxUses: first?.remainingUses,
        ttlSeconds: first?.ttlSeconds,
        createdAt: batch.createdAt,
        codes: batch.codes.map((row) => ({
          code: row.code,
          remainingUses: row.remainingUses,
        })),
      },
      corsAllow,
    );
  }

  const created = await createDynamicAccessCode({
    code: explicitCode,
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
      maxUses: created.remainingUses,
      ttlSeconds: created.ttlSeconds,
      createdAt: created.createdAt,
      codes: [{ code: created.code, remainingUses: created.remainingUses }],
    },
    corsAllow,
  );
};
