/**
 * Cf Pages: beta tester signup proxy (parity with netlify/functions/beta-register.mjs).
 */
import {
  registerBetaUser,
  validateBetaPayload,
} from "../../netlify/functions/_beta_register_upstream.mjs";
import { jsonResponse } from "../_lib/cf_http.js";

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return jsonResponse(env, "CORS_ALLOW_ORIGIN", 204, {});
  }
  if (request.method !== "POST") {
    return jsonResponse(env, "CORS_ALLOW_ORIGIN", 405, {
      ok: false,
      error: "Method not allowed",
    });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse(env, "CORS_ALLOW_ORIGIN", 400, {
      ok: false,
      error: "Invalid JSON",
    });
  }

  const validated = validateBetaPayload(body);
  if (!validated.ok) {
    return jsonResponse(env, "CORS_ALLOW_ORIGIN", 400, {
      ok: false,
      error: validated.error,
    });
  }

  const baseUrl = String(
    env.MAIKA_BACKEND_URL || "https://maika-backend-service.onrender.com",
  ).replace(/\/+$/, "");
  const apiKey = String(env.MAIKA_BACKEND_API_KEY || "").trim();

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

  return jsonResponse(env, "CORS_ALLOW_ORIGIN", result.status, result.body);
}
