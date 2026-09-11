// TraceMask server — binds to localhost only. Zero third-party dependencies.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, send, parseCookies, serveStatic } from './http.js';
import { registerRoutes } from './api/routes.js';
import { registerExtRoutes, authenticateExt } from './api/ext.js';
import { checkSession, isInitialized, isUnlocked } from './vault.js';
import { initPsl } from './lib/psl.js';
import { loadTrackers } from './lib/trackers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 4390;
const HOST = '127.0.0.1';
const STREAMING = Symbol('streaming');

const router = new Router();
registerRoutes(router);
registerExtRoutes(router);

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-permitted-cross-domain-policies': 'none',
  'origin-agent-cluster': '?1'
};

const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 120000 }, async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  // DNS-rebinding protection: only answer requests addressed to localhost
  if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) return send(res, 421, 'Misdirected request');

  const origin = req.headers.origin || '';
  const extOrigin = /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  if (extOrigin && String(req.url).startsWith('/api/ext/')) {
    // The browser extension calls from its own origin; it authenticates with a bearer token, never with cookies.
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' });
      return res.end();
    }
  }
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) return send(res, 405, 'Method not allowed', { allow: 'GET, POST, PATCH, DELETE' });
  let url;
  try { url = new URL(req.url, `http://${req.headers.host}`); } catch { return send(res, 400, 'Bad request'); }
  if (!url.pathname.startsWith('/api/')) return serveStatic(PUBLIC, req, res, url.pathname);

  const route = router.match(req.method, url.pathname);
  if (!route) return send(res, 404, { error: 'Not found' });
  if (route.bad) return send(res, 400, { error: 'Bad request' });

  const cookies = parseCookies(req);
  const token = cookies.tm_session;
  let authed = false, device = null;
  if (route.opts.ext) {
    // Extension API: bearer-token auth (not ambient), so CSRF via cookies is impossible. Web pages are still refused.
    if (origin && !extOrigin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'Origin not allowed' });
    if (route.opts.ext === 'token') {
      device = authenticateExt(req);
      if (!device) return send(res, 401, { error: 'Extension not paired (or access was revoked)' });
      if (route.opts.unlock && !isUnlocked()) return send(res, 423, { error: 'locked' });
      authed = true;
    }
  } else {
    // CSRF protection for state-changing requests: same-origin + custom header
    if (req.method !== 'GET') {
      if (req.headers['x-tracemask'] !== '1' || (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, '')))) {
        return send(res, 403, { error: 'Cross-site request blocked' });
      }
    }
    authed = checkSession(token);
    if (!route.opts.public && !authed) return send(res, isInitialized() ? 401 : 428, { error: 'Locked' });
  }

  const ctx = {
    req, res, params: route.params, query: url.searchParams, token, authed, device, STREAMING,
    setSession(t) {
      res.setHeader('set-cookie', t
        ? `tm_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`
        : 'tm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    }
  };
  try {
    const out = await route.handler(ctx);
    if (out === STREAMING) return;
    send(res, 200, out ?? { ok: true });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[api]', req.method, url.pathname, e);
    if (!res.headersSent) send(res, status, { error: e.message || 'Server error' });
    else res.end();
  }
});

await initPsl();
loadTrackers().catch(() => {});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n  TraceMask is already running → http://localhost:${PORT}\n  (close the other TraceMask window first if you want to restart it)\n`);
    process.exit(0);
  }
  throw e;
});
server.listen(PORT, HOST, () => {
  console.log('\n  TraceMask is running');
  console.log(`  → Open http://localhost:${PORT} in your browser\n`);
});
