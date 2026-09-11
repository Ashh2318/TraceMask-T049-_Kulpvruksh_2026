import { h, api, icon, ago, riskBadge, tierBadge, button, empty, downloadPdf, toast } from '../lib.js';
import { go } from '../app.js';
import { riskReport } from './report.js';
import { openErasureComposer } from './requests.js';

export async function sitesView() {
  const rows = await api('/api/sites');
  return h('div', { class: 'card table-wrap' }, rows.length ? h('table', { class: 'tbl' },
    h('thead', {}, h('tr', {}, ['Site', 'Risk', 'Identities', 'Leaks', 'Scanned'].map(t => h('th', {}, t)))),
    h('tbody', {}, rows.map(s => h('tr', { class: 'click', onClick: () => go(`/sites/${s.id}`) },
      h('td', {}, h('div', { class: 'cell-main' }, s.domain), h('div', { class: 'cell-sub trunc' }, s.title || s.url)),
      h('td', {}, riskBadge(s.risk_level, s.risk_score)),
      h('td', {}, s.aliases), h('td', {}, s.leaks ? h('span', { class: 'badge st-bad' }, s.leaks) : '0'),
      h('td', { class: 'small' }, ago(s.scanned_at))))))
    : empty('No sites scanned yet', 'Every site you check before signing up is saved here with its full risk report.', button('Scan a site', { kind: 'primary', ico: 'search', onClick: () => go('/protect') })));
}

export async function siteDetailView(id) {
  const s = await api(`/api/sites/${id}`);
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, button('Site reports', { kind: 'ghost', size: 'sm', onClick: () => go('/sites') }), h('div', { class: 'spacer' }),
      button('Risk report (PDF)', { ico: 'download', onClick: () => downloadPdf(`/api/reports/site/${s.id}`).catch(e => toast(e.message, 'error')) }),
      button('Rescan now', { ico: 'sync', onClick: () => go(`/protect?url=${encodeURIComponent(s.domain)}`) }),
      button('Erasure request', { ico: 'doc', onClick: () => openErasureComposer({ domain: s.domain }) })),
    riskReport(s),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Identities given to this site')),
      s.aliases.length ? s.aliases.map(a => h('div', { class: 'feed-item', style: { cursor: 'pointer' }, onClick: () => go(`/identities/${a.id}`) },
        icon('mask', 18), h('span', { class: 'mono', style: { flex: 1 } }, a.address.split('#')[0]), tierBadge(a.tier), h('span', { class: 'badge st-muted' }, a.status)))
        : empty('No identity yet', 'Create one from the Protect flow.')));
}
