// TraceMask CI smoke test (npm test).
//  1. Syntax-checks every JavaScript file in the app and the extension.
//  2. Validates the Chrome extension manifest and checks that every file it references exists.
//  3. Boots a throw-away TraceMask instance (temporary data folder, free local port), creates a vault,
//     and runs the full security probe (tests/security-probe.mjs) against it.
// No network access to your mailbox is needed and nothing outside the temporary folder is touched.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'data', 'reports', '.git', 'docs']);
const failures = [];
const ok = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}

// 1. syntax
console.log('Syntax check');
const files = walk(ROOT);
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) fail(`${path.relative(ROOT, f)}\n${r.stderr}`);
}
ok(`${files.length} JavaScript files parse`);

// 2. extension manifest
console.log('Chrome extension');
const extDir = path.join(ROOT, 'extension');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let manifest = null;
try { manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8')); ok('manifest.json is valid JSON'); }
catch (e) { fail(`manifest.json: ${e.message}`); }
if (manifest) {
  if (manifest.manifest_version === 3) ok('Manifest V3'); else fail('manifest_version must be 3');
  if (manifest.version === pkg.version) ok(`extension version matches app version (${pkg.version})`);
  else fail(`extension version ${manifest.version} differs from package.json ${pkg.version}`);
  const refs = [
    ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}),
    manifest.action?.default_popup, manifest.options_ui?.page, manifest.background?.service_worker,
    ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])])
  ].filter(Boolean);
  const missing = refs.filter((r) => !fs.existsSync(path.join(extDir, r)));
  if (missing.length) fail(`manifest references missing files: ${missing.join(', ')}`); else ok(`${refs.length} referenced files exist`);
  const hosts = manifest.host_permissions || [];
  if (hosts.includes('http://localhost/*')) ok('extension may reach the local app'); else fail('host_permissions must include http://localhost/*');
}

// 3. boot a temporary instance and run the security probe
console.log('Server + security probe');
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const PORT = String(await freePort());
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemask-ci-'));
const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT, TRACEMASK_DATA: DATA }, stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const base = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try { up = (await fetch(`${base}/api/status`)).ok; } catch { /* not listening yet */ }
}
if (!up) fail(`server did not start on port ${PORT}\n${serverLog}`);
else {
  ok(`server started on 127.0.0.1:${PORT}`);
  const password = `Ci-${crypto.randomBytes(12).toString('base64url')}-9a!`;
  const init = await fetch(`${base}/api/vault/init`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tracemask': '1' }, body: JSON.stringify({ password }) });
  if (init.ok) ok('vault created'); else fail(`vault init failed: HTTP ${init.status} ${await init.text()}`);
  const probe = spawnSync(process.execPath, ['tests/security-probe.mjs'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PORT, TM_PASSWORD: password }, timeout: 180000 });
  process.stdout.write(probe.stdout.split('\n').map((l) => (l ? `    ${l}` : l)).join('\n'));
  if (probe.status === 0) ok('security probe passed'); else fail(`security probe failed (exit ${probe.status})\n${probe.stderr}`);
}
server.kill();
await new Promise((r) => server.once('exit', r));
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows may keep the file locked briefly */ }

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
