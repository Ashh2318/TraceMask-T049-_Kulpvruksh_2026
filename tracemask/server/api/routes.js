import { db, now, audit, getSettings, saveSettings, getMeta } from '../db.js';
import * as vault from '../vault.js';
import { readJson, send } from '../http.js';
import { withImap } from '../lib/imap.js';
import { scanSite, normalizeTarget } from '../lib/scanner.js';
import { recommendTier, makeAlias, TIERS, PURPOSES } from '../lib/aliases.js';
import { runSync, getMailbox, findFolders, startBackground, stopBackground, isSyncing, onSyncEvent, expireBurners } from '../lib/sync.js';
import { draftErasure, LAWS } from '../lib/erasure.js';
import { registrable } from '../lib/psl.js';
import { trackerMeta } from '../lib/trackers.js';
import { pslSource } from '../lib/psl.js';
import { assertPublicHost } from '../lib/net-guard.js';
import { leakBundle, leakReportPdf, siteReportPdf, postureReportPdf, requestLetterPdf } from '../lib/reports.js';
import { saveScan, createIdentity } from '../lib/identity.js';

const CTRL = /[\u0000-\u001f\u007f]/;
let activeScans = 0;

const PERSONAL_PROVIDERS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com',
  'icloud.com', 'me.com', 'rediffmail.com', 'proton.me', 'protonmail.com', 'zoho.com', 'aol.com', 'gmx.com', 'yandex.com']);

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const J = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

export const PROVIDERS = {
  gmail: { label: 'Gmail / Google Workspace', host: 'imap.gmail.com', port: 993, plus: true,
    help: 'Turn on 2-Step Verification, then create an App Password at myaccount.google.com/apppasswords.' },
  zoho: { label: 'Zoho Mail (India)', host: 'imap.zoho.in', port: 993, plus: false, help: 'Enable IMAP access in Zoho Mail settings and use an app-specific password.' },
  custom: { label: 'Other IMAP (catch-all domain)', host: '', port: 993, plus: false, help: 'Any IMAP server over TLS (port 993). Use "catch-all domain" alias mode for your own domain.' }
};

function siteRow(s) {
  if (!s) return null;
  return { ...s, scan: J(s.scan_json, null), contact_emails: J(s.contact_emails, []), trusted_domains: J(s.trusted_domains, []), scan_json: undefined };
}
function aliasRow(a) {
  return a && { ...a, blocked_senders: J(a.blocked_senders, []), tierInfo: TIERS[a.tier] };
}

export function registerRoutes(r) {
  // ---------- vault / session ----------
  r.add('GET', '/api/status', (ctx) => ({
    initialized: vault.isInitialized(), unlocked: ctx.authed, mailbox: ctx.authed ? !!getMailbox() : undefined
  }), { public: true });

  r.add('POST', '/api/vault/init', async (ctx) => {
    const { password } = await readJson(ctx.req);
    const token = await vault.initVault(password);
    ctx.setSession(token);
    return { ok: true };
  }, { public: true });

  r.add('POST', '/api/vault/unlock', async (ctx) => {
    const { password } = await readJson(ctx.req);
    const token = await vault.unlock(password);
    ctx.setSession(token);
    if (getMailbox()) startBackground();
    return { ok: true };
  }, { public: true });

  r.add('POST', '/api/vault/lock', (ctx) => {
    vault.lock();
    stopBackground();
    ctx.setSession('');
    return { ok: true };
  }, { public: true });

  r.add('POST', '/api/vault/password', async (ctx) => {
    const { current, next } = await readJson(ctx.req);
    await vault.changePassword(current, next);
    return { ok: true };
  });

  // ---------- mailbox ----------
  r.add('GET', '/api/providers', () => PROVIDERS);

  r.add('GET', '/api/mailbox', () => {
    const mb = getMailbox();
    if (!mb) return { connected: false };
    const { enc_password, ...rest } = mb;
    return { connected: true, ...rest };
  });

  const testMailbox = async (b) => {
    const host = String(b.host || '').trim();
    const port = Number(b.port) || 993;
    if (!host || !b.username || !b.password) throw bad('Host, username and password are required');
    if (port !== 993) throw bad('Only encrypted IMAP (TLS on port 993) is allowed');
    if ([host, b.username, b.password].some(v => CTRL.test(String(v)))) throw bad('Credentials contain invalid control characters');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) throw bad('Enter the IMAP server host name, e.g. imap.gmail.com');
    if (String(b.username).length > 320 || String(b.password).length > 256) throw bad('Credentials are too long');
    if (!process.env.TRACEMASK_ALLOW_PRIVATE_IMAP) await assertPublicHost(host);
    return withImap({ host, port, user: String(b.username).trim(), pass: String(b.password).replace(/\s+/g, b.provider === 'gmail' ? '' : ' ').trim() }, async (c) => {
      const f = await findFolders(c);
      const inbox = await c.select(f.inbox);
      return { ok: true, inbox: f.inbox, junk: f.junk, messages: inbox.exists, folders: f.all.length,
        capabilities: ['IDLE', 'MOVE', 'UIDPLUS', 'SPECIAL-USE'].filter(x => c.capabilities.has(x)) };
    });
  };

  r.add('POST', '/api/mailbox/test', async (ctx) => testMailbox(await readJson(ctx.req)));

  r.add('POST', '/api/mailbox', async (ctx) => {
    const b = await readJson(ctx.req);
    const test = await testMailbox(b);
    const base = String(b.baseAddress || b.username).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(base)) throw bad('Enter the real email address of this mailbox');
    const aliasMode = b.aliasMode === 'domain' ? 'domain' : 'plus';
    const aliasDomain = aliasMode === 'domain' ? String(b.aliasDomain || '').trim().toLowerCase().replace(/^@/, '') : null;
    if (aliasMode === 'domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(aliasDomain || '')) throw bad('Enter the catch-all domain that delivers to this mailbox');
    const pass = String(b.password).replace(/\s+/g, b.provider === 'gmail' ? '' : ' ').trim();
    db.prepare(`INSERT INTO mailbox (id, provider, host, port, username, enc_password, base_address, alias_mode, alias_domain, created_at)
                VALUES (1,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, host=excluded.host, port=excluded.port, username=excluded.username,
                  enc_password=excluded.enc_password, base_address=excluded.base_address, alias_mode=excluded.alias_mode, alias_domain=excluded.alias_domain`)
      .run(b.provider || 'custom', String(b.host).trim(), 993, String(b.username).trim(), vault.encryptSecret(pass), base, aliasMode, aliasDomain, now());
    audit('mailbox.connected', `${b.host} as ${b.username}`);
    startBackground();
    return { ok: true, test };
  });

  r.add('DELETE', '/api/mailbox', () => {
    stopBackground();
    db.prepare('DELETE FROM mailbox WHERE id = 1').run();
    db.prepare('DELETE FROM folder_state').run();
    audit('mailbox.disconnected');
    return { ok: true };
  });

  // ---------- sync ----------
  r.add('POST', '/api/sync', async () => runSync('manual'));
  r.add('GET', '/api/sync/runs', () => ({
    syncing: isSyncing(),
    runs: db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20').all()
  }));

  // Server-sent events: live leak / sync notifications
  r.add('GET', '/api/events', (ctx) => {
    ctx.res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    ctx.res.write('retry: 5000\n\n');
    const off = onSyncEvent((e) => ctx.res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => ctx.res.write(': ping\n\n'), 25000);
    ctx.req.on('close', () => { off(); clearInterval(ping); });
    return ctx.STREAMING;
  });

  // ---------- site scanning ----------
  r.add('POST', '/api/scan', async (ctx) => {
    const { url } = await readJson(ctx.req);
    const target = normalizeTarget(url);
    if (activeScans >= 3) throw bad('Too many scans running — wait for one to finish', 429);
    activeScans++;
    const res = ctx.res;
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    const write = (o) => res.write(JSON.stringify(o) + '\n');
    write({ type: 'target', target });
    try {
      const result = await scanSite(url, (step, status, summary) => write({ type: 'step', step, status, summary }));
      const site = saveScan(target, result);
      write({ type: 'result', site: siteRow(site) });
    } catch (e) {
      write({ type: 'error', error: e.message });
    } finally { activeScans--; }
    res.end();
    return ctx.STREAMING;
  });

  r.add('GET', '/api/sites', () => db.prepare(`
    SELECT s.id, s.domain, s.url, s.title, s.risk_score, s.risk_level, s.scanned_at,
      (SELECT COUNT(*) FROM aliases a WHERE a.site_id = s.id) AS aliases,
      (SELECT COUNT(*) FROM leaks l WHERE l.site_id = s.id AND l.status != 'dismissed') AS leaks
    FROM sites s ORDER BY s.scanned_at DESC`).all());

  r.add('GET', '/api/sites/:id', (ctx) => {
    const s = siteRow(db.prepare('SELECT * FROM sites WHERE id = ?').get(ctx.params.id));
    if (!s) throw bad('Site not found', 404);
    s.aliases = db.prepare('SELECT * FROM aliases WHERE site_id = ? ORDER BY created_at DESC').all(s.id).map(aliasRow);
    return s;
  });

  r.add('POST', '/api/recommend', async (ctx) => {
    const { siteId, purpose } = await readJson(ctx.req);
    const s = db.prepare('SELECT risk_score FROM sites WHERE id = ?').get(siteId);
    if (!s) throw bad('Scan the site first', 404);
    if (!PURPOSES[purpose]) throw bad('Choose what this sign-up is for');
    return recommendTier(purpose, s.risk_score ?? 50);
  });

  // ---------- aliases ----------
  r.add('GET', '/api/meta', () => ({ tiers: TIERS, purposes: PURPOSES, laws: LAWS, trackers: trackerMeta(), psl: pslSource() }));

  r.add('POST', '/api/aliases', async (ctx) => {
    const b = await readJson(ctx.req);
    if (!getMailbox()) throw bad('Connect your mailbox first so aliases can be monitored');
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(b.siteId);
    if (!site) throw bad('Scan the site first', 404);
    if (!PURPOSES[b.purpose]) throw bad('Choose what this sign-up is for');
    const a = createIdentity({ site, purpose: b.purpose, tier: b.tier, label: b.label, source: 'web' });
    return a.realIdentity ? { ...aliasRow(a), address: a.address, realIdentity: true } : aliasRow(a);
  });

  r.add('GET', '/api/aliases', (ctx) => {
    expireBurners();
    const q = `%${(ctx.query.get('q') || '').toLowerCase()}%`;
    return db.prepare(`
      SELECT a.*, s.domain AS site_domain, s.risk_score, s.risk_level,
        (SELECT COUNT(*) FROM messages m WHERE m.alias_id = a.id) AS messages,
        (SELECT COUNT(*) FROM messages m WHERE m.alias_id = a.id AND m.classification = 'leak') AS leak_messages,
        (SELECT MAX(received_at) FROM messages m WHERE m.alias_id = a.id) AS last_message_at,
        (SELECT COUNT(*) FROM leaks l WHERE l.alias_id = a.id AND l.status != 'dismissed') AS leaks
      FROM aliases a LEFT JOIN sites s ON s.id = a.site_id
      WHERE (lower(a.address) LIKE ? OR lower(IFNULL(s.domain,'')) LIKE ? OR lower(IFNULL(a.label,'')) LIKE ?)
      ORDER BY a.created_at DESC`).all(q, q, q).map(aliasRow);
  });

  r.add('GET', '/api/aliases/:id', (ctx) => {
    const a = db.prepare(`SELECT a.*, s.domain AS site_domain, s.risk_score, s.risk_level, s.id AS sid FROM aliases a
                          LEFT JOIN sites s ON s.id = a.site_id WHERE a.id = ?`).get(ctx.params.id);
    if (!a) throw bad('Alias not found', 404);
    return {
      ...aliasRow(a),
      messages: db.prepare(`SELECT id, from_addr, from_name, from_domain, subject, received_at, classification, reason, in_spam, quarantined, auth_json
                            FROM messages WHERE alias_id = ? ORDER BY received_at DESC LIMIT 200`).all(a.id)
        .map(m => ({ ...m, auth: J(m.auth_json, null), auth_json: undefined })),
      senders: db.prepare(`SELECT from_domain, COUNT(*) AS n, MAX(classification = 'leak') AS leak, MIN(received_at) AS first_seen
                           FROM messages WHERE alias_id = ? GROUP BY from_domain ORDER BY n DESC`).all(a.id),
      leaks: db.prepare('SELECT * FROM leaks WHERE alias_id = ? ORDER BY detected_at DESC').all(a.id)
    };
  });

  r.add('PATCH', '/api/aliases/:id', async (ctx) => {
    const b = await readJson(ctx.req);
    const a = db.prepare('SELECT * FROM aliases WHERE id = ?').get(ctx.params.id);
    if (!a) throw bad('Alias not found', 404);
    if (b.status && ['active', 'blocked'].includes(b.status)) {
      db.prepare('UPDATE aliases SET status = ?, expires_at = CASE WHEN ? = \'active\' AND tier = 0 THEN NULL ELSE expires_at END WHERE id = ?')
        .run(b.status, b.status, a.id);
      audit(`alias.${b.status === 'blocked' ? 'blocked' : 'reactivated'}`, a.address);
    }
    if (typeof b.label === 'string') db.prepare('UPDATE aliases SET label = ? WHERE id = ?').run(b.label.slice(0, 80), a.id);
    if (typeof b.note === 'string') db.prepare('UPDATE aliases SET note = ? WHERE id = ?').run(b.note.slice(0, 1000), a.id);
    const blocked = new Set(J(a.blocked_senders, []));
    if (b.blockSender) blocked.add(registrable(b.blockSender));
    if (b.unblockSender) blocked.delete(registrable(b.unblockSender));
    if (b.blockSender || b.unblockSender) {
      db.prepare('UPDATE aliases SET blocked_senders = ? WHERE id = ?').run(JSON.stringify([...blocked]), a.id);
      audit('alias.sender_rule', `${a.address}: ${b.blockSender ? 'block ' + b.blockSender : 'unblock ' + b.unblockSender}`);
    }
    return aliasRow(db.prepare('SELECT * FROM aliases WHERE id = ?').get(a.id));
  });

  // ---------- leaks ----------
  r.add('GET', '/api/leaks', () => db.prepare(`
    SELECT l.*, a.address, a.tier, a.created_at AS alias_created, s.domain AS site_domain, s.risk_score
    FROM leaks l JOIN aliases a ON a.id = l.alias_id LEFT JOIN sites s ON s.id = l.site_id
    ORDER BY CASE l.status WHEN 'open' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END, l.detected_at DESC`).all()
    .map(l => ({ ...l, evidence: J(l.evidence_json, {}), evidence_json: undefined })));

  r.add('PATCH', '/api/leaks/:id', async (ctx) => {
    const b = await readJson(ctx.req);
    const l = db.prepare('SELECT * FROM leaks WHERE id = ?').get(ctx.params.id);
    if (!l) throw bad('Leak not found', 404);
    if (b.status === 'confirmed') {
      db.prepare("UPDATE leaks SET status = 'confirmed' WHERE id = ?").run(l.id);
      audit('leak.confirmed', l.sender_domain);
    }
    if (b.status === 'dismissed') {
      db.prepare("UPDATE leaks SET status = 'dismissed' WHERE id = ?").run(l.id);
      if (b.trustSender && l.site_id) {
        const s = db.prepare('SELECT trusted_domains FROM sites WHERE id = ?').get(l.site_id);
        const t = new Set(J(s.trusted_domains, [])); t.add(l.sender_domain);
        db.prepare('UPDATE sites SET trusted_domains = ? WHERE id = ?').run(JSON.stringify([...t]), l.site_id);
        db.prepare("UPDATE messages SET classification = 'legit', reason = ? WHERE alias_id = ? AND from_domain = ?")
          .run(`${l.sender_domain} marked as part of the same organisation`, l.alias_id, l.sender_domain);
      }
      audit('leak.dismissed', `${l.sender_domain}${b.trustSender ? ' (trusted)' : ''}`);
    }
    return db.prepare('SELECT * FROM leaks WHERE id = ?').get(l.id);
  });

  r.add('GET', '/api/leaks/:id/evidence', (ctx) => {
    const b = leakBundle(ctx.params.id);
    audit('report.exported', `leak evidence JSON ${b.reportId}`);
    return {
      report: 'TraceMask leak attribution evidence', reportId: b.reportId, generatedAt: now(),
      finding: `${b.l.address} was created only for ${b.l.site_domain} on ${b.l.alias_created} and was later emailed by ${b.l.sender_domain}.`,
      evidenceDigest: `sha256:${b.digest}`, digestCovers: 'SHA-256 of the JSON value of "evidence" below (JSON.stringify, key order as shown)',
      evidence: b.core,
      rawHeaders: b.messages.map(m => ({ messageId: m.message_id, headerSha256: m.header_sha256, headers: m.raw_headers }))
    };
  });

  // ---------- PDF reports ----------
  const sendPdf = (ctx, r, label) => {
    audit('report.exported', `${label}${r.reportId ? ' ' + r.reportId : ''}`);
    ctx.res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': r.buffer.length, 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${r.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"` });
    ctx.res.end(r.buffer);
    return ctx.STREAMING;
  };
  r.add('GET', '/api/reports/leak/:id', (ctx) => sendPdf(ctx, leakReportPdf(ctx.params.id), 'leak evidence PDF'));
  r.add('GET', '/api/reports/site/:id', (ctx) => sendPdf(ctx, siteReportPdf(ctx.params.id), 'site risk PDF'));
  r.add('GET', '/api/reports/posture', (ctx) => sendPdf(ctx, postureReportPdf(), 'privacy posture PDF'));
  r.add('GET', '/api/reports/request/:id', (ctx) => sendPdf(ctx, requestLetterPdf(ctx.params.id), 'erasure letter PDF'));

  // ---------- exposure map (who holds the real address) ----------
  r.add('GET', '/api/exposure', () => {
    const rows = db.prepare(`
      SELECT from_domain AS domain, COUNT(*) AS messages, SUM(in_spam) AS spam, MIN(received_at) AS first_seen, MAX(received_at) AS last_seen,
        MAX(has_unsubscribe) AS marketing,
        (SELECT from_name FROM messages m2 WHERE m2.from_domain = m.from_domain AND m2.classification = 'real' AND IFNULL(m2.from_name,'') != ''
           GROUP BY from_name ORDER BY COUNT(*) DESC LIMIT 1) AS name
      FROM messages m WHERE classification = 'real' AND from_domain IS NOT NULL AND from_domain != ''
      GROUP BY from_domain ORDER BY messages DESC`).all();
    const aliased = new Set(db.prepare("SELECT s.domain FROM sites s JOIN aliases a ON a.site_id = s.id WHERE a.tier < 3").all().map(x => x.domain));
    const requested = new Set(db.prepare('SELECT org_domain FROM erasure_requests').all().map(x => x.org_domain));
    const orgs = [], people = [];
    for (const r0 of rows) {
      const item = { ...r0, protected: aliased.has(r0.domain), erasureRequested: requested.has(r0.domain) };
      (PERSONAL_PROVIDERS.has(r0.domain) ? people : orgs).push(item);
    }
    const mb = getMailbox();
    return {
      address: mb?.base_address, lookbackDays: getSettings().lookbackDays,
      organisations: orgs, individualSenders: people.reduce((s, p) => s + p.messages, 0),
      totals: { organisations: orgs.length, marketing: orgs.filter(o => o.marketing).length, spamSenders: orgs.filter(o => o.spam > 0).length }
    };
  });

  // ---------- erasure requests ----------
  r.add('POST', '/api/requests/draft', async (ctx) => {
    const b = await readJson(ctx.req);
    let leak = null, alias = null, site = null;
    if (b.leakId) {
      leak = db.prepare('SELECT * FROM leaks WHERE id = ?').get(b.leakId);
      alias = leak && db.prepare('SELECT * FROM aliases WHERE id = ?').get(leak.alias_id);
      site = leak && db.prepare('SELECT * FROM sites WHERE id = ?').get(leak.site_id);
    } else if (b.aliasId) {
      alias = db.prepare('SELECT * FROM aliases WHERE id = ?').get(b.aliasId);
      site = alias && db.prepare('SELECT * FROM sites WHERE id = ?').get(alias.site_id);
    } else if (b.domain) {
      site = db.prepare('SELECT * FROM sites WHERE domain = ?').get(registrable(b.domain));
    }
    const orgDomain = site?.domain || registrable(b.domain || '');
    if (!orgDomain) throw bad('Choose an organisation');
    const mb = getMailbox();
    const address = alias && alias.tier < 3 ? alias.address : mb?.base_address;
    if (!address) throw bad('Connect your mailbox first');
    const law = LAWS[b.law] ? b.law : 'dpdp';
    const d = draftErasure({ law, orgDomain, orgName: site?.title?.split(/[|\-–:]/)[0]?.trim(), address, aliasCreated: alias?.created_at, leak, userName: b.userName });
    let recipients = J(site?.contact_emails, []);
    if (!recipients.length && site?.domain) {
      // No contact published in the policy: fall back to the RFC 2142 role address for privacy/support.
      recipients = [];
    }
    return { orgDomain, siteId: site?.id || null, aliasId: alias?.id || null, leakId: leak?.id || null, law, recipients, address, ...d };
  });

  r.add('POST', '/api/requests', async (ctx) => {
    const b = await readJson(ctx.req);
    if (!b.orgDomain || !b.subject || !b.body) throw bad('Missing request details');
    const law = LAWS[b.law] ? b.law : 'dpdp';
    const id = db.prepare(`INSERT INTO erasure_requests (site_id, org_domain, alias_id, leak_id, law, recipient, subject, body, status, created_at)
      VALUES (?,?,?,?,?,?,?,?, 'draft', ?)`).run(b.siteId || null, registrable(b.orgDomain), b.aliasId || null, b.leakId || null, law,
      b.recipient || null, String(b.subject).slice(0, 300), String(b.body).slice(0, 20000), now()).lastInsertRowid;
    audit('erasure.drafted', b.orgDomain);
    return db.prepare('SELECT * FROM erasure_requests WHERE id = ?').get(id);
  });

  r.add('GET', '/api/requests', () => db.prepare('SELECT * FROM erasure_requests ORDER BY created_at DESC').all());

  r.add('PATCH', '/api/requests/:id', async (ctx) => {
    const b = await readJson(ctx.req);
    const q = db.prepare('SELECT * FROM erasure_requests WHERE id = ?').get(ctx.params.id);
    if (!q) throw bad('Request not found', 404);
    const status = ['draft', 'sent', 'responded', 'closed'].includes(b.status) ? b.status : q.status;
    const sentAt = status === 'sent' && !q.sent_at ? now() : q.sent_at;
    const follow = status === 'sent' && !q.follow_up_at ? new Date(Date.now() + (LAWS[q.law]?.followUpDays || 30) * 86400000).toISOString() : q.follow_up_at;
    db.prepare('UPDATE erasure_requests SET status=?, sent_at=?, follow_up_at=?, recipient=?, notes=?, subject=?, body=? WHERE id=?')
      .run(status, sentAt, follow, b.recipient ?? q.recipient, b.notes ?? q.notes, b.subject ?? q.subject, b.body ?? q.body, q.id);
    if (status !== q.status) audit('erasure.' + status, q.org_domain);
    return db.prepare('SELECT * FROM erasure_requests WHERE id = ?').get(q.id);
  });

  r.add('DELETE', '/api/requests/:id', (ctx) => {
    db.prepare("DELETE FROM erasure_requests WHERE id = ? AND status = 'draft'").run(ctx.params.id);
    return { ok: true };
  });

  // ---------- dashboard ----------
  r.add('GET', '/api/dashboard', () => {
    expireBurners();
    const one = (sql, ...p) => Object.values(db.prepare(sql).get(...p) || { v: 0 })[0] || 0;
    const mb = getMailbox();
    const orgs = db.prepare("SELECT DISTINCT from_domain FROM messages WHERE classification = 'real' AND from_domain IS NOT NULL").all()
      .map(r0 => r0.from_domain).filter(d => !PERSONAL_PROVIDERS.has(d));
    return {
      mailbox: mb ? { address: mb.base_address, host: mb.host, lastSyncAt: mb.last_sync_at, lastSyncStatus: mb.last_sync_status, lastSyncError: mb.last_sync_error, aliasMode: mb.alias_mode } : null,
      syncing: isSyncing(),
      kpis: {
        activeAliases: one("SELECT COUNT(*) FROM aliases WHERE status = 'active'"),
        totalAliases: one('SELECT COUNT(*) FROM aliases WHERE tier < 3'),
        openLeaks: one("SELECT COUNT(*) FROM leaks WHERE status = 'open'"),
        leakingCompanies: one("SELECT COUNT(DISTINCT site_id) FROM leaks WHERE status != 'dismissed'"),
        exposedOrgs: orgs.length,
        quarantined: one('SELECT COUNT(*) FROM messages WHERE quarantined = 1'),
        aliasMail: one('SELECT COUNT(*) FROM messages WHERE alias_id IS NOT NULL'),
        legitMail: one("SELECT COUNT(*) FROM messages WHERE classification = 'legit'"),
        sitesScanned: one('SELECT COUNT(*) FROM sites'),
        avgRisk: Math.round(one('SELECT AVG(risk_score) FROM sites') || 0),
        openRequests: one("SELECT COUNT(*) FROM erasure_requests WHERE status IN ('draft','sent')")
      },
      recentLeaks: db.prepare(`SELECT l.id, l.sender_domain, l.severity, l.status, l.first_seen, l.message_count, a.address, s.domain AS site_domain
                               FROM leaks l JOIN aliases a ON a.id = l.alias_id LEFT JOIN sites s ON s.id = l.site_id
                               ORDER BY l.detected_at DESC LIMIT 5`).all(),
      activity: db.prepare(`SELECT m.id, m.from_domain, m.from_name, m.subject, m.received_at, m.classification, m.quarantined, a.address, s.domain AS site_domain
                            FROM messages m JOIN aliases a ON a.id = m.alias_id LEFT JOIN sites s ON s.id = a.site_id
                            ORDER BY m.received_at DESC LIMIT 8`).all(),
      tiers: db.prepare("SELECT tier, COUNT(*) AS n FROM aliases GROUP BY tier").all(),
      lastRun: db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() || null
    };
  });

  // ---------- settings / audit / export ----------
  r.add('GET', '/api/settings', () => getSettings());
  r.add('PATCH', '/api/settings', async (ctx) => {
    const b = await readJson(ctx.req);
    const patch = {};
    if (b.syncIntervalMin != null) patch.syncIntervalMin = Math.min(60, Math.max(1, Number(b.syncIntervalMin) || 2));
    if (b.lookbackDays != null) patch.lookbackDays = Math.min(365, Math.max(7, Number(b.lookbackDays) || 60));
    if (b.burnerHours != null) patch.burnerHours = Math.min(24 * 30, Math.max(1, Number(b.burnerHours) || 24));
    if (b.quarantineEnabled != null) patch.quarantineEnabled = !!b.quarantineEnabled;
    if (b.idleEnabled != null) patch.idleEnabled = !!b.idleEnabled;
    if (b.aliasStyle) patch.aliasStyle = b.aliasStyle === 'opaque' ? 'opaque' : 'named';
    const s = saveSettings(patch);
    audit('settings.updated', Object.keys(patch).join(', '));
    if (getMailbox() && vault.isUnlocked()) startBackground();
    return s;
  });
  r.add('GET', '/api/audit', () => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
  r.add('GET', '/api/export', (ctx) => {
    const data = {
      exportedAt: now(), app: 'TraceMask',
      sites: db.prepare('SELECT id, domain, url, title, risk_score, risk_level, scanned_at FROM sites').all(),
      aliases: db.prepare('SELECT * FROM aliases').all(),
      leaks: db.prepare('SELECT * FROM leaks').all(),
      erasureRequests: db.prepare('SELECT * FROM erasure_requests').all()
    };
    ctx.res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="tracemask-export.json"', 'cache-control': 'no-store' });
    ctx.res.end(JSON.stringify(data, null, 2));
    return ctx.STREAMING;
  });
}
