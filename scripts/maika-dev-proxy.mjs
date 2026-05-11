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
 * Demo verify env: DEMO_ACCESS_CODES, TURNSTILE_SECRET_KEY, DEMO_BYPASS_VERIFY (optional local bypass).
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const PROXY_PREFIX = '/api/face-assess';
const DEMO_VERIFY_PATH = '/api/demo-verify';

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

  if (!allowed.length) {
    writeJson(res, req, 503, { ok: false, error: 'Demo access is not configured (DEMO_ACCESS_CODES).' });
    return;
  }
  if (!accessCode) {
    writeJson(res, req, 400, { ok: false, error: 'Missing access code.' });
    return;
  }
  if (!allowed.includes(accessCode.toUpperCase())) {
    writeJson(res, req, 403, { ok: false, error: 'Invalid access code.' });
    return;
  }
  if (bypass) {
    writeJson(res, req, 200, { ok: true });
    return;
  }
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
  writeJson(res, req, 200, { ok: true });
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
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') res.end();
    else res.end(buf);
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
      `  Demo verify: POST http://localhost:${PORT}${DEMO_VERIFY_PATH}`,
  );
});
