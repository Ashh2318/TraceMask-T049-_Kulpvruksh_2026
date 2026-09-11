import { h, api, icon, toast, ago, fmtDate, tierBadge, button, empty, download, downloadPdf } from '../lib.js';
import { go, rerender, refreshStatus } from '../app.js';
import { openErasureComposer } from './requests.js';

export async function leaksView() {
  const leaks = await api('/api/leaks');
  if (!leaks.length) return h('div', { class: 'card' }, empty('No leaks attributed yet',
    'TraceMask checks every email sent to your aliases. The moment a sender other than the original site uses one, it shows up here with evidence.',
    button('Protect a sign-up', { kind: 'primary', ico: 'plus', onClick: () => go('/protect') })));

  const act = async (l, body, msg) => { await api(`/api/leaks/${l.id}`, { method: 'PATCH', body }); toast(msg, 'success'); refreshStatus(); rerender(); };
  const bySite = {};
  for (const l of leaks) (bySite[l.site_domain || 'unknown'] ||= []).push(l);
  const open = leaks.filter(l => l.status === 'open').length;

  return h('div', { class: 'stack' },
    h('div', { class: 'grid g3' },
      h('div', { class: 'card kpi bad' }, h('div', { class: 'label' }, icon('alert', 15), 'Open leaks'), h('div', { class: 'value' }, open)),
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, icon('globe', 15), 'Companies that leaked'), h('div', { class: 'value' }, Object.keys(bySite).length)),
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, icon('mail', 15), 'Leaked messages caught'), h('div', { class: 'value' }, leaks.reduce((s, l) => s + l.message_count, 0)))),
    ...leaks.map(l => {
      const e = l.evidence || {};
      const authText = e.authentication ? `SPF ${e.authentication.spf || 'none'} · DKIM ${(e.authentication.dkim || []).map(d => `${d.result}${d.domain ? ` (${d.domain})` : ''}`).join(', ') || 'none'} · DMARC ${e.authentication.dmarc || 'none'}` : '—';
      return h('div', { class: `card card-pad leak ${l.status}` },
        h('div', { class: 'row wrap' },
          h('span', { class: `badge ${l.severity === 'high' ? 'st-bad' : 'st-warn'}` }, l.severity === 'review' ? 'lookalike — needs review' : `${l.severity} confidence`),
          h('span', { class: `badge ${l.status === 'open' ? 'st-bad' : l.status === 'confirmed' ? 'st-bad' : 'st-muted'}` }, l.status),
          h('span', { class: 'muted small' }, `detected ${ago(l.detected_at)} · ${l.message_count} message(s)`),
          h('div', { class: 'spacer' }), tierBadge(l.tier)),
        h('div', { class: 'flow', style: { margin: '14px 0' } },
          h('div', { class: 'node' }, h('small', {}, 'Alias issued to'), h('b', {}, l.site_domain)),
          h('span', { class: 'arrow' }, icon('arrow', 20)),
          h('div', { class: 'node' }, h('small', {}, 'Identity'), h('b', { class: 'mono' }, l.address)),
          h('span', { class: 'arrow' }, icon('arrow', 20)),
          h('div', { class: 'node bad' }, h('small', {}, 'Used by'), h('b', {}, l.sender_domain))),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Alias created'), h('dd', {}, fmtDate(l.alias_created, true)),
          h('dt', {}, 'First leaked mail'), h('dd', {}, `${fmtDate(l.first_seen, true)} — “${e.subject || '(no subject)'}”`),
          h('dt', {}, 'Sender'), h('dd', {}, `${e.senderName ? e.senderName + ' ' : ''}<${e.sender}>`),
          h('dt', {}, 'Authentication'), h('dd', {}, authText, e.authentication?.verifiedBy ? h('span', { class: 'muted' }, ` — verified by ${e.authentication.verifiedBy}`) : null),
          h('dt', {}, 'Why it is flagged'), h('dd', {}, l.severity === 'review' ? `${l.sender_domain} uses the same brand name as ${l.site_domain} but is a different domain. If it is the same company, mark it below; if not, it is a lookalike (possible phishing) that obtained your alias.` : `Only ${l.site_domain} was ever given this address. ${l.severity === 'high' ? `${l.sender_domain} is an authenticated sender, so this is real onward sharing, sale or breach — not spoofing.` : `The sender is not authenticated (typical of spam lists built from breached or sold data).`}`)),
        h('div', { class: 'row wrap', style: { marginTop: '14px' } },
          button('Draft erasure request', { kind: 'primary', ico: 'doc', onClick: () => openErasureComposer({ leakId: l.id }) }),
          button('Evidence report (PDF)', { ico: 'download', onClick: () => downloadPdf(`/api/reports/leak/${l.id}`).catch(e => toast(e.message, 'error')) }),
          button('JSON', { kind: 'ghost', size: 'sm', title: 'Machine-readable evidence with SHA-256 digest', onClick: async () => download(`tracemask-leak-${l.site_domain}-${l.sender_domain}.json`, JSON.stringify(await api(`/api/leaks/${l.id}/evidence`), null, 2)) }),
          button('Open identity', { ico: 'mask', onClick: () => go(`/identities/${l.alias_id}`) }),
          h('div', { class: 'spacer' }),
          l.status === 'open' ? button('Confirm leak', { kind: 'danger', size: 'sm', onClick: () => act(l, { status: 'confirmed' }, 'Leak confirmed') }) : null,
          l.status !== 'dismissed' ? button(l.severity === 'review' ? `Yes, ${l.sender_domain} is ${l.site_domain}` : 'Not a leak (same company)', { kind: 'ghost', size: 'sm', onClick: () => act(l, { status: 'dismissed', trustSender: true }, `${l.sender_domain} trusted for ${l.site_domain}`) }) : null));
    }));
}
