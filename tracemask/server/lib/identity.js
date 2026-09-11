// Shared site + identity helpers used by the web API and the browser-extension API.
import { db, now, audit, getSettings } from '../db.js';
import { recommendTier, makeAlias } from './aliases.js';
import { getMailbox } from './sync.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

export function saveScan(target, result) {
  const p = result.privacy || {};
  const existing = db.prepare('SELECT * FROM sites WHERE domain = ?').get(target.domain);
  if (existing) {
    db.prepare('UPDATE sites SET url=?, title=?, risk_score=?, risk_level=?, scan_json=?, privacy_url=?, contact_emails=?, scanned_at=? WHERE id=?')
      .run(target.url, result.title ?? null, result.risk.score, result.risk.level, JSON.stringify(result), p.url || null, JSON.stringify(p.emails || []), now(), existing.id);
  } else {
    db.prepare(`INSERT INTO sites (domain, url, title, risk_score, risk_level, scan_json, privacy_url, contact_emails, scanned_at, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(target.domain, target.url, result.title ?? null, result.risk.score, result.risk.level, JSON.stringify(result), p.url || null, JSON.stringify(p.emails || []), now(), now());
  }
  audit('site.scanned', `${target.domain} score ${result.risk.score}`);
  return db.prepare('SELECT * FROM sites WHERE domain = ?').get(target.domain);
}

// A site row without a scan (used when a site cannot be scanned, e.g. it blocks automated checks or does not resolve).
export function ensureBareSite(target) {
  const existing = db.prepare('SELECT * FROM sites WHERE domain = ?').get(target.domain);
  if (existing) return existing;
  db.prepare(`INSERT INTO sites (domain, url, risk_score, risk_level, created_at) VALUES (?,?,NULL,'unknown',?)`).run(target.domain, target.url, now());
  return db.prepare('SELECT * FROM sites WHERE domain = ?').get(target.domain);
}

export function createIdentity({ site, purpose, tier: requestedTier, label, source = 'web' }) {
  const mb = getMailbox();
  if (!mb) throw bad('Connect your mailbox first so aliases can be monitored');
  const rec = recommendTier(purpose, site.risk_score ?? 50);
  const tier = [0, 1, 2, 3].includes(Number(requestedTier)) ? Number(requestedTier) : rec.tier;
  const settings = getSettings();
  if (tier === 3) {
    const address = mb.base_address;
    const key = `${address}#${site.domain}`;
    const existing = db.prepare('SELECT * FROM aliases WHERE address = ?').get(key);
    if (existing) return { ...existing, address, realIdentity: true };
    const id = db.prepare(`INSERT INTO aliases (address, site_id, tier, purpose, label, status, created_at)
      VALUES (?,?,?,?,?, 'disclosed', ?)`).run(key, site.id, 3, purpose, label || site.domain, now()).lastInsertRowid;
    audit('identity.disclosed', `real identity shared with ${site.domain} (${source})`);
    return { ...db.prepare('SELECT * FROM aliases WHERE id = ?').get(id), address, realIdentity: true };
  }
  let address;
  for (let i = 0; i < 5; i++) {
    address = makeAlias(mb, site.domain, settings.aliasStyle);
    if (!db.prepare('SELECT 1 FROM aliases WHERE address = ?').get(address)) break;
  }
  const expires = tier === 0 ? new Date(Date.now() + settings.burnerHours * 3600000).toISOString() : null;
  const id = db.prepare(`INSERT INTO aliases (address, site_id, tier, purpose, label, status, created_at, expires_at)
    VALUES (?,?,?,?,?, 'active', ?, ?)`).run(address, site.id, tier, purpose, label || site.domain, now(), expires).lastInsertRowid;
  audit('alias.created', `${address} for ${site.domain} (T${tier}, ${source})`);
  return db.prepare('SELECT * FROM aliases WHERE id = ?').get(id);
}
