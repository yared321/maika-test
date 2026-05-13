import {
  createDynamicAccessCode,
  createDynamicAccessCodesBatch,
  isDynamicCodeStoreConfigured,
} from "../_lib/dynamic_access_codes.js";
import {
  readEnv,
  corsAllow,
  getRequestHeader,
  jsonResponse,
} from "../_lib/cf_http.js";

const MAX_CODES_PER_REQUEST = 100;

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

  const rawNumber = body.number;
  let batchCount = 1;
  if (rawNumber != null && rawNumber !== "") {
    const n = Number(rawNumber);
    if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
      return jsonResponse(
        env,
        "CORS_ALLOW_ORIGIN",
        400,
        { ok: false, error: "number must be a positive integer." },
        ADMIN_CORS,
      );
    }
    batchCount = Math.min(n, MAX_CODES_PER_REQUEST);
    if (n > MAX_CODES_PER_REQUEST) {
      return jsonResponse(
        env,
        "CORS_ALLOW_ORIGIN",
        400,
        {
          ok: false,
          error: `number must be at most ${MAX_CODES_PER_REQUEST}.`,
        },
        ADMIN_CORS,
      );
    }
  }

  const explicitCode = body.code != null ? String(body.code) : "";
  if (batchCount > 1 && explicitCode.trim() !== "") {
    return jsonResponse(
      env,
      "CORS_ALLOW_ORIGIN",
      400,
      {
        ok: false,
        error:
          "Cannot set code when creating multiple (number > 1); omit code for batch.",
      },
      ADMIN_CORS,
    );
  }

  if (batchCount > 1) {
    const batch = await createDynamicAccessCodesBatch(env, {
      count: batchCount,
      maxUses: body.maxUses,
      ttlSeconds: body.ttlSeconds,
    });

    if (!batch.ok) {
      if (batch.reason === "invalid_code_format") {
        return jsonResponse(
          env,
          "CORS_ALLOW_ORIGIN",
          400,
          {
            ok: false,
            error:
              "Invalid code format. Use 4-64 chars: uppercase letters, numbers, hyphen.",
          },
          ADMIN_CORS,
        );
      }
      return jsonResponse(
        env,
        "CORS_ALLOW_ORIGIN",
        503,
        {
          ok: false,
          error: "Could not create access codes right now.",
          reason: batch.reason,
          atIndex: batch.atIndex,
        },
        ADMIN_CORS,
      );
    }

    const first = batch.codes[0];
    return jsonResponse(
      env,
      "CORS_ALLOW_ORIGIN",
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
      ADMIN_CORS,
    );
  }

  const created = await createDynamicAccessCode(env, {
    code: explicitCode,
    maxUses: body.maxUses,
    ttlSeconds: body.ttlSeconds,
  });

  if (!created.ok) {
    if (created.reason === "already_exists") {
      return jsonResponse(
        env,
        "CORS_ALLOW_ORIGIN",
        409,
        { ok: false, error: "Access code already exists." },
        ADMIN_CORS,
      );
    }
    if (created.reason === "invalid_code_format") {
      return jsonResponse(
        env,
        "CORS_ALLOW_ORIGIN",
        400,
        {
          ok: false,
          error:
            "Invalid code format. Use 4-64 chars: uppercase letters, numbers, hyphen.",
        },
        ADMIN_CORS,
      );
    }
    return jsonResponse(
      env,
      "CORS_ALLOW_ORIGIN",
      503,
      { ok: false, error: "Could not create access code right now." },
      ADMIN_CORS,
    );
  }

  return jsonResponse(
    env,
    "CORS_ALLOW_ORIGIN",
    200,
    {
      ok: true,
      maxUses: created.remainingUses,
      ttlSeconds: created.ttlSeconds,
      createdAt: created.createdAt,
      codes: [{ code: created.code, remainingUses: created.remainingUses }],
    },
    ADMIN_CORS,
  );
}
