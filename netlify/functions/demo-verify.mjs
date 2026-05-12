/**
 * Verifies demo access code + Cloudflare Turnstile token.
 *
 * Env (Netlify UI):
 *   - DEMO_ACCESS_CODES     Comma-separated allowlist (e.g. HELSANA,MAIKA26)
 *   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  Optional dynamic code store.
 *   - DYNAMIC_ACCESS_CODE_MAX_USES / DYNAMIC_ACCESS_CODE_TTL_SECONDS Optional defaults.
 *   - TURNSTILE_SECRET_KEY Secret from Cloudflare Turnstile
 *   - DEMO_BYPASS_VERIFY    Set to "true" only for local/dev; skips Turnstile check.
 *   - CORS_ALLOW_ORIGIN     Optional; default "*"
 */
import {
  consumeDynamicAccessCode,
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

function parseAccessCodes(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
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
        "Content-Type, Accept, Accept-Language",
    },
    body: JSON.stringify(body),
  };
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
  return res.json();
}

export const handler = async (event) => {
  const corsAllow = readEnv("CORS_ALLOW_ORIGIN", "*");
  const method = httpMethodFromEvent(event);

  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": corsAllow,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          getHeader(event.headers, "access-control-request-headers") ||
          "Content-Type, Accept",
        "Access-Control-Max-Age": "86400",
      },
      body: "",
    };
  }

  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" }, corsAllow);
  }

  const bypass = readEnv("DEMO_BYPASS_VERIFY").toLowerCase() === "true";
  const secret = readEnv("TURNSTILE_SECRET_KEY");
  const codesRaw = readEnv("DEMO_ACCESS_CODES");
  const allowed = parseAccessCodes(codesRaw);

  const dynamicEnabled = isDynamicCodeStoreConfigured();
  if (!allowed.length && !dynamicEnabled) {
    return jsonResponse(
      503,
      {
        ok: false,
        error:
          "Demo access is not configured (set DEMO_ACCESS_CODES or Redis env for dynamic codes).",
      },
      corsAllow,
    );
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON" }, corsAllow);
  }

  const accessCode =
    body.accessCode != null ? String(body.accessCode).trim() : "";
  const turnstileToken =
    body.turnstileToken != null ? String(body.turnstileToken).trim() : "";

  if (!accessCode) {
    return jsonResponse(400, { ok: false, error: "Missing access code." }, corsAllow);
  }

  const normalized = accessCode.toUpperCase();
  const isStaticCode = allowed.includes(normalized);
  const isDynamicCandidate = !isStaticCode && dynamicEnabled;

  if (!isStaticCode && !isDynamicCandidate) {
    return jsonResponse(403, { ok: false, error: "Invalid access code." }, corsAllow);
  }

  if (bypass) {
    return jsonResponse(200, { ok: true }, corsAllow);
  }

  if (!secret) {
    return jsonResponse(
      503,
      { ok: false, error: "Turnstile is not configured (TURNSTILE_SECRET_KEY)." },
      corsAllow,
    );
  }

  if (!turnstileToken) {
    return jsonResponse(
      403,
      { ok: false, error: "Complete the security check and try again." },
      corsAllow,
    );
  }

  const ip =
    getHeader(event.headers, "x-forwarded-for")?.split(",")[0]?.trim() || "";
  const outcome = await verifyTurnstile(secret, turnstileToken, ip);

  if (!outcome.success) {
    return jsonResponse(
      403,
      {
        ok: false,
        error: "Security verification failed. Refresh and try again.",
      },
      corsAllow,
    );
  }

  if (isDynamicCandidate) {
    const consumed = await consumeDynamicAccessCode(normalized);
    if (!consumed.ok) {
      if (consumed.reason === "store_error") {
        return jsonResponse(
          503,
          { ok: false, error: "Access code service unavailable. Please try again." },
          corsAllow,
        );
      }
      const message =
        consumed.reason === "exhausted"
          ? "This access code has reached its usage limit."
          : "Invalid or expired access code.";
      return jsonResponse(403, { ok: false, error: message }, corsAllow);
    }
    return jsonResponse(
      200,
      {
        ok: true,
        codeType: "dynamic",
        usesRemaining: consumed.remainingUses,
      },
      corsAllow,
    );
  }

  return jsonResponse(200, { ok: true, codeType: "static" }, corsAllow);
};
