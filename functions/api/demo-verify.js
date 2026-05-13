/**
 * Cf Pages: verifies demo code + Turnstile (parity with netlify/functions/demo-verify.mjs).
 */
import {
  consumeDynamicAccessCode,
  isDynamicCodeStoreConfigured,
} from "../_lib/dynamic_access_codes.js";
import {
  readEnv,
  corsAllow,
  getRequestHeader,
  jsonResponse,
} from "../_lib/cf_http.js";

function parseAccessCodes(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

async function verifyTurnstile(secret, token, remoteip) {
  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token || "");
  if (remoteip) body.set("remoteip", remoteip);

  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  return /** @type {Promise<{success?:boolean}>} */ (res.json());
}

export async function onRequest(context) {
  const { request, env } = context;
  const cors = corsAllow(env);
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    const reqHdr =
      getRequestHeader(
        request,
        "access-control-request-headers",
      ) || "Content-Type, Accept";
    return new Response("", {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": cors,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": reqHdr,
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (method !== "POST") {
    return jsonResponse(env, "CORS_ALLOW_ORIGIN", 405, {
      ok: false,
      error: "Method not allowed",
    });
  }

  const bypass = readEnv(env, "DEMO_BYPASS_VERIFY").toLowerCase() === "true";
  const secret = readEnv(env, "TURNSTILE_SECRET_KEY");
  const codesRaw = readEnv(env, "DEMO_ACCESS_CODES");
  const allowed = parseAccessCodes(codesRaw);
  const dynamicEnabled = isDynamicCodeStoreConfigured(env);

  if (!allowed.length && !dynamicEnabled) {
    return jsonResponse(env, "CORS_ALLOW_ORIGIN", 503, {
      ok: false,
      error:
        "Demo access is not configured (set DEMO_ACCESS_CODES or Redis env for dynamic codes).",
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(env, "CORS_ALLOW_ORIGIN", 400, {
      ok: false,
      error: "Invalid JSON",
    });
  }

  const accessCode =
    body.accessCode != null ? String(body.accessCode).trim() : "";
  const turnstileToken =
    body.turnstileToken != null ? String(body.turnstileToken).trim() : "";

  if (!accessCode) {
    return jsonResponse(env, "CORS_ALLOW_ORIGIN", 400, {
      ok: false,
      error: "Missing access code.",
    });
  }

  const normalized = accessCode.toUpperCase();
  const isStaticCode = allowed.includes(normalized);
  const isDynamicCandidate = !isStaticCode && dynamicEnabled;

  if (!isStaticCode && !isDynamicCandidate) {
    return jsonResponse(env, "CORS_ALLOW_ORIGIN", 403, {
      ok: false,
      error: "Invalid access code.",
    });
  }

  if (bypass) {
    return jsonResponse(env, "CORS_ALLOW_ORIGIN", 200, { ok: true });
  }

  if (!secret) {
    return jsonResponse(env, "CORS_ALLOW_ORIGIN", 503, {
      ok: false,
      error: "Turnstile is not configured (TURNSTILE_SECRET_KEY).",
    });
  }

  if (!turnstileToken) {
    return jsonResponse(env, "CORS_ALLOW_ORIGIN", 403, {
      ok: false,
      error: "Complete the security check and try again.",
    });
  }

  const ip =
    getRequestHeader(request, "x-forwarded-for")?.split(",")[0]?.trim() || "";
  const outcome = await verifyTurnstile(secret, turnstileToken, ip);

  if (!outcome.success) {
    return jsonResponse(env, "CORS_ALLOW_ORIGIN", 403, {
      ok: false,
      error: "Security verification failed. Refresh and try again.",
    });
  }

  if (isDynamicCandidate) {
    const consumed = await consumeDynamicAccessCode(env, normalized);
    if (!consumed.ok) {
      if (consumed.reason === "store_error") {
        return jsonResponse(env, "CORS_ALLOW_ORIGIN", 503, {
          ok: false,
          error: "Access code service unavailable. Please try again.",
        });
      }
      const message =
        consumed.reason === "exhausted"
          ? "This access code has reached its usage limit."
          : "Invalid or expired access code.";
      return jsonResponse(env, "CORS_ALLOW_ORIGIN", 403, {
        ok: false,
        error: message,
      });
    }
    return jsonResponse(env, "CORS_ALLOW_ORIGIN", 200, {
      ok: true,
      codeType: "dynamic",
      usesRemaining: consumed.remainingUses,
    });
  }

  return jsonResponse(env, "CORS_ALLOW_ORIGIN", 200, {
    ok: true,
    codeType: "static",
  });
}
