/**
 * Worker/Pages-compatible dynamic demo codes (Upstash Redis).
 * Mirrors netlify/functions/_dynamic_access_codes.mjs behavior; APIs take `env` from Pages context.
 */
import { Redis } from "@upstash/redis/cloudflare";

/** @typedef {Record<string, string | undefined>} CfEnv */

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function readBinding(env, key, fallback = "") {
  const p = env[key];
  if (p != null && String(p).trim() !== "") return String(p).trim();
  return fallback;
}

/** @param {CfEnv} env */
export function normalizeAccessCode(raw) {
  const code = String(raw || "").trim().toUpperCase();
  if (!code) return "";
  if (!/^[A-Z0-9-]{4,64}$/.test(code)) return "";
  return code;
}

/** @param {CfEnv} env */
export function isDynamicCodeStoreConfigured(env) {
  return !!(
    readBinding(env, "UPSTASH_REDIS_REST_URL") &&
    readBinding(env, "UPSTASH_REDIS_REST_TOKEN")
  );
}

/** @param {CfEnv} env */
export function getDynamicCodeDefaults(env) {
  return {
    maxUses: parsePositiveInt(
      readBinding(env, "DYNAMIC_ACCESS_CODE_MAX_USES", "3"),
      3,
    ),
    ttlSeconds: parsePositiveInt(
      readBinding(env, "DYNAMIC_ACCESS_CODE_TTL_SECONDS", "2592000"),
      2592000,
    ),
    prefix: readBinding(env, "DYNAMIC_ACCESS_CODE_PREFIX", "demo:access:"),
  };
}

/** @param {CfEnv} env */
function redisClient(env) {
  return Redis.fromEnv(env);
}

/** @param {CfEnv} env */
function remainingKey(env, code) {
  return getDynamicCodeDefaults(env).prefix + code + ":remaining";
}

/** @param {CfEnv} env */
function metaKey(env, code) {
  return getDynamicCodeDefaults(env).prefix + code + ":meta";
}

function generateCode(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
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

/** @param {CfEnv} env */
export async function consumeDynamicAccessCode(env, rawCode) {
  const code = normalizeAccessCode(rawCode);
  if (!code) return { ok: false, reason: "invalid" };
  if (!isDynamicCodeStoreConfigured(env)) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    const r = redisClient(env);
    const result = await r.eval(CONSUME_CODE_LUA, [
      remainingKey(env, code),
      metaKey(env, code),
    ]);
    const status = Number(Array.isArray(result) ? result[0] : result);
    const remaining = Number(Array.isArray(result) ? result[1] : -1);
    if (status === 1) {
      return { ok: true, code, remainingUses: Math.max(0, remaining) };
    }
    if (status === -1) return { ok: false, reason: "exhausted" };
    return { ok: false, reason: "invalid" };
  } catch (error) {
    return { ok: false, reason: "store_error", error };
  }
}

/**
 * @param {CfEnv} env
 * @param {{ code?: string, maxUses?: unknown, ttlSeconds?: unknown, createdAt?: number }} options
 */
export async function createDynamicAccessCode(env, options = {}) {
  if (!isDynamicCodeStoreConfigured(env)) {
    return { ok: false, reason: "not_configured" };
  }

  const defaults = getDynamicCodeDefaults(env);
  const requested = options.code ? normalizeAccessCode(options.code) : "";
  if (options.code && !requested) {
    return { ok: false, reason: "invalid_code_format" };
  }

  const uses = parsePositiveInt(options.maxUses, defaults.maxUses);
  const ttlSeconds = parsePositiveInt(options.ttlSeconds, defaults.ttlSeconds);
  const createdAt =
    typeof options.createdAt === "number" && Number.isFinite(options.createdAt)
      ? options.createdAt
      : Date.now();

  const attempts = requested ? 1 : 8;
  const r = redisClient(env);

  for (let i = 0; i < attempts; i += 1) {
    const code = requested || generateCode(10);
    const remKey = remainingKey(env, code);
    const mKey = metaKey(env, code);
    const exists = Number(await r.exists(remKey));
    if (exists) {
      if (requested) return { ok: false, reason: "already_exists" };
      continue;
    }

    const metadata = {
      createdAt,
      maxUses: uses,
      source: "cloudflare-pages",
    };

    const p = r.pipeline();
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

/**
 * @param {CfEnv} env
 * @param {{ count?: unknown, maxUses?: unknown, ttlSeconds?: unknown }} options
 */
export async function createDynamicAccessCodesBatch(env, options = {}) {
  if (!isDynamicCodeStoreConfigured(env)) {
    return { ok: false, reason: "not_configured" };
  }
  const count = parsePositiveInt(options.count, 1);
  if (count < 1) return { ok: false, reason: "invalid_count" };

  const sharedCreatedAt = Date.now();
  /** @type {{ code: string; remainingUses: number; ttlSeconds: number; createdAt: number }[]} */
  const codes = [];

  for (let i = 0; i < count; i += 1) {
    const created = await createDynamicAccessCode(env, {
      maxUses: options.maxUses,
      ttlSeconds: options.ttlSeconds,
      createdAt: sharedCreatedAt,
    });
    if (!created.ok) {
      for (const row of codes) {
        await revokeDynamicAccessCode(env, row.code);
      }
      return { ok: false, reason: created.reason, atIndex: i };
    }
    codes.push({
      code: created.code,
      remainingUses: created.remainingUses,
      ttlSeconds: created.ttlSeconds,
      createdAt: created.createdAt,
    });
  }

  return { ok: true, codes, createdAt: sharedCreatedAt };
}

/** @param {CfEnv} env */
export async function revokeDynamicAccessCode(env, rawCode) {
  const code = normalizeAccessCode(rawCode);
  if (!code) return { ok: false, reason: "invalid_code_format" };
  if (!isDynamicCodeStoreConfigured(env)) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    const r = redisClient(env);
    const res = await r.del(remainingKey(env, code), metaKey(env, code));
    return { ok: true, code, removed: Number(res) > 0 };
  } catch (error) {
    return { ok: false, reason: "store_error", error };
  }
}
