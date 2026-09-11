// Mailbox sync: reads real message headers over IMAP, attributes alias mail to sites,
// detects leaks, quarantines mail for blocked/expired aliases and blocked leak senders,
// and builds the "who holds my real address" exposure map. Bodies are never downloaded.
import { db, now, getSettings, audit, tx } from '../db.js';
import { ImapClient } from './imap.js';
import { parseHeaders, parseAddressList, parseAuthResults, parseDate, decodeWords, first } from './mail-headers.js';
import { registrable } from './psl.js';
import { classifyAliasMessage } from './leak-engine.js';
import { decryptSecret, isUnlocked } from '../vault.js';
import crypto from 'node:crypto';

const FIELDS = ['FROM', 'TO', 'CC', 'DELIVERED-TO', 'X-ORIGINAL-TO', 'SUBJECT', 'DATE', 'MESSAGE-ID',
  'AUTHENTICATION-RESULTS', 'DKIM-SIGNATURE', 'LIST-UNSUBSCRIBE', 'RETURN-PATH'];
const BATCH = 150;

let running = null;
let idleClient = null;
let timer = null;
const listeners = new Set();
export const onSyncEvent = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (e) => { for (const fn of listeners) try { fn(e); } catch {} };

export function getMailbox() { return db.prepare('SELECT * FROM mailbox WHERE id = 1').get() || null; }
export function imapConfig(mb) {
  return { host: mb.host, port: mb.port, user: mb.username, pass: decryptSecret(mb.enc_password) };
}

function imapDate(d) {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()}-${m[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

export function expireBurners() {
  const r = db.prepare("UPDATE aliases SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?").run(now());
  if (r.changes) audit('alias.expired', `${r.changes} burner alias(es) expired`);
}

function loadAliasIndex() {
  const rows = db.prepare(`SELECT a.*, s.domain AS site_domain, s.trusted_domains AS site_trusted
                           FROM aliases a LEFT JOIN sites s ON s.id = a.site_id`).all();
  const map = new Map();
  for (const r of rows) map.set(r.address.toLowerCase(), r);
  return map;
}

async function syncFolder(client, folder, isSpam, ctx) {
  const info = await client.select(folder);
  const state = db.prepare('SELECT * FROM folder_state WHERE folder = ?').get(folder);
  let uids;
  if (!state || state.uidvalidity !== info.uidvalidity) {
    const since = new Date(Date.now() - ctx.settings.lookbackDays * 86400000);
    uids = await client.uidSearch(`SINCE ${imapDate(since)}`);
  } else {
    uids = (await client.uidSearch(`UID ${state.last_uid + 1}:*`)).filter(u => u > state.last_uid);
  }
  let maxUid = state && state.uidvalidity === info.uidvalidity ? state.last_uid : 0;
  const toQuarantine = [];
  const insertMsg = db.prepare(`INSERT OR IGNORE INTO messages
    (folder, uidvalidity, uid, message_id, alias_id, to_addr, from_addr, from_name, from_domain, subject, received_at,
     auth_json, classification, reason, has_unsubscribe, in_spam, quarantined, raw_headers, header_sha256)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  for (let i = 0; i < uids.length; i += BATCH) {
    const chunk = uids.slice(i, i + BATCH);
    const fetched = await client.fetchHeaders(chunk, FIELDS);
    tx(() => {
      for (const m of fetched) {
        maxUid = Math.max(maxUid, m.uid);
        ctx.scanned++;
        const h = parseHeaders(m.header);
        const from = parseAddressList(first(h, 'from'))[0] || { address: '', name: '', domain: '' };
        const rcpts = ['to', 'cc', 'delivered-to', 'x-original-to'].flatMap(k => (h[k] || []).flatMap(parseAddressList));
        const alias = rcpts.map(a => ctx.aliases.get(a.address)).find(Boolean);
        const received = parseDate(first(h, 'date')) || parseDate(m.internalDate) || now();
        const auth = parseAuthResults(h['authentication-results'], h['dkim-signature'] || []);
        const fromDomain = registrable(from.domain);
        const unsub = h['list-unsubscribe'] ? 1 : 0;

        if (!alias) {
          // Mail to the real address: record sender organisation only (no subject) for the exposure map.
          if (!fromDomain || fromDomain === ctx.selfDomainReg && from.address === ctx.selfAddress) continue;
          insertMsg.run(folder, info.uidvalidity, m.uid, first(h, 'message-id') || null, null,
            (rcpts[0]?.address) || null, from.address, decodeWords(from.name).slice(0, 120), fromDomain, null, received,
            null, 'real', null, unsub, isSpam ? 1 : 0, 0, null, null);
          continue;
        }

        ctx.aliasMessages++;
        const trusted = JSON.parse(alias.site_trusted || '[]');
        const verdict = classifyAliasMessage({ fromDomain, auth, siteDomain: alias.site_domain, trusted });
        const blockedSenders = JSON.parse(alias.blocked_senders || '[]');
        let quarantine = false;
        let reason = verdict.reason;
        if (alias.status === 'blocked' || alias.status === 'expired') { quarantine = true; reason = `Alias is ${alias.status}; ${reason}`; }
        else if (blockedSenders.includes(fromDomain)) { quarantine = true; reason = `Sender ${fromDomain} is blocked for this alias`; }
        else if (verdict.classification === 'leak' && alias.tier <= 1) { quarantine = true; }
        const willMove = quarantine && ctx.settings.quarantineEnabled && !ctx.skipMove;

        const subject = decodeWords(first(h, 'subject')).slice(0, 300);
        // Evidence preservation: keep the exact header bytes (as fetched over IMAP) for leak/lookalike mail only.
        const isEvidence = verdict.classification === 'leak' || verdict.classification === 'review';
        const rawHeaders = isEvidence ? m.header.toString('latin1').slice(0, 32768) : null;
        const headerHash = isEvidence ? crypto.createHash('sha256').update(m.header).digest('hex') : null;
        const r = insertMsg.run(folder, info.uidvalidity, m.uid, first(h, 'message-id') || null, alias.id,
          rcpts.find(a => ctx.aliases.get(a.address))?.address, from.address, decodeWords(from.name).slice(0, 120), fromDomain,
          subject, received, JSON.stringify(auth), verdict.classification, reason, unsub, isSpam ? 1 : 0, willMove ? 1 : 0, rawHeaders, headerHash);
        if (willMove && r.changes) toQuarantine.push(m.uid);

        if ((verdict.classification === 'leak' || verdict.classification === 'review') && r.changes) {
          const evidence = {
            alias: alias.address, aliasCreated: alias.created_at, site: alias.site_domain,
            sender: from.address, senderName: decodeWords(from.name), senderDomain: fromDomain,
            subject, received, messageId: first(h, 'message-id'), folder,
            authentication: { spf: auth.spf, spfDomain: auth.spfDomain, dkim: auth.dkim, dmarc: auth.dmarc, verifiedBy: auth.authserv },
            returnPath: first(h, 'return-path'),
            imapUid: m.uid, imapInternalDate: m.internalDate || null, fetchedAt: now(), mailServer: ctx.imapHost,
            headerSha256: headerHash
          };
          const existing = db.prepare('SELECT * FROM leaks WHERE alias_id = ? AND sender_domain = ?').get(alias.id, fromDomain);
          if (existing) {
            db.prepare('UPDATE leaks SET message_count = message_count + 1, last_seen = MAX(last_seen, ?), first_seen = MIN(first_seen, ?) WHERE id = ?')
              .run(received, received, existing.id);
          } else {
            db.prepare(`INSERT INTO leaks (alias_id, site_id, sender_domain, severity, status, first_seen, last_seen, message_count, evidence_json, detected_at)
                        VALUES (?,?,?,?, 'open', ?, ?, 1, ?, ?)`)
              .run(alias.id, alias.site_id, fromDomain, verdict.severity, received, received, JSON.stringify(evidence), now());
            ctx.newLeaks.push({ alias: alias.address, site: alias.site_domain, sender: fromDomain, severity: verdict.severity });
            audit(verdict.classification === 'review' ? 'leak.review' : 'leak.detected', `${alias.site_domain} → ${fromDomain} via ${alias.address}`);
          }
        }
      }
    });
  }

  if (toQuarantine.length) {
    try {
      await client.ensureFolder(ctx.settings.quarantineFolder);
      await client.moveUids(toQuarantine, ctx.settings.quarantineFolder);
      ctx.quarantined += toQuarantine.length;
      audit('mail.quarantined', `${toQuarantine.length} message(s) moved from ${folder} to ${ctx.settings.quarantineFolder}`);
    } catch (e) {
      db.prepare(`UPDATE messages SET quarantined = 0 WHERE folder = ? AND uidvalidity = ? AND uid IN (${toQuarantine.map(() => '?').join(',')})`)
        .run(folder, info.uidvalidity, ...toQuarantine);
      ctx.warnings.push(`Could not quarantine in ${folder}: ${e.message}`);
    }
  }
  db.prepare(`INSERT INTO folder_state(folder, uidvalidity, last_uid) VALUES(?,?,?)
              ON CONFLICT(folder) DO UPDATE SET uidvalidity = excluded.uidvalidity, last_uid = excluded.last_uid`)
    .run(folder, info.uidvalidity, maxUid);
}

export async function findFolders(client) {
  const folders = await client.list();
  const inbox = folders.find(f => f.name.toUpperCase() === 'INBOX')?.name || 'INBOX';
  const junk = folders.find(f => f.flags.includes('\\junk'))?.name
    || folders.find(f => /(^|\/|\.)(spam|junk|bulk)( mail| e-?mail)?$/i.test(f.name))?.name || null;
  return { inbox, junk, all: folders };
}

export async function runSync(trigger = 'manual') {
  if (running) return running;
  running = (async () => {
    const mb = getMailbox();
    if (!mb) throw Object.assign(new Error('Connect a mailbox first'), { status: 400 });
    if (!isUnlocked()) throw Object.assign(new Error('Vault locked'), { status: 423 });
    expireBurners();
    const settings = getSettings();
    const runId = db.prepare("INSERT INTO sync_runs(started_at, trigger, status) VALUES(?, ?, 'running')").run(now(), trigger).lastInsertRowid;
    emit({ type: 'sync.started', trigger });
    const ctx = {
      settings, aliases: loadAliasIndex(), scanned: 0, aliasMessages: 0, newLeaks: [], quarantined: 0, warnings: [],
      selfAddress: mb.base_address.toLowerCase(), selfDomainReg: registrable(mb.base_address.split('@')[1]), imapHost: mb.host
    };
    const client = new ImapClient(imapConfig(mb));
    try {
      await client.connect();
      await client.login();
      const { inbox, junk } = await findFolders(client);
      await syncFolder(client, inbox, false, ctx);
      if (junk) await syncFolder(client, junk, true, ctx);
      const status = ctx.warnings.length ? 'ok_with_warnings' : 'ok';
      db.prepare('UPDATE sync_runs SET finished_at=?, status=?, scanned=?, alias_messages=?, new_leaks=?, quarantined=?, error=? WHERE id=?')
        .run(now(), status, ctx.scanned, ctx.aliasMessages, ctx.newLeaks.length, ctx.quarantined, ctx.warnings.join('; ') || null, runId);
      db.prepare('UPDATE mailbox SET last_sync_at=?, last_sync_status=?, last_sync_error=? WHERE id=1').run(now(), status, ctx.warnings.join('; ') || null);
      const result = { scanned: ctx.scanned, aliasMessages: ctx.aliasMessages, newLeaks: ctx.newLeaks, quarantined: ctx.quarantined, warnings: ctx.warnings, folders: { inbox, junk } };
      emit({ type: 'sync.finished', ...result });
      return result;
    } catch (e) {
      db.prepare("UPDATE sync_runs SET finished_at=?, status='error', error=? WHERE id=?").run(now(), e.message, runId);
      db.prepare("UPDATE mailbox SET last_sync_at=?, last_sync_status='error', last_sync_error=? WHERE id=1").run(now(), e.message);
      emit({ type: 'sync.error', error: e.message });
      throw e;
    } finally {
      await client.logout();
    }
  })();
  try { return await running; } finally { running = null; }
}

export const isSyncing = () => !!running;

// Background loop: periodic sync plus IMAP IDLE on the inbox for near-instant leak alerts.
export function startBackground() {
  stopBackground();
  const settings = getSettings();
  const tick = () => { if (isUnlocked() && getMailbox()) runSync('scheduled').catch(() => {}); };
  timer = setInterval(tick, Math.max(1, settings.syncIntervalMin) * 60000);
  setTimeout(tick, 1500);
  if (settings.idleEnabled) startIdle().catch(() => {});
}

export function stopBackground() {
  if (timer) clearInterval(timer);
  timer = null;
  if (idleClient) { const c = idleClient; idleClient = null; c.logout().catch(() => {}); }
}

async function startIdle() {
  const mb = getMailbox();
  if (!mb || !isUnlocked()) return;
  const c = new ImapClient(imapConfig(mb));
  idleClient = c;
  let debounce = null;
  const restart = () => { if (idleClient === c) { idleClient = null; setTimeout(() => startIdle().catch(() => {}), 30000); } };
  c.on('close', restart);
  try {
    await c.connect(); await c.login();
    if (!c.capabilities.has('IDLE')) { await c.logout(); idleClient = null; return; }
    const { inbox } = await findFolders(c);
    await c.select(inbox);
    c.on('exists', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => runSync('realtime').catch(() => {}), 1500);
    });
    const loop = async () => {
      while (idleClient === c && !c.closed) {
        await c.startIdle();
        await new Promise(r => setTimeout(r, 25 * 60000));
        if (idleClient !== c) break;
        await c.stopIdle();
      }
    };
    loop().catch(() => {});
    emit({ type: 'idle.started' });
  } catch { c.sock?.destroy(); }
}
