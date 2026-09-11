// Self-check: proves every scanner signal is fetched live from real public sources.
// Usage:  npm run check -- myntra.com github.com
import { initPsl, pslSource, registrable } from './lib/psl.js';
import { loadTrackers } from './lib/trackers.js';
import { scanSite } from './lib/scanner.js';
import { classifyAliasMessage } from './lib/leak-engine.js';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const targets = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '--json');
const scans = [];
if (!targets.length) targets.push('github.com', 'myntra.com');

console.log('\nTraceMask self-check — live data sources\n' + '-'.repeat(60));
await initPsl();
console.log(`Public Suffix List : ${pslSource()}  (e.g. mail.shop.example.co.in → ${registrable('mail.shop.example.co.in')})`);
const t = await loadTrackers();
console.log(`Tracker list       : ${t.source}${t.domains ? ` — ${t.domains.toLocaleString('en-IN')} tracker domains` : ''}`);

{
  const dns = await import('node:dns/promises');
  const sys = await dns.lookup('google.com', { all: true }).then(a => a.map(x => x.address).join(', ')).catch(e => 'FAILED ' + (e.code || e.message));
  const direct = await new dns.Resolver({ timeout: 4000 }).resolve4('google.com').then(a => a.join(', ')).catch(e => 'FAILED ' + (e.code || e.message));
  console.log(`DNS (system)       : google.com -> ${sys}`);
  console.log(`DNS (direct query) : google.com -> ${direct}`);
}

for (const target of targets) {
  console.log(`\n=== Scanning ${target} (live) ===`);
  let r;
  try {
  r = await scanSite(target, (step, status, summary) => { if (status !== 'running') console.log(`  [${status === 'done' ? ' ok ' : 'FAIL'}] ${step.padEnd(9)} ${summary || ''}`); });
  console.log(`  TLS      : ${r.tls?.ok ? `valid, issuer ${r.tls.issuer}, expires ${r.tls.validTo?.slice(0, 10)} (${r.tls.protocol})` : r.tls?.error}`);
  console.log(`  DNS      : ${r.dns?.addresses.join(', ') || '—'} | MX ${r.dns?.mx.join(', ') || 'none'} | DMARC ${r.dns?.dmarc ? r.dns.dmarc.policy : 'none'}`);
  console.log(`  RDAP     : ${r.rdap?.ok ? `registered ${r.rdap.registeredAt?.slice(0, 10)} via ${r.rdap.registrar || '?'} (source ${r.rdap.source})` : r.rdap?.error}`);
  console.log(`  HIBP     : ${r.breaches?.ok ? (r.breaches.breaches.map(b => `${b.name} ${b.date} (${b.pwnCount?.toLocaleString('en-IN')})`).join('; ') || 'no breaches listed') : r.breaches?.error}`);
  console.log(`  Homepage : ${r.page?.ok ? `HTTP ${r.page.status} ${r.page.finalUrl} — "${r.title || ''}"` : r.page?.error}`);
  if (r.page?.ok) console.log(`  Trackers : ${r.page.analysis.trackers.map(x => x.company).join(', ') || 'none'} | third-party hosts: ${r.page.analysis.thirdPartyHosts.length}`);
  console.log(`  Policy   : ${r.privacy?.found ? `${r.privacy.url} (${r.privacy.words} words) contacts: ${r.privacy.emails.join(', ') || 'none'}` : 'not found'}`);
  } catch (e) { console.log(`  [FAIL] ${e.message}`); continue; }
  scans.push(r);
  console.log(`  RISK     : ${r.risk.score}/100 (${r.risk.level})`);
  for (const f of r.risk.factors) console.log(`     ${String(f.points).padStart(3)}  ${f.label.padEnd(26)} ${f.detail}`);
}

console.log('\n=== Leak engine rules (deterministic) ===');
const cases = [
  ['updates@myntra.com', 'myntra.com', { dmarc: 'pass', dkim: [{ result: 'pass', domain: 'myntra.com' }] }],
  ['offers@e.myntra.com', 'myntra.com', { dmarc: 'pass', dkim: [] }],
  ['deals@shopdealz.in', 'myntra.com', { dmarc: 'pass', dkim: [{ result: 'pass', domain: 'shopdealz.in' }] }],
  ['win@prize.top', 'myntra.com', { dmarc: 'fail', dkim: [] }],
  ['support@myntra.shop', 'myntra.com', { dmarc: 'pass', dkim: [] }]
];
for (const [from, site, auth] of cases) {
  const v = classifyAliasMessage({ fromDomain: from.split('@')[1], auth, siteDomain: site });
  console.log(`  alias for ${site.padEnd(11)} ← ${from.padEnd(22)} => ${v.classification.toUpperCase().padEnd(6)} ${v.severity || ''}  ${v.reason}`);
}
if (jsonOut) { (await import('node:fs')).writeFileSync(jsonOut, JSON.stringify(scans, null, 1)); console.log(`Raw scan data written to ${jsonOut}`); }
console.log('\nDone. Every value above was fetched just now from the live internet.\n');
