#!/usr/bin/env node
/**
 * Local static server + reverse proxy so the demo can call the assess API without browser CORS.
 *
 *   node scripts/maika-dev-proxy.mjs
 *   open http://localhost:3000/demo/
 *
 * Proxies: /api/face-assess/*  →  MAIKA_RPPG_UPSTREAM (default: staging Cloud Run origin, path preserved after prefix).
 * Serves:  ./site  (override with SITE_ROOT).
 *
 * Env: PORT (default 3000), SITE_ROOT, MAIKA_RPPG_UPSTREAM (e.g. https://xxx.run.app, no trailing slash).
 * Demo verify env:
 *   DEMO_ACCESS_CODES, TURNSTILE_SECRET_KEY, DEMO_BYPASS_VERIFY (optional local bypass)
 *   + optional dynamic codes: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   (+ optional defaults DYNAMIC_ACCESS_CODE_MAX_USES, DYNAMIC_ACCESS_CODE_TTL_SECONDS)
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDynamicAccessCode,
  createDynamicAccessCodesBatch,
  consumeDynamicAccessCode,
  isDynamicCodeStoreConfigured,
  revokeDynamicAccessCode,
} from '../netlify/functions/_dynamic_access_codes.mjs';

const MAX_CODES_PER_REQUEST = 100;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const SITE_ROOT = process.env.SITE_ROOT
  ? path.resolve(process.env.SITE_ROOT)
  : path.join(REPO_ROOT, 'site');
const PORT = Number(process.env.PORT, 10) || 3040;
const UPSTREAM = (process.env.MAIKA_RPPG_UPSTREAM || 'https://maika-rppg-web-staging-x4o27bgmjq-oa.a.run.app').replace(
  /\/+$/,
  '',
);
const PUBLIC_KEY = String(process.env.MAIKA_PUBLIC_KEY || '').trim();
const CAPTCHA_TOKEN = String(process.env.MAIKA_CAPTCHA_TOKEN || '').trim();
const TURNSTILE_SITE_KEY = String(process.env.TURNSTILE_SITE_KEY || '').trim();
const PROXY_PREFIX = '/api/face-assess';
const DEMO_VERIFY_PATH = '/api/demo-verify';
const DEMO_CODE_CREATE_PATH = '/api/demo-code-create';
const DEMO_CODE_REVOKE_PATH = '/api/demo-code-revoke';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function corsHeaders(req) {
  const reqHdr = req.headers['access-control-request-headers'];
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      reqHdr ||
      'Content-Type, X-Maika-Public-Key, X-Maika-Captcha-Token, Accept, Accept-Language',
    'Access-Control-Max-Age': '86400',
  };
}

function stripHopByHop(headers) {
  const out = { ...headers };
  const drop = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade',
  ]);
  for (const k of Object.keys(out)) {
    if (drop.has(k.toLowerCase())) delete out[k];
  }
  delete out['access-control-allow-origin'];
  delete out['access-control-allow-headers'];
  delete out['access-control-allow-methods'];
  delete out['access-control-expose-headers'];
  return out;
}

function proxyAssess(req, res) {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const upstreamPath = u.pathname.slice(PROXY_PREFIX.length) || '/';
  const upstreamUrl = new URL(upstreamPath + u.search, UPSTREAM + '/');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  const isHttps = upstreamUrl.protocol === 'https:';
  const lib = isHttps ? https : http;

  const headers = stripHopByHop(req.headers);
  headers.host = upstreamUrl.host;
  // Dev-only cookies (e.g. Next.js __next_hmr_refresh_hash__) must not be forwarded to Cloud Run.
  delete headers.cookie;
  delete headers.Cookie;
  delete headers['x-maika-public-key'];
  delete headers['X-Maika-Public-Key'];
  delete headers['x-maika-captcha-token'];
  delete headers['X-Maika-Captcha-Token'];
  if (PUBLIC_KEY) headers['X-Maika-Public-Key'] = PUBLIC_KEY;
  if (CAPTCHA_TOKEN) headers['X-Maika-Captcha-Token'] = CAPTCHA_TOKEN;

  const preq = lib.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (isHttps ? 443 : 80),
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: req.method,
      headers,
    },
    (pres) => {
      const out = stripHopByHop(pres.headers);
      out['access-control-allow-origin'] = '*';
      res.writeHead(pres.statusCode || 502, out);
      pres.pipe(res);
    },
  );

  preq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end(`Proxy error: ${err && err.message ? err.message : err}`);
  });

  req.pipe(preq);
}

function parseAccessCodes(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

async function verifyTurnstile(secret, token, remoteip) {
  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token || '');
  if (remoteip) body.set('remoteip', remoteip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return res.json();
}

function writeJson(res, req, status, payload) {
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

async function handleDemoVerify(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    writeJson(res, req, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = {};
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    writeJson(res, req, 400, { ok: false, error: 'Invalid JSON' });
    return;
  }

  const accessCode = String(body.accessCode || '').trim();
  const token = String(body.turnstileToken || '').trim();
  const bypass = String(process.env.DEMO_BYPASS_VERIFY || '').toLowerCase() === 'true';
  const secret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
  const allowed = parseAccessCodes(process.env.DEMO_ACCESS_CODES || '');
  const dynamicEnabled = isDynamicCodeStoreConfigured();

  if (!allowed.length && !dynamicEnabled) {
    writeJson(res, req, 503, {
      ok: false,
      error: 'Demo access is not configured (set DEMO_ACCESS_CODES or Redis env for dynamic codes).',
    });
    return;
  }
  if (!accessCode) {
    writeJson(res, req, 400, { ok: false, error: 'Missing access code.' });
    return;
  }
  const normalized = accessCode.toUpperCase();
  const isStaticCode = allowed.includes(normalized);
  const isDynamicCandidate = !isStaticCode && dynamicEnabled;
  if (!isStaticCode && !isDynamicCandidate) {
    writeJson(res, req, 403, { ok: false, error: 'Invalid access code.' });
    return;
  }

  if (!bypass) {
    if (!secret) {
      writeJson(res, req, 503, { ok: false, error: 'Turnstile is not configured (TURNSTILE_SECRET_KEY).' });
      return;
    }
    if (!token) {
      writeJson(res, req, 403, { ok: false, error: 'Complete the security check and try again.' });
      return;
    }
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0]?.trim();
    const outcome = await verifyTurnstile(secret, token, ip);
    if (!outcome.success) {
      writeJson(res, req, 403, { ok: false, error: 'Security verification failed. Refresh and try again.' });
      return;
    }
  }

  if (isDynamicCandidate) {
    const consumed = await consumeDynamicAccessCode(normalized);
    if (!consumed.ok) {
      if (consumed.reason === 'store_error') {
        writeJson(res, req, 503, { ok: false, error: 'Access code service unavailable. Please try again.' });
        return;
      }
      const message =
        consumed.reason === 'exhausted'
          ? 'This access code has reached its usage limit.'
          : 'Invalid or expired access code.';
      writeJson(res, req, 403, { ok: false, error: message });
      return;
    }
    writeJson(res, req, 200, { ok: true, codeType: 'dynamic', usesRemaining: consumed.remainingUses });
    return;
  }

  writeJson(res, req, 200, { ok: true, codeType: 'static' });
}

function getHeader(headers, name) {
  const want = String(name || '').toLowerCase();
  if (!headers) return '';
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return headers[k];
  }
  return '';
}

async function parseJsonBody(req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    return { ok: true, body: JSON.parse(raw || '{}') };
  } catch {
    writeJson(res, req, 400, { ok: false, error: 'Invalid JSON' });
    return { ok: false, body: {} };
  }
}

async function handleDemoCodeCreate(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    writeJson(res, req, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  const adminSecret = String(process.env.DEMO_CODE_ADMIN_SECRET || '').trim();
  const provided = String(getHeader(req.headers, 'x-admin-key') || '').trim();
  if (!adminSecret) {
    writeJson(res, req, 503, { ok: false, error: 'Admin code API is not configured.' });
    return;
  }
  if (!provided || provided !== adminSecret) {
    writeJson(res, req, 403, { ok: false, error: 'Forbidden' });
    return;
  }
  if (!isDynamicCodeStoreConfigured()) {
    writeJson(res, req, 503, {
      ok: false,
      error: 'Dynamic code store is not configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).',
    });
    return;
  }

  const parsed = await parseJsonBody(req, res);
  if (!parsed.ok) return;
  const body = parsed.body;

  const rawNumber = body.number;
  let batchCount = 1;
  if (rawNumber != null && rawNumber !== '') {
    const n = Number(rawNumber);
    if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
      writeJson(res, req, 400, { ok: false, error: 'number must be a positive integer.' });
      return;
    }
    batchCount = Math.min(n, MAX_CODES_PER_REQUEST);
    if (n > MAX_CODES_PER_REQUEST) {
      writeJson(res, req, 400, {
        ok: false,
        error: `number must be at most ${MAX_CODES_PER_REQUEST}.`,
      });
      return;
    }
  }

  const explicitCode = body.code != null ? String(body.code) : '';
  if (batchCount > 1 && explicitCode.trim() !== '') {
    writeJson(res, req, 400, {
      ok: false,
      error: 'Cannot set code when creating multiple (number > 1); omit code for batch.',
    });
    return;
  }

  if (batchCount > 1) {
    const batch = await createDynamicAccessCodesBatch({
      count: batchCount,
      maxUses: body.maxUses,
      ttlSeconds: body.ttlSeconds,
    });
    if (!batch.ok) {
      if (batch.reason === 'invalid_code_format') {
        writeJson(res, req, 400, {
          ok: false,
          error: 'Invalid code format. Use 4-64 chars: uppercase letters, numbers, hyphen.',
        });
        return;
      }
      writeJson(res, req, 503, {
        ok: false,
        error: 'Could not create access codes right now.',
        reason: batch.reason,
        atIndex: batch.atIndex,
      });
      return;
    }
    const first = batch.codes[0];
    writeJson(res, req, 200, {
      ok: true,
      maxUses: first?.remainingUses,
      ttlSeconds: first?.ttlSeconds,
      createdAt: batch.createdAt,
      codes: batch.codes.map((row) => ({
        code: row.code,
        remainingUses: row.remainingUses,
      })),
    });
    return;
  }

  const created = await createDynamicAccessCode({
    code: explicitCode,
    maxUses: body.maxUses,
    ttlSeconds: body.ttlSeconds,
  });
  if (!created.ok) {
    if (created.reason === 'already_exists') {
      writeJson(res, req, 409, { ok: false, error: 'Access code already exists.' });
      return;
    }
    if (created.reason === 'invalid_code_format') {
      writeJson(res, req, 400, {
        ok: false,
        error: 'Invalid code format. Use 4-64 chars: uppercase letters, numbers, hyphen.',
      });
      return;
    }
    writeJson(res, req, 503, { ok: false, error: 'Could not create access code right now.' });
    return;
  }
  writeJson(res, req, 200, {
    ok: true,
    maxUses: created.remainingUses,
    ttlSeconds: created.ttlSeconds,
    createdAt: created.createdAt,
    codes: [{ code: created.code, remainingUses: created.remainingUses }],
  });
}

async function handleDemoCodeRevoke(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    writeJson(res, req, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  const adminSecret = String(process.env.DEMO_CODE_ADMIN_SECRET || '').trim();
  const provided = String(getHeader(req.headers, 'x-admin-key') || '').trim();
  if (!adminSecret) {
    writeJson(res, req, 503, { ok: false, error: 'Admin code API is not configured.' });
    return;
  }
  if (!provided || provided !== adminSecret) {
    writeJson(res, req, 403, { ok: false, error: 'Forbidden' });
    return;
  }
  if (!isDynamicCodeStoreConfigured()) {
    writeJson(res, req, 503, {
      ok: false,
      error: 'Dynamic code store is not configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).',
    });
    return;
  }

  const parsed = await parseJsonBody(req, res);
  if (!parsed.ok) return;
  const revoked = await revokeDynamicAccessCode(parsed.body.code != null ? String(parsed.body.code) : '');
  if (!revoked.ok) {
    if (revoked.reason === 'invalid_code_format') {
      writeJson(res, req, 400, { ok: false, error: 'Invalid access code format.' });
      return;
    }
    writeJson(res, req, 503, { ok: false, error: 'Could not revoke code.' });
    return;
  }
  writeJson(res, req, 200, { ok: true, code: revoked.code, removed: revoked.removed });
}

function safeResolveFile(urlPathname) {
  let rel = urlPathname;
  if (rel === '/' || rel === '') rel = 'index.html';
  else rel = rel.replace(/^\//, '');
  let disk = path.join(SITE_ROOT, rel);
  const rootResolved = path.resolve(SITE_ROOT);

  const ensureInside = (p) => {
    const r = path.resolve(p);
    if (!r.startsWith(rootResolved + path.sep) && r !== rootResolved) return null;
    return r;
  };

  disk = ensureInside(disk);
  if (!disk) return null;

  if (fs.existsSync(disk) && fs.statSync(disk).isDirectory()) {
    disk = ensureInside(path.join(disk, 'index.html'));
  }
  if (!disk || !fs.existsSync(disk) || fs.statSync(disk).isDirectory()) {
    const asDir = ensureInside(path.join(SITE_ROOT, rel, 'index.html'));
    if (asDir && fs.existsSync(asDir)) return asDir;
    return null;
  }
  return disk;
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const file = safeResolveFile(u.pathname);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Read error');
      return;
    }
    var out = buf;
    if (ext === '.html') {
      const html = out.toString('utf8');
      out = Buffer.from(
        html.replaceAll('__TURNSTILE_SITE_KEY__', TURNSTILE_SITE_KEY),
        'utf8',
      );
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') res.end();
    else res.end(out);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (u.pathname === DEMO_VERIFY_PATH) {
    handleDemoVerify(req, res).catch((err) => {
      if (!res.headersSent) {
        writeJson(res, req, 500, { ok: false, error: String(err?.message || err) });
      }
    });
    return;
  }
  if (u.pathname === DEMO_CODE_CREATE_PATH) {
    handleDemoCodeCreate(req, res).catch((err) => {
      if (!res.headersSent) {
        writeJson(res, req, 500, { ok: false, error: String(err?.message || err) });
      }
    });
    return;
  }
  if (u.pathname === DEMO_CODE_REVOKE_PATH) {
    handleDemoCodeRevoke(req, res).catch((err) => {
      if (!res.headersSent) {
        writeJson(res, req, 500, { ok: false, error: String(err?.message || err) });
      }
    });
    return;
  }
  if (u.pathname === PROXY_PREFIX || u.pathname.startsWith(PROXY_PREFIX + '/')) {
    proxyAssess(req, res);
    return;
  }
  serveStatic(req, res);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use (e.g. npx serve). Stop that server, or run:\n` +
        `  PORT=3040 node scripts/maika-dev-proxy.mjs\n` +
        `then open http://localhost:3040/demo/`,
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.error(
    `Maika dev: http://localhost:${PORT}/  (site: ${SITE_ROOT})\n` +
      `  Assess proxy: http://localhost:${PORT}${PROXY_PREFIX}/… → ${UPSTREAM}/…\n` +
      `  Demo verify: POST http://localhost:${PORT}${DEMO_VERIFY_PATH}\n` +
      `  Demo code create: POST http://localhost:${PORT}${DEMO_CODE_CREATE_PATH}\n` +
      `  Demo code revoke: POST http://localhost:${PORT}${DEMO_CODE_REVOKE_PATH}`,
  );
});
