/**
 * Shared dynamic demo access-code store logic for Netlify Functions.
 *
 * Responsibilities:
 * - Normalize and validate code format.
 * - Read Redis/env configuration for dynamic invite codes.
 * - Create codes with max-uses + TTL defaults.
 * - Consume codes atomically (Lua) to prevent race-condition overuse.
 * - Revoke codes by deleting their Redis keys.
 *
 * Used by:
 * - demo-verify.mjs (validate + consume)
 * - demo-code-create.mjs (admin create)
 * - demo-code-revoke.mjs (admin revoke)
 */
import crypto from "node:crypto";
import { Redis } from "@upstash/redis";

function readEnv(key, fallback = "") {
  const p =
    typeof process !== "undefined" && process.env
      ? process.env[key]
      : undefined;
  if (p != null && String(p).trim() !== "") return String(p).trim();
  return fallback;
}

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function normalizeAccessCode(raw) {
  const code = String(raw || "").trim().toUpperCase();
  if (!code) return "";
  if (!/^[A-Z0-9-]{4,64}$/.test(code)) return "";
  return code;
}

export function isDynamicCodeStoreConfigured() {
  return !!(
    readEnv("UPSTASH_REDIS_REST_URL") && readEnv("UPSTASH_REDIS_REST_TOKEN")
  );
}

export function getDynamicCodeDefaults() {
  return {
    maxUses: parsePositiveInt(readEnv("DYNAMIC_ACCESS_CODE_MAX_USES", "3"), 3),
    ttlSeconds: parsePositiveInt(
      readEnv("DYNAMIC_ACCESS_CODE_TTL_SECONDS", "2592000"),
      2592000,
    ),
    prefix: readEnv("DYNAMIC_ACCESS_CODE_PREFIX", "demo:access:"),
  };
}

let _redis = null;
function redis() {
  if (_redis) return _redis;
  const url = readEnv("UPSTASH_REDIS_REST_URL");
  const token = readEnv("UPSTASH_REDIS_REST_TOKEN");
  if (!url || !token) throw new Error("Redis env is not configured");
  _redis = new Redis({ url, token });
  return _redis;
}

function remainingKey(code) {
  return getDynamicCodeDefaults().prefix + code + ":remaining";
}
function metaKey(code) {
  return getDynamicCodeDefaults().prefix + code + ":meta";
}

function generateCode(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

const CONSUME_CODE_LUA = `
local rem = KEYS[1]
local meta = KEYS[2]

if redis.call("EXISTS", rem) == 0 then
  return {-2, -1}
end

local current = tonumber(redis.call("GET", rem))
if (not current) then
  redis.call("DEL", rem)
  redis.call("DEL", meta)
  return {-2, -1}
end

if current <= 0 then
  redis.call("DEL", rem)
  redis.call("DEL", meta)
  return {-1, 0}
end

local next = redis.call("DECR", rem)
if next <= 0 then
  redis.call("DEL", rem)
  redis.call("DEL", meta)
  return {1, 0}
end

return {1, next}
`;

export async function consumeDynamicAccessCode(rawCode) {
  const code = normalizeAccessCode(rawCode);
  if (!code) return { ok: false, reason: "invalid" };
  if (!isDynamicCodeStoreConfigured()) return { ok: false, reason: "not_configured" };
  try {
    const result = await redis().eval(CONSUME_CODE_LUA, [
      remainingKey(code),
      metaKey(code),
    ]);
    const status = Number(Array.isArray(result) ? result[0] : result);
    const remaining = Number(Array.isArray(result) ? result[1] : -1);
    if (status === 1) return { ok: true, code, remainingUses: Math.max(0, remaining) };
    if (status === -1) return { ok: false, reason: "exhausted" };
    return { ok: false, reason: "invalid" };
  } catch (error) {
    return { ok: false, reason: "store_error", error };
  }
}

export async function createDynamicAccessCode(options = {}) {
  if (!isDynamicCodeStoreConfigured()) {
    return { ok: false, reason: "not_configured" };
  }

  const defaults = getDynamicCodeDefaults();
  const requested = options.code ? normalizeAccessCode(options.code) : "";
  if (options.code && !requested) {
    return { ok: false, reason: "invalid_code_format" };
  }

  const uses = parsePositiveInt(options.maxUses, defaults.maxUses);
  const ttlSeconds = parsePositiveInt(options.ttlSeconds, defaults.ttlSeconds);
  const createdAt = Date.now();

  const attempts = requested ? 1 : 8;
  for (let i = 0; i < attempts; i += 1) {
    const code = requested || generateCode(10);
    const remKey = remainingKey(code);
    const mKey = metaKey(code);
    const exists = Number(await redis().exists(remKey));
    if (exists) {
      if (requested) return { ok: false, reason: "already_exists" };
      continue;
    }

    const metadata = {
      createdAt,
      maxUses: uses,
      source: "netlify-function",
    };

    const p = redis().pipeline();
    p.set(remKey, String(uses));
    p.set(mKey, JSON.stringify(metadata));
    if (ttlSeconds > 0) {
      p.expire(remKey, ttlSeconds);
      p.expire(mKey, ttlSeconds);
    }
    await p.exec();
    return {
      ok: true,
      code,
      remainingUses: uses,
      ttlSeconds,
      createdAt,
    };
  }

  return { ok: false, reason: "create_failed" };
}

export async function revokeDynamicAccessCode(rawCode) {
  const code = normalizeAccessCode(rawCode);
  if (!code) return { ok: false, reason: "invalid_code_format" };
  if (!isDynamicCodeStoreConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    const res = await redis().del(remainingKey(code), metaKey(code));
    return { ok: true, code, removed: Number(res) > 0 };
  } catch (error) {
    return { ok: false, reason: "store_error", error };
  }
}
