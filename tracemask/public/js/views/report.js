import { h, icon, num, fmtDate, riskBadge, safeHref } from '../lib.js';

export function gauge(score, level) {
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const color = { low: '#0f9d6b', moderate: '#c27803', high: '#d92d4b', severe: '#9f1239' }[level] || '#7c8599';
  const a = Math.PI * (1 - pct);
  const x = 80 + 64 * Math.cos(a), y = 84 - 64 * Math.sin(a);
  const svg = `<svg viewBox="0 0 160 96"><path d="M16 84 A64 64 0 0 1 144 84" fill="none" stroke="#eef0f5" stroke-width="14" stroke-linecap="round"/>` +
    (pct > 0 ? `<path d="M16 84 A64 64 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"/>` : '') + `</svg>`;
  return h('div', { class: 'gauge' }, h('div', { html: svg }), h('div', { class: 'g-val' }, h('b', { style: { color } }, String(score)), h('span', {}, `${level} risk`)));
}

const ICON = { good: 'check', warn: 'alert', bad: 'x', unknown: 'eye' };

export function riskReport(site) {
  const s = site.scan;
  if (!s) return h('div', { class: 'muted' }, 'No scan data.');
  const factors = h('div', {}, s.risk.factors.map(f => h('div', { class: 'factor' },
    h('span', { class: `f-${f.status}` }, icon(ICON[f.status], 18)),
    h('b', { class: 'small' }, f.label),
    h('span', { class: 'small', style: { color: 'var(--text-2)' } }, f.detail),
    h('span', { class: `f-pts f-${f.points ? (f.points >= 10 ? 'bad' : 'warn') : 'good'}` }, f.points ? `+${f.points}` : '0'))));

  const breaches = s.breaches?.breaches || [];
  const trackers = s.page?.ok ? s.page.analysis.trackers : [];
  const p = s.privacy || {};
  return h('div', { class: 'stack' },
    h('div', { class: 'card card-pad' },
      h('div', { class: 'row wrap', style: { gap: '24px', alignItems: 'center' } },
        gauge(s.risk.score, s.risk.level),
        h('div', { style: { flex: 1, minWidth: '260px' } },
          h('div', { class: 'row' }, h('h3', { style: { fontSize: '18px' } }, site.domain), riskBadge(s.risk.level, s.risk.score)),
          h('div', { class: 'muted small', style: { margin: '4px 0 8px' } }, s.title || site.url),
          h('div', { class: 'small muted' }, `Scanned ${fmtDate(s.startedAt, true)} in ${(s.durationMs / 1000).toFixed(1)}s · ${s.risk.coverage ?? 100}% of signals verified live`),
          s.risk.unverified ? h('div', { class: 'note warn small', style: { marginTop: '8px' } }, `${s.risk.unverified} signal${s.risk.unverified > 1 ? 's' : ''} could not be verified (the site or source refused the check). Unverified signals add risk points rather than being assumed safe.`) : null)),
      h('div', { style: { marginTop: '14px' } }, factors)),
    h('div', { class: 'grid g3' },
      h('div', { class: 'card card-pad' },
        h('div', { class: 'row' }, icon('alert', 15), h('b', {}, `Breaches (${breaches.length})`)),
        h('div', { class: 'small muted', style: { margin: '2px 0 8px' } }, s.breaches?.ok ? 'Source: Have I Been Pwned' : `Unavailable: ${s.breaches?.error}`),
        breaches.length ? breaches.slice(0, 5).map(b => h('div', { style: { padding: '6px 0', borderTop: '1px solid var(--line-2)' } },
          h('div', { class: 'small' }, h('b', {}, b.name), ` · ${b.date}`),
          h('div', { class: 'cell-sub' }, `${num(b.pwnCount)} accounts · ${b.dataClasses.slice(0, 4).join(', ')}`)))
          : h('div', { class: 'small', style: { color: 'var(--ok)' } }, s.breaches?.ok ? 'No breaches on record for this domain.' : '')),
      h('div', { class: 'card card-pad' },
        h('div', { class: 'row' }, icon('eye', 15), h('b', {}, `Trackers (${trackers.length})`)),
        h('div', { class: 'small muted', style: { margin: '2px 0 8px' } }, s.page?.ok ? `${s.page.analysis.thirdPartyHosts.length} third-party hosts · list: ${s.trackerList?.source}` : `Homepage unavailable: ${s.page?.error}`),
        trackers.length ? h('div', {}, trackers.map(t => h('span', { class: 'tag', title: t.host || '' }, `${t.company} · ${t.category}`)))
          : h('div', { class: 'small', style: { color: s.page?.ok ? 'var(--ok)' : 'var(--text-3)' } }, s.page?.ok ? 'No known trackers on the homepage.' : '')),
      h('div', { class: 'card card-pad' },
        h('div', { class: 'row' }, icon('doc', 15), h('b', {}, 'Privacy policy')),
        p.found ? h('div', { class: 'small', style: { marginTop: '6px' } },
          safeHref(p.url) ? h('a', { href: safeHref(p.url), target: '_blank', rel: 'noopener noreferrer' }, 'Open policy ', icon('ext', 12)) : null,
          h('ul', { style: { paddingLeft: '18px', margin: '8px 0 0', color: 'var(--text-2)' } },
            h('li', {}, p.deletionRights ? 'Describes deletion / erasure' : 'No deletion process described'),
            h('li', {}, p.grievanceContact ? 'Names a grievance / DPO contact' : 'No grievance / DPO contact'),
            h('li', {}, p.sharingOrSale ? 'Mentions sharing / selling to partners' : 'No selling / partner-sharing language found'),
            h('li', {}, [p.mentionsDpdp && 'DPDP', p.mentionsGdpr && 'GDPR'].filter(Boolean).join(' + ') || 'No DPDP / GDPR reference')),
          p.emails?.length ? h('div', { class: 'cell-sub', style: { marginTop: '6px' } }, `Contacts: ${p.emails.slice(0, 3).join(', ')}`) : null)
          : h('div', { class: 'small', style: { color: 'var(--bad)', marginTop: '6px' } }, 'No privacy policy found on the site.'))));
}
