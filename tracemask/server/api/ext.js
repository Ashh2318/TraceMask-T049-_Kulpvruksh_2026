// Browser-extension API. The extension authenticates with a per-browser bearer token obtained through a
// short-lived one-time pairing code shown in TraceMask → Settings. Tokens are stored only as SHA-256 hashes.
import crypto from 'node:crypto';
import { db, now, audit } from '../db.js';
import { readJson } from '../http.js';
import * as vault from '../vault.js';
import { normalizeTarget, scanSite } from '../lib/scanner.js';
import { recommendTier, TIERS, PURPOSES } from '../lib/aliases.js';
import { getMailbox, expireBurners } from '../lib/sync.js';
import { saveScan, ensureBareSite, createIdentity } from '../lib/identity.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const J = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_TTL = 5 * 60 * 1000;
let pairing = null; // { hash, expires, attempts }
let scansRunning = 0;

export function authenticateExt(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{32,128})$/);
  if (!m) return null;
  const row = db.prepare('SELECT * FROM ext_tokens WHERE token_hash = ?').get(sha(m[1]));
  if (!row) return null;
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at) > 60000) db.prepare('UPDATE ext_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  return row;
}

function siteSummary(site) {
  if (!site) return null;
  const scan = J(site.scan_json, null);
  return {
    id: site.id, domain: site.domain, title: site.title, score: site.risk_score, level: site.risk_level || 'unknown', scannedAt: site.scanned_at,
    coverage: scan?.risk?.coverage ?? null,
    breaches: scan?.breaches?.breaches?.length ?? null,
    trackers: scan?.page?.ok ? scan.page.analysis.trackers.length : null,
    findings: (scan?.risk?.factors || []).filter(f => f.points > 0).sort((a, b) => b.points - a.points).slice(0, 4)
      .map(f => ({ label: f.label, detail: f.detail, points: f.points, status: f.status }))
  };
}
const recommendations = (score) => Object.fromEntries(Object.keys(PURPOSES).map(p => {
  const r = recommendTier(p, score ?? 50);
  return [p, { tier: r.tier, name: TIERS[r.tier].name, reasons: r.reasons, share: r.share }];
}));
function aliasOut(a) {
  return { id: a.id, address: String(a.address).split('#')[0], tier: a.tier, tierName: TIERS[a.tier]?.name, status: a.status, createdAt: a.created_at, expiresAt: a.expires_at,
    leaks: db.prepare("SELECT COUNT(*) AS n FROM leaks WHERE alias_id = ? AND status != 'dismissed'").get(a.id).n };
}
function targetFrom(url) {
  try { return normalizeTarget(url); }
  catch { throw bad('TraceMask protects sign-ups on public websites (http/https pages only).', 422); }
}

export function registerExtRoutes(r) {
  // ----- managed from the TraceMask web app (session-authenticated) -----
  r.add('POST', '/api/ext/pairing-code', () => {
    const bytes = crypto.randomBytes(8);
    const raw = [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    pairing = { hash: sha(raw), expires: Date.now() + PAIR_TTL, attempts: 0 };
    audit('extension.pairing_code', 'one-time code generated (5 min)');
    return { code, expiresAt: new Date(pairing.expires).toISOString() };
  });
  r.add('GET', '/api/ext/devices', () => db.prepare('SELECT id, name, created_at, last_used_at FROM ext_tokens ORDER BY created_at DESC').all());
  r.add('DELETE', '/api/ext/devices/:id', (ctx) => {
    const row = db.prepare('SELECT name FROM ext_tokens WHERE id = ?').get(ctx.params.id);
    db.prepare('DELETE FROM ext_tokens WHERE id = ?').run(ctx.params.id);
    if (row) audit('extension.revoked', row.name);
    return { ok: true };
  });

  // ----- called by the extension -----
  r.add('POST', '/api/ext/pair', async (ctx) => {
    const b = await readJson(ctx.req);
    const raw = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!pairing || Date.now() > pairing.expires) { pairing = null; throw bad('No active pairing code. In TraceMask open Settings → Browser extension → Generate code.', 400); }
    if (pairing.attempts >= 5) { pairing = null; audit('extension.pair_locked', 'too many wrong codes'); throw bad('Too many wrong attempts. Generate a new code in TraceMask.', 429); }
    const ok = raw.length === 8 && crypto.timingSafeEqual(Buffer.from(sha(raw)), Buffer.from(pairing.hash));
    if (!ok) { pairing.attempts++; audit('extension.pair_failed', `attempt ${pairing.attempts}`); throw bad('That code is not correct.', 401); }
    pairing = null;
    const token = crypto.randomBytes(32).toString('base64url');
    const name = String(b.name || 'Browser extension').replace(/[^\w .()-]/g, '').slice(0, 60) || 'Browser extension';
    db.prepare('INSERT INTO ext_tokens (name, token_hash, created_at, last_used_at) VALUES (?,?,?,?)').run(name, sha(token), now(), now());
    audit('extension.paired', name);
    return { token, name };
  }, { ext: 'public' });

  // The extension revokes its own token when the user clicks "Unpair" in the extension.
  r.add('POST', '/api/ext/unpair', (ctx) => {
    db.prepare('DELETE FROM ext_tokens WHERE id = ?').run(ctx.device.id);
    audit('extension.unpaired', ctx.device.name);
    return { ok: true };
  }, { ext: 'token' });

  r.add('GET', '/api/ext/status', () => {
    const mb = getMailbox();
    const unlocked = vault.isUnlocked();
    return {
      app: 'TraceMask', unlocked, initialized: vault.isInitialized(),
      mailbox: mb ? { address: mb.base_address, aliasMode: mb.alias_mode, lastSyncAt: mb.last_sync_at, lastSyncStatus: mb.last_sync_status } : null,
      openLeaks: unlocked ? db.prepare("SELECT COUNT(*) AS n FROM leaks WHERE status = 'open'").get().n : null
    };
  }, { ext: 'token' });

  r.add('POST', '/api/ext/lookup', async (ctx) => {
    const { url } = await readJson(ctx.req);
    const target = targetFrom(url);
    expireBurners();
    const site = db.prepare('SELECT * FROM sites WHERE domain = ?').get(target.domain);
    const aliases = site ? db.prepare("SELECT * FROM aliases WHERE site_id = ? ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC").all(site.id).map(aliasOut) : [];
    return {
      domain: target.domain, host: target.host, site: siteSummary(site), aliases,
      openLeaks: site ? db.prepare("SELECT COUNT(*) AS n FROM leaks WHERE site_id = ? AND status = 'open'").get(site.id).n : 0,
      recommendations: recommendations(site?.risk_score), purposes: PURPOSES, mailbox: !!getMailbox()
    };
  }, { ext: 'token', unlock: true });

  r.add('POST', '/api/ext/scan', async (ctx) => {
    const { url } = await readJson(ctx.req);
    const target = targetFrom(url);
    if (scansRunning >= 3) throw bad('Too many scans running — try again in a moment', 429);
    scansRunning++;
    try {
      const result = await scanSite(target.url);
      const site = saveScan(target, result);
      return { site: siteSummary(site), recommendations: recommendations(site.risk_score) };
    } finally { scansRunning--; }
  }, { ext: 'token', unlock: true });

  r.add('POST', '/api/ext/alias', async (ctx) => {
    const b = await readJson(ctx.req);
    const target = targetFrom(b.url);
    if (!PURPOSES[b.purpose]) throw bad('Choose what this sign-up is for');
    if (!getMailbox()) throw bad('Connect your mailbox in TraceMask first', 409);
    let site = db.prepare('SELECT * FROM sites WHERE domain = ?').get(target.domain);
    let scanned = false, scanError = null;
    if (!site || !site.scan_json) {
      if (scansRunning >= 3) throw bad('Too many scans running — try again in a moment', 429);
      scansRunning++;
      try { site = saveScan(target, await scanSite(target.url)); scanned = true; }
      catch (e) { scanError = e.message; site = ensureBareSite(target); }
      finally { scansRunning--; }
    }
    const a = createIdentity({ site, purpose: b.purpose, tier: b.tier, label: b.label, source: 'extension' });
    return {
      alias: a.realIdentity ? { ...aliasOut(a), address: a.address, realIdentity: true } : aliasOut(a),
      site: siteSummary(db.prepare('SELECT * FROM sites WHERE id = ?').get(site.id)), scanned, scanError
    };
  }, { ext: 'token', unlock: true });

  r.add('GET', '/api/ext/leaks', () => db.prepare(`
      SELECT l.id, l.sender_domain, l.severity, l.status, l.first_seen, l.detected_at, l.message_count, a.address, s.domain AS site_domain
      FROM leaks l JOIN aliases a ON a.id = l.alias_id LEFT JOIN sites s ON s.id = l.site_id
      WHERE l.status = 'open' ORDER BY l.detected_at DESC LIMIT 10`).all(),
    { ext: 'token', unlock: true });
}
