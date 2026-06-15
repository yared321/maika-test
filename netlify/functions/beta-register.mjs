/**
 * Proxies beta tester signup to Maika backend (keeps API key server-side).
 *
 * POST /api/beta-register  { full_name, email, birthdate, country, device_type, referral_source }
 */
import {
  getBackendConfig,
  registerBetaUser,
  validateBetaPayload,
} from "./_beta_register_upstream.mjs";

function readCors() {
  const v =
    typeof process !== "undefined" && process.env
      ? process.env.CORS_ALLOW_ORIGIN
      : "";
  return v && String(v).trim() ? String(v).trim() : "*";
}

function jsonResponse(status, body, corsOrigin) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": corsOrigin || "*",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Accept-Language",
    },
    body: JSON.stringify(body),
  };
}

function httpMethodFromEvent(event) {
  const m =
    event.httpMethod ||
    event.requestContext?.http?.method ||
    event.requestContext?.httpMethod;
  return String(m || "GET").toUpperCase();
}

export const handler = async (event) => {
  const corsAllow = readCors();
  const method = httpMethodFromEvent(event);

  if (method === "OPTIONS") {
    return jsonResponse(204, {}, corsAllow);
  }
  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" }, corsAllow);
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON" }, corsAllow);
  }

  const validated = validateBetaPayload(body);
  if (!validated.ok) {
    return jsonResponse(400, { ok: false, error: validated.error }, corsAllow);
  }

  const { baseUrl, apiKey } = getBackendConfig();
  const result = await registerBetaUser({
    baseUrl,
    apiKey,
    email: validated.email,
    full_name: validated.full_name,
    birthdate: validated.birthdate,
    country: validated.country,
    device_type: validated.device_type,
    referral_source: validated.referral_source,
  });

  return jsonResponse(result.status, result.body, corsAllow);
};
