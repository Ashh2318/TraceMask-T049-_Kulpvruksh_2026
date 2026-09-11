// TraceMask security probe — runs known web-attack checks against a running TraceMask instance.
// Usage:  node tests/security-probe.mjs            (unauthenticated checks)
//         TM_PASSWORD=yourMasterPassword node tests/security-probe.mjs   (adds authenticated checks)
// Only ever targets 127.0.0.1 (your own local instance).
import http from 'node:http';

const PORT = Number(process.env.PORT) || 4390;
const results = [];
const record = (id, name, pass, detail = '') => results.push({ id, name, pass, detail });

function req(path, { method = 'GET', headers = {}, body, raw } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { host: `localhost:${PORT}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers }, insecureHTTPParser: false }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e.message) }));
    r.setTimeout(30000, () => { r.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}
const rawPath = (p) => req(p); // http.request sends the path verbatim (no normalisation)

async function main() {
  const alive = await req('/api/status');
  if (alive.status !== 200) { console.error(`TraceMask is not running on port ${PORT}`); process.exit(2); }

  // A05 Security misconfiguration — headers
  const home = await req('/');
  const h = home.headers;
  record('A05-1', 'Content-Security-Policy blocks inline script & framing', /script-src 'self'/.test(h['content-security-policy'] || '') && /frame-ancestors 'none'/.test(h['content-security-policy'] || ''), h['content-security-policy']);
  record('A05-2', 'X-Frame-Options DENY (clickjacking)', h['x-frame-options'] === 'DENY');
  record('A05-3', 'X-Content-Type-Options nosniff', h['x-content-type-options'] === 'nosniff');
  record('A05-4', 'Referrer-Policy no-referrer', h['referrer-policy'] === 'no-referrer');
  record('A05-5', 'No Server / X-Powered-By banner', !h['server'] && !h['x-powered-by']);
  const api = await req('/api/status');
  record('A05-6', 'API responses not cacheable', /no-store/.test(api.headers['cache-control'] || ''));
  const trace = await req('/api/status', { method: 'TRACE' });
  record('A05-7', 'TRACE method not served', trace.status >= 400, `HTTP ${trace.status}`);

  // DNS rebinding
  const rebind = await req('/api/status', { headers: { host: 'attacker.example' } });
  record('A01-1', 'DNS-rebinding: foreign Host header rejected', rebind.status === 421, `HTTP ${rebind.status}`);

  // Broken access control
  const noauth = await req('/api/dashboard');
  record('A01-2', 'API requires an unlocked session', [401, 428].includes(noauth.status), `HTTP ${noauth.status}`);
  const noauth2 = await req('/api/export');
  record('A01-3', 'Data export requires session', [401, 428].includes(noauth2.status), `HTTP ${noauth2.status}`);

  // CSRF
  const csrf1 = await req('/api/vault/lock', { method: 'POST', body: {} });
  record('A01-4', 'CSRF: state change without custom header blocked', csrf1.status === 403, `HTTP ${csrf1.status}`);
  const csrf2 = await req('/api/vault/lock', { method: 'POST', body: {}, headers: { 'x-tracemask': '1', origin: 'https://attacker.example' } });
  record('A01-5', 'CSRF: cross-origin Origin blocked', csrf2.status === 403, `HTTP ${csrf2.status}`);

  // Path traversal
  const trav = ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/server/vault.js', '/js/../../server/db.js', '/..%5c..%5cserver%5cdb.js', '/css/..%2f..%2fserver%2findex.js', '/..%252f..%252fpackage.json'];
  let leaked = [];
  for (const t of trav) { const r = await rawPath(t); if (/DatabaseSync|scrypt|"name": "tracemask"|registerRoutes/.test(r.body)) leaked.push(t); }
  record('A01-6', 'Path traversal outside /public blocked', !leaked.length, leaked.join(' ') || `${trav.length} payloads`);

  // Malformed URI must not crash the server
  await rawPath('/%E0%A4%A');
  await rawPath('/api/aliases/%E0%A4%A');
  const still = await req('/api/status');
  record('A04-1', 'Malformed percent-encoding does not crash server', still.status === 200, `HTTP ${still.status}`);

  // Input handling
  const big = await req('/api/vault/unlock', { method: 'POST', headers: { 'x-tracemask': '1' }, body: JSON.stringify({ password: 'x'.repeat(400000) }) });
  record('A04-2', 'Oversized request body rejected', big.status === 413 || big.status === 0, `HTTP ${big.status}`);
  const badjson = await req('/api/vault/unlock', { method: 'POST', headers: { 'x-tracemask': '1' }, body: '{"password":' });
  record('A04-3', 'Invalid JSON rejected cleanly', badjson.status === 400, `HTTP ${badjson.status}`);

  // Browser-extension API (bearer token, never cookies)
  const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const e1 = await req('/api/ext/status');
  record('EXT-1', 'Extension API requires a paired-browser token', e1.status === 401, `HTTP ${e1.status}`);
  const e2 = await req('/api/ext/lookup', { method: 'POST', headers: { authorization: `Bearer ${'A'.repeat(43)}` }, body: { url: 'https://example.com' } });
  record('EXT-2', 'Forged / revoked extension token rejected', e2.status === 401, `HTTP ${e2.status}`);
  const e3 = await req('/api/ext/pair', { method: 'POST', headers: { origin: 'https://attacker.example' }, body: { code: 'ABCD-2345' } });
  record('EXT-3', 'Web pages cannot call the extension API (Origin check)', e3.status === 403, `HTTP ${e3.status}`);
  const e4 = await req('/api/ext/pairing-code', { method: 'POST', headers: { 'x-tracemask': '1', origin: EXT_ORIGIN }, body: {} });
  record('EXT-4', 'Pairing codes can only be minted from the unlocked app', [401, 403, 428].includes(e4.status), `HTTP ${e4.status}`);
  const e5 = await req('/api/ext/status', { method: 'OPTIONS', headers: { origin: 'https://attacker.example', 'access-control-request-method': 'GET' } });
  record('EXT-5', 'CORS: no access granted to web origins', !e5.headers['access-control-allow-origin'], `HTTP ${e5.status}`);
  const e6 = await req('/api/ext/status', { method: 'OPTIONS', headers: { origin: EXT_ORIGIN, 'access-control-request-method': 'GET' } });
  record('EXT-6', 'CORS: extension origin allowed without credentials', e6.status === 204 && e6.headers['access-control-allow-origin'] === EXT_ORIGIN && !e6.headers['access-control-allow-credentials'], `HTTP ${e6.status}`);

  let cookie = null;
  if (process.env.TM_PASSWORD) {
    const login = await req('/api/vault/unlock', { method: 'POST', headers: { 'x-tracemask': '1' }, body: { password: process.env.TM_PASSWORD } });
    const sc = [].concat(login.headers['set-cookie'] || [])[0] || '';
    cookie = sc.split(';')[0];
    record('A07-1', 'Session cookie is HttpOnly + SameSite=Strict', /HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc), sc.replace(/tm_session=[^;]+/, 'tm_session=…'));
    record('A07-2', 'Session token has ≥256 bits of entropy', (cookie.split('=')[1] || '').length >= 43);
    const A = { cookie, 'x-tracemask': '1' };

    // A03 Injection
    const sqli = await req(`/api/aliases?q=${encodeURIComponent("' OR 1=1 --")}`, { headers: { cookie } });
    record('A03-1', 'SQL injection in search is inert (parameterised)', sqli.status === 200 && !/SQLITE|syntax/i.test(sqli.body), `HTTP ${sqli.status}`);
    const imapInj = await req('/api/mailbox/test', { method: 'POST', headers: A, body: { host: 'imap.gmail.com', username: 'a@b.com\r\nX1 LOGOUT', password: 'p', provider: 'custom' } });
    record('A03-2', 'IMAP command injection (CRLF in credentials) rejected', imapInj.status === 400, `HTTP ${imapInj.status} ${imapInj.body.slice(0, 80)}`);
    const hostInj = await req('/api/mailbox/test', { method: 'POST', headers: A, body: { host: '127.0.0.1', username: 'a@b.com', password: 'p', provider: 'custom' } });
    record('A03-3', 'Mailbox host must be a public IMAP server (no internal hosts)', hostInj.status === 400, `HTTP ${hostInj.status} ${hostInj.body.slice(0, 80)}`);
    const proto = await req('/api/settings', { method: 'PATCH', headers: A, body: JSON.parse('{"__proto__":{"polluted":1},"syncIntervalMin":"abc"}') });
    const s2 = await req('/api/settings', { headers: { cookie } });
    record('A08-1', 'Prototype pollution / type confusion in settings ignored', proto.status === 200 && !/polluted/.test(s2.body) && JSON.parse(s2.body).syncIntervalMin >= 1);

    // A10 SSRF
    const targets = ['127.0.0.1', 'localhost', 'http://169.254.169.254/latest/meta-data/', '10.0.0.1', '192.168.1.1', '[::1]', '0.0.0.0', 'localtest.me', '2130706433', '0x7f000001', '127.1', 'http://127.0.0.1:4390/api/status'];
    const allowed = [];
    for (const t of targets) {
      const r = await req('/api/scan', { method: 'POST', headers: A, body: { url: t } });
      if (r.status === 200 && /"type":"result"/.test(r.body)) allowed.push(t);
    }
    record('A10-1', 'SSRF: scanner refuses loopback / private / metadata targets', !allowed.length, allowed.join(', ') || `${targets.length} payloads refused`);

    // Extension pairing: session cookie is not an extension credential; codes resist guessing
    const e7 = await req('/api/ext/lookup', { method: 'POST', headers: { cookie }, body: { url: 'https://example.com' } });
    record('EXT-7', 'Session cookie does not authenticate the extension API', e7.status === 401, `HTTP ${e7.status}`);
    await req('/api/ext/pairing-code', { method: 'POST', headers: A, body: {} });
    let codeLocked = false, tries = 0;
    for (; tries < 7 && !codeLocked; tries++) {
      const r = await req('/api/ext/pair', { method: 'POST', headers: { origin: EXT_ORIGIN }, body: { code: `ZZZZ-ZZZ${tries}` } });
      if (r.status === 429) codeLocked = true;
    }
    const after = await req('/api/ext/pair', { method: 'POST', headers: { origin: EXT_ORIGIN }, body: { code: 'ZZZZ-ZZZZ' } });
    record('EXT-8', 'Pairing code burns after 5 wrong guesses', codeLocked && after.status === 400, `locked after ${tries} tries`);
  }

  // A07 brute force (last — it triggers the lockout)
  let locked = false;
  for (let i = 0; i < 6 && !locked; i++) {
    const r = await req('/api/vault/unlock', { method: 'POST', headers: { 'x-tracemask': '1' }, body: { password: `wrong-guess-${i}` } });
    if (r.status === 429) locked = true;
  }
  record('A07-3', 'Brute-force lockout on master password', locked);

  const pad = (s, n) => String(s).padEnd(n);
  console.log('\nTraceMask security probe — ' + new Date().toISOString() + '\n' + '-'.repeat(96));
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${pad(r.id, 7)} ${pad(r.name, 62)} ${r.detail ? String(r.detail).slice(0, 60) : ''}`);
  const failed = results.filter(r => !r.pass).length;
  console.log('-'.repeat(96) + `\n${results.length - failed}/${results.length} checks passed${process.env.TM_PASSWORD ? '' : ' (set TM_PASSWORD to include authenticated checks)'}\n`);
  if (process.env.TM_JSON) (await import('node:fs')).writeFileSync(process.env.TM_JSON, JSON.stringify(results, null, 2));
  process.exit(failed ? 1 : 0);
}
main();
