// Live sign-up risk scanner. Every signal is measured at scan time from public sources:
// DNS, the site's TLS certificate, its HTTP response + HTML, its privacy policy, RDAP
// registration data and Have I Been Pwned's public breach catalogue.
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { registrable, normalizeHost } from './psl.js';
import { loadTrackers, classifyHost, trackerMeta } from './trackers.js';
import { safeFetch, assertPublicHost } from './net-guard.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 TraceMask/1.0';
const HTML_LIMIT = 2_000_000;

export function normalizeTarget(input) {
  let s = String(input || '').trim();
  if (!s) throw Object.assign(new Error('Enter a website address'), { status: 400 });
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw Object.assign(new Error('That does not look like a valid website address'), { status: 400 }); }
  const host = normalizeHost(u.hostname);
  if (!host.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(host)) {
    throw Object.assign(new Error('Enter a public website domain'), { status: 400 });
  }
  return { url: `https://${host}${u.pathname === '/' ? '/' : u.pathname}`, host, domain: registrable(host) };
}

async function readLimited(res, limit = HTML_LIMIT) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
    if (size > limit) { try { await reader.cancel(); } catch {} break; }
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

async function fetchPage(url, timeout = 15000) {
  const res = await safeFetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-IN,en;q=0.9' },
    signal: AbortSignal.timeout(timeout)
  });
  const ctype = res.headers.get('content-type') || '';
  const body = /html|xml|text/i.test(ctype) || !ctype ? await readLimited(res) : '';
  return { status: res.status, finalUrl: res.finalUrl || res.url, headers: Object.fromEntries(res.headers), body };
}

export async function checkTls(host) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const cert = sock.getPeerCertificate();
      const out = {
        ok: sock.authorized,
        error: sock.authorized ? null : String(sock.authorizationError || 'untrusted certificate'),
        protocol: sock.getProtocol(),
        issuer: cert?.issuer?.O || cert?.issuer?.CN || null,
        subject: cert?.subject?.CN || null,
        validTo: cert?.valid_to ? new Date(cert.valid_to).toISOString() : null
      };
      out.daysLeft = out.validTo ? Math.floor((new Date(out.validTo) - Date.now()) / 86400000) : null;
      sock.end();
      resolve(out);
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, error: 'TLS handshake timed out' }); });
    sock.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
  });
}

export async function checkDns(domain, host) {
  const out = { resolves: false, addresses: [], mx: [], dmarc: null, spf: null };
  const r = new dns.Resolver({ timeout: 3000, tries: 2 });
  const safe = (p) => p.catch(() => []);
  const [a4, a6, mx, dmarc, txt] = await Promise.all([
    safe(r.resolve4(host)), safe(r.resolve6(host)), safe(r.resolveMx(domain)),
    safe(r.resolveTxt(`_dmarc.${domain}`)), safe(r.resolveTxt(domain))
  ]);
  out.addresses = [...a4, ...a6].slice(0, 6);
  out.resolves = out.addresses.length > 0;
  out.mx = mx.sort((a, b) => a.priority - b.priority).map(m => m.exchange).slice(0, 5);
  const d = dmarc.map(r => r.join('')).find(r => /^v=DMARC1/i.test(r));
  if (d) out.dmarc = { record: d, policy: ((d.match(/;\s*p=(\w+)/i) || [])[1] || 'none').toLowerCase() };
  const spf = txt.map(r => r.join('')).find(r => /^v=spf1/i.test(r));
  out.spf = spf || null;
  return out;
}

export async function checkRdap(domain) {
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { accept: 'application/rdap+json, application/json', 'user-agent': UA },
      redirect: 'follow', signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return { ok: false, error: `RDAP HTTP ${res.status}` };
    const j = await res.json();
    const ev = (a) => (j.events || []).find(e => e.eventAction === a)?.eventDate || null;
    const registrar = (j.entities || []).find(e => (e.roles || []).includes('registrar'));
    const fn = registrar?.vcardArray?.[1]?.find(v => v[0] === 'fn')?.[3] || null;
    const created = ev('registration');
    return {
      ok: true, registeredAt: created, expiresAt: ev('expiration'), registrar: fn,
      ageDays: created ? Math.floor((Date.now() - new Date(created)) / 86400000) : null,
      source: res.url
    };
  } catch (e) { return { ok: false, error: e.name === 'TimeoutError' ? 'RDAP lookup timed out' : e.message }; }
}

export async function checkBreaches(domain) {
  try {
    const res = await fetch(`https://haveibeenpwned.com/api/v3/breaches?domain=${encodeURIComponent(domain)}`, {
      headers: { 'user-agent': 'TraceMask-Hackathon-Scanner', accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return { ok: false, error: `HIBP HTTP ${res.status}`, breaches: [] };
    const list = await res.json();
    return {
      ok: true,
      breaches: list.map(b => ({
        name: b.Title || b.Name, date: b.BreachDate, pwnCount: b.PwnCount,
        dataClasses: (b.DataClasses || []).slice(0, 8), verified: b.IsVerified
      })).sort((a, b) => String(b.date).localeCompare(String(a.date)))
    };
  } catch (e) { return { ok: false, error: e.message, breaches: [] }; }
}

const INLINE_SIGNATURES = [
  [/gtag\(|google-analytics\.com|googletagmanager\.com/i, 'Google Analytics / Tag Manager'],
  [/fbq\(\s*['"]init|connect\.facebook\.net/i, 'Meta Pixel'],
  [/_hjSettings|static\.hotjar\.com/i, 'Hotjar session recording'],
  [/clarity\.ms/i, 'Microsoft Clarity session recording'],
  [/_linkedin_partner_id|snap\.licdn\.com/i, 'LinkedIn Insight'],
  [/ttq\.load|analytics\.tiktok\.com/i, 'TikTok Pixel'],
  [/snaptr\(/i, 'Snap Pixel'],
  [/mixpanel\.init/i, 'Mixpanel'],
  [/amplitude\.getInstance|cdn\.amplitude\.com/i, 'Amplitude'],
  [/webengage/i, 'WebEngage'],
  [/moengage/i, 'MoEngage'],
  [/clevertap/i, 'CleverTap'],
  [/branch\.init|cdn\.branch\.io/i, 'Branch'],
  [/_satellite|assets\.adobedtm\.com/i, 'Adobe Experience Platform'],
  [/criteo/i, 'Criteo'],
  [/doubleclick\.net|googlesyndication/i, 'Google Ads']
];

// Linear-time extraction (no catastrophic backtracking on hostile or truncated HTML)
function extractInlineScripts(html) {
  const out = []; const lower = html.toLowerCase(); let i = 0;
  while (out.length < 200 && (i = lower.indexOf('<script', i)) >= 0) {
    const tagEnd = lower.indexOf('>', i); if (tagEnd < 0) break;
    const close = lower.indexOf('</script', tagEnd); if (close < 0) break;
    if (!/\bsrc\s*=/.test(lower.slice(i, tagEnd))) out.push(html.slice(tagEnd + 1, Math.min(close, tagEnd + 1 + 200000)));
    i = close + 8;
  }
  return out.join('\n');
}
function extractAnchors(html) {
  const out = []; const lower = html.toLowerCase(); let i = 0;
  while (out.length < 3000 && (i = lower.indexOf('<a', i)) >= 0) {
    const tagEnd = lower.indexOf('>', i); if (tagEnd < 0) break;
    const tag = html.slice(i, tagEnd + 1);
    if (!/^<a[\s>]/i.test(tag)) { i += 2; continue; }
    const hm = tag.match(/\bhref\s*=\s*["']([^"']{1,2000})["']/i);
    const close = lower.indexOf('</a', tagEnd);
    const inner = close > 0 && close - tagEnd < 2000 ? html.slice(tagEnd + 1, close) : '';
    if (hm) out.push({ href: hm[1], text: inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) });
    i = tagEnd + 1;
  }
  return out;
}

function absolute(href, base) { try { return new URL(href, base).href; } catch { return null; } }

export function analyzeHtml(html, baseUrl, siteDomain) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/\s+/g, ' ').trim().slice(0, 140) || null;
  const srcs = [];
  const re = /<(script|iframe|img|link|source|embed)\b[^>]*?\b(?:src|href)\s*=\s*["']?([^"'\s>]+)/gi;
  let m;
  while ((m = re.exec(html))) { const u = absolute(m[2], baseUrl); if (u && /^https?:/i.test(u)) srcs.push(u); }
  const hosts = new Set(srcs.map(u => new URL(u).hostname.toLowerCase()));
  const thirdParty = [...hosts].filter(h => registrable(h) !== siteDomain);
  const trackers = new Map();
  for (const h of thirdParty) {
    const hit = classifyHost(h);
    if (hit) trackers.set(hit.company, { company: hit.company, category: hit.category, host: h });
  }
  const inlineScripts = extractInlineScripts(html);
  const haystack = inlineScripts + '\n' + srcs.join('\n');
  for (const [sig, name] of INLINE_SIGNATURES) {
    if (sig.test(haystack) && ![...trackers.values()].some(t => t.company.toLowerCase().includes(name.split(' ')[0].toLowerCase()))) {
      trackers.set(name, { company: name, category: 'Inline tag', host: null });
    }
  }
  const anchors = extractAnchors(html);
  const privacyLink = anchors.find(a => /privacy/i.test(a.text) || /privacy/i.test(a.href));
  const privacyCandidates = [...new Set([...html.matchAll(/["'(]((?:https?:\/\/[^"'()\s]+)?\/[^"'()\s]*privacy[^"'()\s]*)["')]/gi)]
    .map(x => absolute(x[1].replace(/\\\//g, '/'), baseUrl)).filter(u => u && /^https?:/i.test(u) && !/\.(js|css|png|svg|jpg|webp)(\?|$)/i.test(u)))].slice(0, 4);
  const forms = (html.match(/<form\b/gi) || []).length;
  const emailInputs = (html.match(/<input\b[^>]*type\s*=\s*["']?email/gi) || []).length;
  return {
    title, thirdPartyHosts: thirdParty.sort(), trackers: [...trackers.values()],
    privacyUrl: privacyLink ? absolute(privacyLink.href, baseUrl) : null, privacyCandidates, forms, emailInputs
  };
}

// Flags selling/sharing language, ignoring negated statements such as "we do not sell your data".
function mentionsSale(text) {
  const SALE = /\b(sell|sells|sold|sale of (your )?personal)\b|advertising partners|marketing partners|share (your |such )?(personal )?(information|data) with (our )?(third|partners|affiliates|advertis)/i;
  const NEG = /\b(not|never|no|don't|do not|does not|won't|will not|neither|nor)\b/i;
  return text.split(/(?<=[.!?])\s+/).some(s => SALE.test(s) && !NEG.test(s));
}

const htmlToText = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#64;|&commat;/g, '@')
  .replace(/\s+/g, ' ');

export async function checkPrivacyPolicy(privacyUrl, origin, extra = []) {
  const candidates = [privacyUrl, ...extra, `${origin}/privacy-policy`, `${origin}/privacy`].filter(Boolean);
  let blocked = 0, notFound = 0;
  for (const url of [...new Set(candidates)]) {
    try {
      const page = await fetchPage(url, 12000);
      if ([401, 403, 429, 503].includes(page.status)) { blocked++; continue; }
      if (page.status >= 400 || page.body.length < 500) { notFound++; continue; }
      const raw = page.body;
      const text = htmlToText(raw).slice(0, 400000);
      if (!/privacy|personal (data|information)/i.test(text)) continue;
      const lower = text.toLowerCase();
      const mailtos = [...raw.matchAll(/mailto:([^"'?\s>]+)/gi)].map(x => decodeURIComponent(x[1]));
      const inText = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
      const strict = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/;
      const emails = [...new Set([...mailtos, ...inText].map(e => (e.toLowerCase().match(strict) || [''])[0]).filter(Boolean))]
        .filter(e => !/\.(png|jpg|jpeg|gif|svg|webp)$/.test(e) && !/example\.|sentry|wixpress/.test(e)).slice(0, 8);
      const rank = (e) => (/grievance|privacy|dpo|data|legal|compliance/.test(e) ? 0 : /support|help|care|contact/.test(e) ? 1 : 2);
      emails.sort((a, b) => rank(a) - rank(b));
      return {
        found: true, url: page.finalUrl, words: text.split(' ').length,
        mentionsDpdp: /digital personal data protection|\bdpdp/.test(lower),
        mentionsGdpr: /\bgdpr\b|general data protection regulation/.test(lower),
        grievanceContact: /grievance (officer|redressal)|data protection officer|\bdpo\b|nodal officer|privacy officer/.test(lower) || emails.some(e => /grievance|dpo|privacy|dataprotection/.test(e)),
        sharingOrSale: mentionsSale(text),
        deletionRights: /\bdelet|\berasure\b|\berase\b|right to be forgotten/.test(lower),
        retention: /\bretain|\bretention\b/.test(lower),
        emails
      };
    } catch { blocked++; }
  }
  return { found: false, blocked: blocked > 0 && notFound === 0, emails: [] };
}

export function scoreRisk(r) {
  const f = [];
  const add = (key, label, points, status, detail) => f.push({ key, label, points, status, detail });

  if (!r.tls) add('tls', 'HTTPS certificate', 0, 'unknown', 'Not checked');
  else if (!r.tls.ok) add('tls', 'HTTPS certificate', 25, 'bad', `Certificate problem: ${r.tls.error}`);
  else if (r.tls.daysLeft !== null && r.tls.daysLeft < 14) add('tls', 'HTTPS certificate', 5, 'warn', `Valid, but expires in ${r.tls.daysLeft} days (${r.tls.issuer})`);
  else add('tls', 'HTTPS certificate', 0, 'good', `Valid ${r.tls.protocol} certificate from ${r.tls.issuer || 'trusted CA'}`);

  const age = r.rdap?.ageDays;
  if (!r.rdap?.ok || age == null) add('age', 'Domain age', 5, 'unknown', `Registration date not available (${r.rdap?.error || 'no RDAP data'})`);
  else if (age < 180) add('age', 'Domain age', 25, 'bad', `Registered only ${age} days ago`);
  else if (age < 365) add('age', 'Domain age', 18, 'bad', `Registered ${age} days ago (under 1 year)`);
  else if (age < 1095) add('age', 'Domain age', 6, 'warn', `Registered ${(age / 365).toFixed(1)} years ago`);
  else add('age', 'Domain age', 0, 'good', `Registered ${(age / 365).toFixed(1)} years ago${r.rdap.registrar ? ` via ${r.rdap.registrar}` : ''}`);

  const br = r.breaches?.breaches || [];
  if (!r.breaches?.ok) add('breaches', 'Known data breaches', 5, 'unknown', `Breach catalogue unavailable (${r.breaches?.error})`);
  else if (!br.length) add('breaches', 'Known data breaches', 0, 'good', 'No breaches listed in Have I Been Pwned');
  else {
    const recent = br.some(b => (Date.now() - new Date(b.date)) / 86400000 < 1095);
    const pw = br.some(b => b.dataClasses.some(c => /password/i.test(c)));
    const pts = Math.min(30, 15 * br.length) + (recent ? 5 : 0) + (pw ? 5 : 0);
    add('breaches', 'Known data breaches', pts, 'bad',
      `${br.length} breach${br.length > 1 ? 'es' : ''} on record (latest ${br[0].date}, ${br[0].pwnCount?.toLocaleString('en-IN')} accounts)${pw ? '; passwords exposed' : ''}`);
  }

  if (!r.page?.ok) add('trackers', 'Third-party trackers', 8, 'unknown', `Homepage could not be analysed (${r.page?.error})`);
  else {
    const t = r.page.analysis.trackers;
    const pts = Math.min(24, 3 * t.length) + (r.page.analysis.thirdPartyHosts.length > 15 ? 4 : 0);
    add('trackers', 'Third-party trackers', pts, t.length >= 5 ? 'bad' : t.length ? 'warn' : 'good',
      t.length ? `${t.length} tracker${t.length > 1 ? 's' : ''} on the homepage: ${t.slice(0, 5).map(x => x.company).join(', ')}${t.length > 5 ? '…' : ''}`
        : `No known trackers found (${r.page.analysis.thirdPartyHosts.length} third-party hosts)`);
  }

  const p = r.privacy;
  if (!p?.found && p?.blocked) add('policy', 'Privacy policy', 8, 'unknown', 'Site blocked automated access to its privacy policy — could not verify');
  else if (!p?.found) add('policy', 'Privacy policy', 15, 'bad', 'No privacy policy link found on the homepage or at /privacy, /privacy-policy');
  else {
    let pts = 0; const notes = [];
    if (p.sharingOrSale) { pts += 8; notes.push('mentions selling or sharing data with partners'); }
    if (!p.deletionRights) { pts += 4; notes.push('no deletion/erasure process described'); }
    if (!p.grievanceContact) { pts += 5; notes.push('no grievance or data-protection officer named'); }
    const good = [p.mentionsDpdp && 'references DPDP Act', p.mentionsGdpr && 'references GDPR', p.deletionRights && 'describes deletion'].filter(Boolean);
    add('policy', 'Privacy policy', pts, pts >= 10 ? 'bad' : pts ? 'warn' : 'good',
      [notes.length ? `Policy found — ${notes.join('; ')}` : 'Policy found', good.length ? `(${good.join(', ')})` : ''].join(' ').trim());
  }

  const h = r.page?.ok ? r.page.headers : null;
  if (h) {
    const missing = [];
    let pts = 0;
    if (!h['strict-transport-security']) { missing.push('HSTS'); pts += 3; }
    if (!h['content-security-policy']) { missing.push('CSP'); pts += 2; }
    add('headers', 'Security headers', pts, pts ? 'warn' : 'good', missing.length ? `Missing ${missing.join(' and ')}` : 'HSTS and CSP present');
  }

  if (r.dns) {
    if (!r.dns.dmarc) add('dmarc', 'Email spoofing protection', 4, 'warn', 'No DMARC record — phishing mail can impersonate this brand');
    else if (r.dns.dmarc.policy === 'none') add('dmarc', 'Email spoofing protection', 2, 'warn', 'DMARC in monitor-only mode (p=none)');
    else add('dmarc', 'Email spoofing protection', 0, 'good', `DMARC enforced (p=${r.dns.dmarc.policy})`);
  }

  const score = Math.min(100, f.reduce((s, x) => s + x.points, 0));
  let level = score >= 75 ? 'severe' : score >= 55 ? 'high' : score >= 30 ? 'moderate' : 'low';
  const unknown = f.filter(x => x.status === 'unknown').length;
  const coverage = f.length ? Math.round(((f.length - unknown) / f.length) * 100) : 0;
  // Never call a site "low risk" when we could not actually verify most signals.
  if (coverage < 60 && level === 'low') level = 'moderate';
  return { score, level, factors: f, coverage, unverified: unknown };
}

// Runs the full scan; onStep(stepKey, status, summary) streams progress to the UI.
export async function scanSite(input, onStep = () => {}) {
  const target = normalizeTarget(input);
  await assertPublicHost(target.host); // SSRF guard: never scan loopback/private/metadata addresses
  const started = Date.now();
  const r = { target, startedAt: new Date().toISOString() };
  const step = async (key, fn, summarize) => {
    onStep(key, 'running');
    try {
      const v = await fn();
      const failed = v && (v.ok === false || v.resolves === false);
      onStep(key, failed ? 'error' : 'done', summarize(v));
      return v;
    }
    catch (e) { onStep(key, 'error', e.message); return null; }
  };
  await loadTrackers();
  const [dnsR, tlsR, rdapR, brR, pageR] = await Promise.all([
    step('dns', () => checkDns(target.domain, target.host), v => v.resolves ? `${v.addresses.length} address(es), ${v.mx.length} mail server(s)` : 'Domain does not resolve'),
    step('tls', () => checkTls(target.host), v => v.ok ? `Valid certificate (${v.issuer || 'CA'})` : `Problem: ${v.error}`),
    step('rdap', () => checkRdap(target.domain), v => v.ok && v.ageDays != null ? `Registered ${v.registeredAt.slice(0, 10)}` : (v.error || 'No registration date')),
    step('breaches', () => checkBreaches(target.domain), v => v.ok ? `${v.breaches.length} breach(es) on record` : v.error),
    step('page', async () => {
      try {
        const pg = await fetchPage(target.url);
        if (pg.status >= 400) return { ok: false, error: `site answered HTTP ${pg.status} to an automated check`, status: pg.status };
        return { ok: true, status: pg.status, finalUrl: pg.finalUrl, headers: pg.headers, analysis: analyzeHtml(pg.body, pg.finalUrl, target.domain) };
      } catch (e) { return { ok: false, error: e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code || e.message) }; }
    }, v => v.ok ? `${v.analysis.trackers.length} tracker(s), ${v.analysis.thirdPartyHosts.length} third-party host(s)` : `Could not load (${v.error})`)
  ]);
  Object.assign(r, { dns: dnsR, tls: tlsR, rdap: rdapR, breaches: brR, page: pageR });
  const origin = pageR?.ok ? new URL(pageR.finalUrl).origin : `https://${target.host}`;
  r.privacy = await step('privacy', () => checkPrivacyPolicy(pageR?.ok ? pageR.analysis.privacyUrl : null, origin, pageR?.ok ? pageR.analysis.privacyCandidates : []),
    v => v.found ? `Policy found (${v.words.toLocaleString('en-IN')} words)` : 'No privacy policy found');
  r.risk = scoreRisk(r);
  r.title = pageR?.ok ? pageR.analysis.title : null;
  r.trackerList = trackerMeta();
  r.durationMs = Date.now() - started;
  if (r.page?.ok) {
    const keep = ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'server'];
    r.page.headers = Object.fromEntries(Object.entries(r.page.headers).filter(([k]) => keep.includes(k)));
  }
  return r;
}
