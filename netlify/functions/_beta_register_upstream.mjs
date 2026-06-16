/**
 * Shared beta registration upstream call (Netlify function + local dev proxy).
 *
 * Env:
 *   MAIKA_BACKEND_URL     Default https://maika-backend-service.onrender.com
 *   MAIKA_BACKEND_API_KEY X-API-Key for POST /api/v1/beta-testers
 */

export function readEnv(key, fallback = "") {
  const p =
    typeof process !== "undefined" && process.env
      ? process.env[key]
      : undefined;
  if (p != null && String(p).trim() !== "") return String(p).trim();
  return fallback;
}

export function getBackendConfig() {
  return {
    baseUrl: readEnv(
      "MAIKA_BACKEND_URL",
      "https://maika-backend-service.onrender.com",
    ).replace(/\/+$/, ""),
    apiKey: readEnv("MAIKA_BACKEND_API_KEY", ""),
  };
}

export function validateBetaPayload(body) {
  const email = String(body?.email || "").trim().toLowerCase();
  const full_name = String(body?.full_name || body?.name || "").trim();
  const birthdate = String(body?.birthdate || "").trim();
  const country = String(body?.country || "").trim();
  const device_type = String(body?.device_type || "").trim();
  const referral_source = String(body?.referral_source || "").trim();

  const allowedDevices = new Set(["iOS", "Android", "Both"]);

  if (!full_name) {
    return { ok: false, error: "Please enter your full name." };
  }
  if (!email) {
    return { ok: false, error: "Please enter your email address." };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) {
    return { ok: false, error: "Please enter a valid birthdate." };
  }
  const birth = new Date(`${birthdate}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) {
    return { ok: false, error: "Please enter a valid birthdate." };
  }
  if (!country) {
    return { ok: false, error: "Please select your country." };
  }
  if (!allowedDevices.has(device_type)) {
    return { ok: false, error: "Please select your device type." };
  }
  if (!referral_source) {
    return { ok: false, error: "Please tell us how you heard about Maika." };
  }

  return {
    ok: true,
    email,
    full_name,
    birthdate,
    country,
    device_type,
    referral_source,
  };
}

function extractUserFacingMessage(value, depth = 0) {
  if (depth > 4 || value == null) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return extractUserFacingMessage(JSON.parse(trimmed), depth + 1);
      } catch {
        return null;
      }
    }
    return trimmed;
  }

  if (typeof value === "object") {
    for (const key of ["message", "error", "detail"]) {
      const nested = extractUserFacingMessage(value[key], depth + 1);
      if (nested) return nested;
    }
  }

  return null;
}

function upstreamErrorMessage(parsed) {
  return (
    extractUserFacingMessage(parsed) ||
    "Registration failed. Please try again."
  );
}

export { extractUserFacingMessage };

export async function registerBetaUser(payload) {
  const { baseUrl, apiKey, email, full_name, birthdate, country, device_type, referral_source } =
    payload;

  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      body: { ok: false, error: "Beta registration is not configured." },
    };
  }

  const url = `${baseUrl}/api/v1/beta-testers`;
  let upstreamRes;
  try {
    upstreamRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        email,
        full_name,
        birthdate,
        country,
        device_type,
        referral_source,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      body: {
        ok: false,
        error: "Could not reach the registration service. Please try again.",
        detail: String(err?.message || err),
      },
    };
  }

  const text = await upstreamRes.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text };
    }
  }

  if (upstreamRes.ok) {
    return {
      ok: true,
      status: upstreamRes.status,
      body: { ok: true, ...(parsed && typeof parsed === "object" ? parsed : {}) },
    };
  }

  return {
    ok: false,
    status: upstreamRes.status,
    body: { ok: false, error: upstreamErrorMessage(parsed) },
  };
}
