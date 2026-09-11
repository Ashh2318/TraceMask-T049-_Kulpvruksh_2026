// Compliance-grade PDF reports built from real records in the local database.
import crypto from 'node:crypto';
import { db, now, getSettings } from '../db.js';
import { PdfDoc } from './pdf.js';
import { TIERS, PURPOSES } from './aliases.js';
import { LAWS } from './erasure.js';

const J = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const ist = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST' : '—';
const day = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const ymd = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const safeName = (s) => String(s).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report';
const sha = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const nf = (n) => Number(n || 0).toLocaleString('en-IN');
const bad = (m, s = 404) => Object.assign(new Error(m), { status: s });
const CLASS = 'CONFIDENTIAL - contains personal data (DPDP Act 2023)';
const auth = (a) => a ? `SPF ${a.spf || 'none'} / DKIM ${(a.dkim || []).map(d => d.result).join(',') || 'none'} / DMARC ${a.dmarc || 'none'}` : '—';

// Canonical, hashable evidence bundle for a leak (shared by the JSON and PDF exports).
export function leakBundle(id) {
  const l = db.prepare(`SELECT l.*, a.address, a.tier, a.created_at AS alias_created, a.purpose, s.domain AS site_domain, s.title AS site_title
                        FROM leaks l JOIN aliases a ON a.id = l.alias_id LEFT JOIN sites s ON s.id = l.site_id WHERE l.id = ?`).get(id);
  if (!l) throw bad('Leak not found');
  const messages = db.prepare(`SELECT from_addr, from_name, from_domain, subject, received_at, folder, auth_json, message_id, header_sha256, raw_headers, classification
                               FROM messages WHERE alias_id = ? AND from_domain = ? ORDER BY received_at`).all(l.alias_id, l.sender_domain);
  const legitFirst = db.prepare(`SELECT MIN(received_at) AS t, COUNT(*) AS n FROM messages WHERE alias_id = ? AND classification = 'legit'`).get(l.alias_id);
  const evidence = J(l.evidence_json, {});
  const core = {
    alias: l.address, issuedTo: l.site_domain, aliasCreatedAt: l.alias_created, leakedTo: l.sender_domain,
    severity: l.severity, firstSeen: l.first_seen, lastSeen: l.last_seen, messageCount: messages.length,
    messages: messages.map(m => ({ receivedAt: m.received_at, from: m.from_addr, messageId: m.message_id, folder: m.folder,
      authentication: J(m.auth_json, null), headerSha256: m.header_sha256 }))
  };
  const digest = sha(core);
  const reportId = `TM-LEAK-${ymd()}-${String(l.id).padStart(4, '0')}-${digest.slice(0, 8).toUpperCase()}`;
  return { l, messages, legitFirst, evidence, core, digest, reportId };
}

export function leakReportPdf(id) {
  const { l, messages, legitFirst, evidence, core, digest, reportId } = leakBundle(id);
  const mb = db.prepare('SELECT host FROM mailbox WHERE id = 1').get();
  const doc = new PdfDoc({ title: 'Personal Data Leak - Evidence Report', subject: `${l.site_domain} -> ${l.sender_domain}`, reportId, classification: CLASS, accent: '#d92d4b' });
  doc.cover({
    kicker: 'TRACEMASK  |  LEAK ATTRIBUTION EVIDENCE',
    title: `Evidence that ${l.site_domain} disclosed an identity to ${l.sender_domain}`,
    subtitle: 'Prepared from message headers retrieved over TLS from the data principal\'s own mailbox. Intended to support a grievance to the Data Fiduciary and, if unresolved, a complaint to the Data Protection Board of India.',
    meta: [
      ['Report ID', reportId],
      ['Generated', `${ist(now())}  (${now()} UTC)`],
      ['Data Fiduciary', `${l.site_domain}${l.site_title ? ' - ' + l.site_title.slice(0, 60) : ''}`],
      ['Unauthorised recipient', l.sender_domain],
      ['Identity (alias)', l.address],
      ['Finding', l.severity === 'review' ? 'Lookalike domain - needs confirmation' : `Leak - ${l.severity} confidence`],
      ['Evidence digest', `SHA-256 ${digest}`]
    ]
  });

  doc.h1('1. Summary of finding');
  doc.callout(l.severity === 'review' ? 'Lookalike sender - confirmation required' : 'Onward disclosure detected',
    `The email address ${l.address} was generated on ${ist(l.alias_created)} exclusively for ${l.site_domain} and was not given to any other party. ` +
    `On ${ist(l.first_seen)} it received email from ${l.sender_domain}` + (messages.length > 1 ? `, and ${messages.length} messages in total up to ${ist(l.last_seen)}` : '') + '. ' +
    (l.severity === 'high' ? `The messages passed sender authentication (DKIM/DMARC) for ${l.sender_domain}, so they genuinely originate from that organisation; the address could only have reached it through ${l.site_domain} (sharing, sale or a security breach).`
      : l.severity === 'review' ? `${l.sender_domain} uses the same brand name as ${l.site_domain} but is a different domain. It is either the same company or a lookalike domain that obtained the address.`
        : `The messages were not authenticated, which is typical of spam lists compiled from breached or traded data. The address could only have been obtained from ${l.site_domain}.`),
    l.severity === 'high' ? { fill: '#fdebee', stroke: '#f6c9d2', titleColor: '#b91c1c' } : { fill: '#fff5e0', stroke: '#f7dea6', titleColor: '#92400e' });

  doc.h1('2. Parties and identifiers');
  doc.kv([
    ['Data Principal', `Holder of ${l.address} (real identity withheld in this report - data minimisation)`],
    ['Data Fiduciary', l.site_domain],
    ['Purpose of disclosure', PURPOSES[l.purpose] || l.purpose],
    ['Trust tier at sign-up', `${TIERS[l.tier]?.short} ${TIERS[l.tier]?.name}`],
    ['Recipient of disclosed data', l.sender_domain],
    ['Mail provider (verifier)', evidence.authentication?.verifiedBy || mb?.host || '—']
  ]);

  doc.h1('3. Timeline');
  doc.table([{ title: 'When (IST)', w: 1.2 }, { title: 'Event', w: 2.6 }], [
    [ist(l.alias_created), `Unique alias created in TraceMask and used only on ${l.site_domain}`],
    ...(legitFirst?.t ? [[ist(legitFirst.t), `First legitimate email from ${l.site_domain} (${legitFirst.n} legitimate message(s) in total) - confirms the alias was delivered to the Data Fiduciary`]] : []),
    [ist(l.first_seen), `First email from ${l.sender_domain} to the alias`],
    ...(messages.length > 1 ? [[ist(l.last_seen), `Most recent email from ${l.sender_domain} (${messages.length} in total)`]] : []),
    [ist(l.detected_at), 'Leak attributed automatically by TraceMask'],
    [ist(now()), 'This report generated']
  ]);

  doc.h1('4. Messages received from the unauthorised recipient');
  doc.table([{ title: 'Received (IST)', w: 1.15 }, { title: 'From', w: 1.6 }, { title: 'Subject', w: 1.6 }, { title: 'Authentication', w: 1.3 }, { title: 'Folder', w: 0.7 }],
    messages.map(m => [ist(m.received_at), m.from_addr, m.subject || '(no subject)', auth(J(m.auth_json, null)), m.folder]), { size: 8 });

  doc.h1('5. Technical evidence');
  doc.p('Authentication results are those recorded by the data principal\'s own mail provider when the message was received (Authentication-Results header, RFC 8601). They cannot be altered by the sender after delivery.');
  const first = messages[0];
  if (first) {
    doc.kv([
      ['Message-ID', first.message_id || '—'],
      ['Header SHA-256', first.header_sha256 || 'not recorded (mail synced by an earlier version)'],
      ['Return-Path', evidence.returnPath || '—'],
      ['IMAP UID / folder', `${evidence.imapUid ?? '—'} / ${first.folder}`],
      ['Retrieved', evidence.fetchedAt ? `${ist(evidence.fetchedAt)} over TLS from ${evidence.mailServer || mb?.host}` : '—']
    ], { labelW: 120 });
    if (first.raw_headers) { doc.h2('Header block as retrieved (first message)'); doc.code(first.raw_headers.replace(/\r/g, '').trim()); }
  }

  doc.h1('6. Method of attribution');
  doc.bullets([
    'TraceMask generates a unique, deliverable email address for every sign-up and records the one organisation it was issued to.',
    'The address contains a random component (5 characters from a 31-symbol alphabet, about 28.6 million combinations per site label), so it cannot plausibly be guessed.',
    'Only message headers are read (From, To, Date, Subject, Message-ID, Authentication-Results, DKIM-Signature, Return-Path). Message bodies are never downloaded.',
    `A message is attributed as a leak when its sender's registrable domain differs from ${l.site_domain} and from any domain the data principal has confirmed as belonging to it.`,
    'Limitation: attribution shows that the address left the Data Fiduciary; it cannot by itself distinguish sale, sharing with a partner, or a security breach.'
  ]);

  doc.h1('7. Relevant legal provisions (informational)');
  doc.bullets([
    'DPDP Act 2023, s.8(5): a Data Fiduciary must protect personal data in its possession by taking reasonable security safeguards to prevent a personal data breach.',
    'DPDP Act 2023, s.8(6): in the event of a personal data breach, the Data Fiduciary must intimate the Data Protection Board and each affected Data Principal.',
    'DPDP Act 2023, s.11(1)(b): the Data Principal may obtain the identities of all other Data Fiduciaries and Data Processors with whom the personal data has been shared.',
    'DPDP Act 2023, s.12 and s.13: right to erasure of personal data and right to grievance redressal; s.13(3) requires the grievance route to be exhausted before approaching the Board.',
    'Under the DPDP Rules 2025 (notified 13 Nov 2025) most of these obligations apply from 13 May 2027; until then this evidence supports a request under the organisation\'s own privacy policy. GDPR Articles 17, 33 and 34 may apply to organisations established in or targeting the EU/UK.'
  ], { size: 9 });

  doc.h1('8. Integrity and chain of custody');
  doc.kv([
    ['Collected by', 'TraceMask local instance (headers fetched via IMAP over TLS 1.2+)'],
    ['Stored', 'Local SQLite database on the data principal\'s own computer; no third-party copy'],
    ['Evidence digest', `SHA-256 ${digest}`],
    ['How to verify', 'Export the JSON evidence for this leak in TraceMask; its "evidenceDigest" must equal the value above. Header hashes can be recomputed from the original messages in the mailbox.']
  ], { labelW: 110 });
  doc.p('Data minimisation: this report contains only the alias, organisation domains, message metadata and header evidence required to substantiate the finding.', { size: 8.5, color: '#6b7280' });
  doc.p('This report is generated automatically and is not legal advice.', { size: 8.5, color: '#6b7280' });
  doc.signature(['Data Principal - signature', 'Date and place']);
  return { filename: `tracemask-leak-evidence-${safeName(l.site_domain)}-${safeName(l.sender_domain)}.pdf`, buffer: doc.toBuffer(), reportId, digest, core };
}

export function siteReportPdf(id) {
  const s = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  if (!s) throw bad('Site not found');
  const scan = J(s.scan_json, null);
  if (!scan) throw bad('This site has no scan data yet', 400);
  const aliases = db.prepare('SELECT address, tier, status, created_at FROM aliases WHERE site_id = ?').all(s.id);
  const reportId = `TM-SITE-${ymd()}-${String(s.id).padStart(4, '0')}-${sha(scan).slice(0, 8).toUpperCase()}`;
  const doc = new PdfDoc({ title: 'Sign-up Risk Assessment', subject: s.domain, reportId, classification: 'INTERNAL - privacy risk assessment' });
  doc.cover({
    kicker: 'TRACEMASK  |  PRE-DISCLOSURE RISK ASSESSMENT',
    title: `Risk assessment: ${s.domain}`,
    subtitle: 'Measured live from public sources before personal data is shared: TLS certificate, DNS and email authentication, domain registration (RDAP), breach history (Have I Been Pwned), homepage trackers, security headers and the published privacy policy.',
    meta: [['Report ID', reportId], ['Target', scan.target?.url || s.url], ['Scanned', `${ist(scan.startedAt)} (${(scan.durationMs / 1000).toFixed(1)} s)`],
      ['Risk score', `${scan.risk.score}/100 - ${scan.risk.level}`], ['Signal coverage', `${scan.risk.coverage ?? 100}% verified live`]]
  });
  doc.h1('1. Result');
  doc.meter('Overall sign-up risk', scan.risk.score, scan.risk.level);
  if (scan.risk.unverified) doc.callout('Limited verification', `${scan.risk.unverified} signal(s) could not be verified because the site or source refused the automated check. Unverified signals add risk points instead of being assumed safe.`, { fill: '#fff5e0', stroke: '#f7dea6', titleColor: '#92400e' });
  doc.table([{ title: 'Signal', w: 1.2 }, { title: 'Status', w: 0.6 }, { title: 'Finding', w: 3 }, { title: 'Points', w: 0.5 }],
    scan.risk.factors.map(f => [f.label, f.status, f.detail, f.points ? `+${f.points}` : '0']));
  doc.h1('2. Evidence collected');
  doc.kv([
    ['TLS certificate', scan.tls?.ok ? `Valid - ${scan.tls.protocol}, issuer ${scan.tls.issuer}, expires ${day(scan.tls.validTo)}` : (scan.tls?.error || '—')],
    ['DNS', scan.dns ? `${scan.dns.addresses.join(', ') || 'no A/AAAA'}; MX ${scan.dns.mx.join(', ') || 'none'}` : '—'],
    ['DMARC', scan.dns?.dmarc ? `p=${scan.dns.dmarc.policy} (${scan.dns.dmarc.record.slice(0, 90)})` : 'No DMARC record'],
    ['Registration (RDAP)', scan.rdap?.ok ? `${day(scan.rdap.registeredAt)} via ${scan.rdap.registrar || 'unknown registrar'}; source ${scan.rdap.source}` : (scan.rdap?.error || '—')],
    ['Homepage', scan.page?.ok ? `HTTP ${scan.page.status} ${scan.page.finalUrl}` : (scan.page?.error || '—')],
    ['Security headers', scan.page?.ok ? Object.keys(scan.page.headers).filter(k => k !== 'server').join(', ') || 'none' : '—'],
    ['Privacy policy', scan.privacy?.found ? `${scan.privacy.url} (${nf(scan.privacy.words)} words)` : 'Not found']
  ], { labelW: 125 });
  const br = scan.breaches?.breaches || [];
  doc.h2(`Breach history (${br.length})`);
  if (br.length) doc.table([{ title: 'Breach', w: 1.2 }, { title: 'Date', w: 0.7 }, { title: 'Accounts', w: 0.8 }, { title: 'Data exposed', w: 2.4 }], br.map(b => [b.name, b.date, nf(b.pwnCount), b.dataClasses.join(', ')]));
  else doc.p(scan.breaches?.ok ? 'No breaches listed for this domain in Have I Been Pwned.' : `Breach catalogue unavailable: ${scan.breaches?.error}`);
  const tr = scan.page?.ok ? scan.page.analysis.trackers : [];
  doc.h2(`Third-party trackers on the homepage (${tr.length})`);
  if (tr.length) doc.table([{ title: 'Company / tag', w: 2 }, { title: 'Category', w: 1.2 }, { title: 'Host', w: 2 }], tr.map(t => [t.company, t.category, t.host || 'inline script']));
  else doc.p(scan.page?.ok ? 'No known trackers found.' : 'Homepage could not be analysed.');
  if (scan.privacy?.found) {
    doc.h2('Privacy policy findings');
    doc.bullets([
      scan.privacy.deletionRights ? 'Describes a deletion / erasure process.' : 'No deletion or erasure process described.',
      scan.privacy.grievanceContact ? 'Names a grievance or data-protection contact.' : 'No grievance officer or data-protection contact named.',
      scan.privacy.sharingOrSale ? 'Contains language about selling or sharing personal data with partners.' : 'No selling / partner-sharing language found.',
      `Legal references: ${[scan.privacy.mentionsDpdp && 'DPDP Act', scan.privacy.mentionsGdpr && 'GDPR'].filter(Boolean).join(', ') || 'none'}.`,
      `Published contacts: ${scan.privacy.emails?.join(', ') || 'none'}.`
    ]);
  }
  doc.h1('3. Identities disclosed to this site');
  if (aliases.length) doc.table([{ title: 'Identity', w: 2.6 }, { title: 'Tier', w: 0.8 }, { title: 'Status', w: 0.7 }, { title: 'Created', w: 1 }],
    aliases.map(a => [a.address.split('#')[0], `${TIERS[a.tier]?.short} ${TIERS[a.tier]?.name}`, a.status, day(a.created_at)]));
  else doc.p('No identity has been issued to this site yet.');
  doc.h1('4. Method and limitations');
  doc.bullets([
    'Each factor adds transparent risk points; the score is capped at 100 (0-29 low, 30-54 moderate, 55-74 high, 75+ severe). Sites are never rated "low" when fewer than 60% of signals could be verified.',
    'Only the public homepage and privacy policy are fetched; JavaScript is not executed, so trackers injected at runtime may be under-counted.',
    `Tracker classification uses the Disconnect tracking-protection list (${scan.trackerList?.source || 'n/a'}).`,
    'This assessment describes the site at the time of scanning and is not legal advice.'
  ], { size: 9 });
  return { filename: `tracemask-risk-assessment-${safeName(s.domain)}.pdf`, buffer: doc.toBuffer() };
}

export function postureReportPdf() {
  const mb = db.prepare('SELECT base_address, host, alias_mode, last_sync_at FROM mailbox WHERE id = 1').get();
  const one = (sql) => Object.values(db.prepare(sql).get() || { v: 0 })[0] || 0;
  const aliases = db.prepare(`SELECT a.address, a.tier, a.status, a.created_at, s.domain,
      (SELECT COUNT(*) FROM messages m WHERE m.alias_id = a.id) AS msgs,
      (SELECT COUNT(*) FROM leaks l WHERE l.alias_id = a.id AND l.status != 'dismissed') AS leaks
    FROM aliases a LEFT JOIN sites s ON s.id = a.site_id ORDER BY a.created_at DESC`).all();
  const leaks = db.prepare(`SELECT l.*, s.domain AS site_domain FROM leaks l LEFT JOIN sites s ON s.id = l.site_id ORDER BY l.detected_at DESC`).all();
  const orgs = db.prepare(`SELECT from_domain, COUNT(*) AS n, MAX(has_unsubscribe) AS mk, SUM(in_spam) AS sp, MIN(received_at) AS f FROM messages
    WHERE classification = 'real' AND from_domain IS NOT NULL AND from_domain NOT IN ('gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com','rediffmail.com','yahoo.co.in')
    GROUP BY from_domain ORDER BY n DESC LIMIT 40`).all();
  const reqs = db.prepare('SELECT * FROM erasure_requests ORDER BY created_at DESC').all();
  const audit = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 40').all();
  const reportId = `TM-POSTURE-${ymd()}-${sha(now()).slice(0, 8).toUpperCase()}`;
  const doc = new PdfDoc({ title: 'Personal Data Exposure & Compliance Report', subject: 'Privacy posture', reportId, classification: CLASS });
  doc.cover({
    kicker: 'TRACEMASK  |  PRIVACY POSTURE REPORT',
    title: 'Personal data exposure and compliance report',
    subtitle: 'Where your identity has been disclosed, which organisations leaked it, who still holds your real address, and the status of your erasure requests.',
    meta: [['Report ID', reportId], ['Generated', ist(now())], ['Protected mailbox', mb ? `${mb.base_address} (${mb.host})` : 'not connected'],
      ['Last mailbox sync', ist(mb?.last_sync_at)], ['Look-back window', `${getSettings().lookbackDays} days`]]
  });
  doc.h1('1. Key figures');
  doc.table([{ title: 'Measure', w: 2.4 }, { title: 'Value', w: 1 }], [
    ['Identities (aliases) issued', nf(one("SELECT COUNT(*) FROM aliases WHERE tier < 3"))],
    ['Real-identity disclosures recorded (T3)', nf(one("SELECT COUNT(*) FROM aliases WHERE tier = 3"))],
    ['Leaks attributed (open + confirmed)', nf(one("SELECT COUNT(*) FROM leaks WHERE status != 'dismissed'"))],
    ['Organisations caught leaking', nf(one("SELECT COUNT(DISTINCT site_id) FROM leaks WHERE status != 'dismissed'"))],
    ['Organisations mailing the real address', nf(orgs.length)],
    ['Messages quarantined', nf(one('SELECT COUNT(*) FROM messages WHERE quarantined = 1'))],
    ['Sites risk-assessed before sign-up', nf(one('SELECT COUNT(*) FROM sites'))],
    ['Erasure requests (open)', nf(one("SELECT COUNT(*) FROM erasure_requests WHERE status IN ('draft','sent')"))]
  ]);
  doc.h1('2. Attributed leaks');
  if (leaks.length) doc.table([{ title: 'Data Fiduciary', w: 1.3 }, { title: 'Leaked to', w: 1.3 }, { title: 'Confidence', w: 0.8 }, { title: 'Status', w: 0.7 }, { title: 'First seen', w: 1 }, { title: 'Msgs', w: 0.45 }],
    leaks.map(l => [l.site_domain, l.sender_domain, l.severity, l.status, day(l.first_seen), l.message_count]));
  else doc.p('No leaks have been attributed.');
  doc.h1('3. Identities issued');
  if (aliases.length) doc.table([{ title: 'Site', w: 1.2 }, { title: 'Identity', w: 2.2 }, { title: 'Tier', w: 0.7 }, { title: 'Status', w: 0.65 }, { title: 'Msgs', w: 0.45 }, { title: 'Leaks', w: 0.45 }],
    aliases.map(a => [a.domain || '—', a.address.split('#')[0], TIERS[a.tier]?.short, a.status, a.msgs, a.leaks]), { size: 8 });
  else doc.p('No identities issued yet.');
  doc.h1('4. Organisations holding the real address');
  if (orgs.length) doc.table([{ title: 'Organisation domain', w: 2 }, { title: 'Messages', w: 0.7 }, { title: 'Marketing', w: 0.7 }, { title: 'In spam', w: 0.6 }, { title: 'First seen', w: 1 }],
    orgs.map(o => [o.from_domain, o.n, o.mk ? 'yes' : 'no', o.sp || 0, day(o.f)]));
  else doc.p('No organisations identified yet (the map is built from mailbox headers after the first sync).');
  doc.h1('5. Erasure requests');
  if (reqs.length) doc.table([{ title: 'Organisation', w: 1.4 }, { title: 'Basis', w: 0.6 }, { title: 'Status', w: 0.7 }, { title: 'Sent', w: 0.9 }, { title: 'Follow up', w: 0.9 }],
    reqs.map(r => [r.org_domain, (LAWS[r.law] ? r.law : 'dpdp').toUpperCase(), r.status, day(r.sent_at), day(r.follow_up_at)]));
  else doc.p('No erasure requests drafted.');
  doc.h1('6. Security audit trail (latest 40 events)');
  doc.table([{ title: 'When (IST)', w: 1.1 }, { title: 'Event', w: 1 }, { title: 'Detail', w: 2.6 }], audit.map(a => [ist(a.ts), a.event, a.detail || '']), { size: 7.8 });
  doc.h1('7. Controls in place');
  doc.bullets([
    'Mailbox credentials encrypted at rest with AES-256-GCM under a key derived from the master password (scrypt); the master password is never stored.',
    'Only message headers are processed; message bodies are never downloaded (data minimisation).',
    'All data is stored locally on this computer; the application listens on 127.0.0.1 only.',
    'Leaked and blocked mail is moved to a quarantine folder, never deleted.'
  ], { size: 9 });
  return { filename: `tracemask-privacy-posture-${ymd()}.pdf`, buffer: doc.toBuffer() };
}

export function requestLetterPdf(id) {
  const r = db.prepare('SELECT * FROM erasure_requests WHERE id = ?').get(id);
  if (!r) throw bad('Request not found');
  const reportId = `TM-ERASE-${ymd()}-${String(r.id).padStart(4, '0')}`;
  const doc = new PdfDoc({ title: 'Request for Erasure of Personal Data', subject: r.org_domain, reportId, classification: CLASS });
  doc.text(doc.m.l, doc.y - 12, 'Request for erasure of personal data', { font: 'bold', size: 16, color: '#0d1224' });
  doc.y -= 26;
  doc.kv([['Reference', reportId], ['Date', day(r.sent_at || r.created_at)], ['To', `${r.recipient || 'Grievance / Data Protection Officer'} - ${r.org_domain}`], ['Subject', r.subject], ['Legal basis', LAWS[r.law]?.name || r.law]], { labelW: 90 });
  doc.line(doc.m.l, doc.y, doc.m.l + doc.width, doc.y, '#e5e7eb'); doc.space(12);
  doc.p(r.body, { size: 10, color: '#111827', lh: 1.5 });
  if (r.leak_id) {
    try {
      const b = leakBundle(r.leak_id);
      doc.h2('Annex - evidence reference');
      doc.kv([['Evidence report', b.reportId], ['Evidence digest', `SHA-256 ${b.digest}`], ['Messages', `${b.messages.length} from ${b.l.sender_domain}`]], { labelW: 110 });
    } catch { /* leak removed */ }
  }
  doc.signature(['Signature of Data Principal', 'Date']);
  return { filename: `tracemask-erasure-request-${safeName(r.org_domain)}.pdf`, buffer: doc.toBuffer() };
}
