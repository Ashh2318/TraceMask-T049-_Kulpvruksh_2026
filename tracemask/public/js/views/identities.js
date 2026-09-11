import { h, api, icon, copy, toast, ago, fmtDate, tierBadge, riskBadge, classBadge, button, empty, withBusy } from '../lib.js';
import { go, rerender, refreshStatus } from '../app.js';
import { openErasureComposer } from './requests.js';

const statusBadge = (s) => h('span', { class: `badge ${s === 'active' ? 'st-ok' : s === 'disclosed' ? 'st-info' : 'st-muted'}` }, s);
const shown = (addr) => String(addr).split('#')[0];

export async function identitiesView() {
  let rows = await api('/api/aliases');
  const q = h('input', { class: 'input', placeholder: 'Search alias, site or label…', style: { maxWidth: '320px' } });
  let filter = 'all';
  const body = h('tbody');
  const seg = h('div', { class: 'seg' }, ['all', 'active', 'leaked', 'blocked', 'expired'].map(f =>
    h('button', { class: f === 'all' ? 'on' : '', 'data-f': f, onClick: () => { filter = f; seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.f === f)); draw(); } }, f)));
  function draw() {
    const term = q.value.toLowerCase();
    const list = rows.filter(a => (filter === 'all' || (filter === 'leaked' ? a.leaks > 0 : a.status === filter)) &&
      (!term || [a.address, a.site_domain, a.label].some(x => String(x || '').toLowerCase().includes(term))));
    body.replaceChildren(...list.map(a => h('tr', { class: 'click', onClick: () => go(`/identities/${a.id}`) },
      h('td', {}, h('div', { class: 'cell-main mono' }, shown(a.address)), h('div', { class: 'cell-sub' }, a.label || '')),
      h('td', {}, h('div', {}, a.site_domain || '—'), a.risk_level ? riskBadge(a.risk_level, a.risk_score) : null),
      h('td', {}, tierBadge(a.tier)),
      h('td', {}, statusBadge(a.status), a.expires_at && a.status === 'active' ? h('div', { class: 'cell-sub' }, `expires ${ago(a.expires_at)}`) : null),
      h('td', {}, h('div', {}, `${a.messages} message(s)`), h('div', { class: 'cell-sub' }, a.last_message_at ? `last ${ago(a.last_message_at)}` : 'no mail yet')),
      h('td', {}, a.leaks ? h('span', { class: 'badge st-bad' }, `${a.leaks} leak${a.leaks > 1 ? 's' : ''}`) : h('span', { class: 'badge st-ok' }, 'clean')),
      h('td', {}, a.tier < 3 ? h('button', { class: 'icon-btn', title: 'Copy', onClick: (e) => { e.stopPropagation(); copy(a.address); } }, icon('copy', 16)) : null))));
    if (!list.length) body.replaceChildren(h('tr', {}, h('td', { colspan: 7 }, empty(rows.length ? 'Nothing matches' : 'No identities yet', rows.length ? 'Try another filter.' : 'Create your first alias from “Protect a sign-up”.',
      rows.length ? null : button('Protect a sign-up', { kind: 'primary', ico: 'plus', onClick: () => go('/protect') })))));
  }
  q.addEventListener('input', draw);
  draw();
  return h('div', { class: 'stack' },
    h('div', { class: 'row wrap' }, q, seg, h('div', { class: 'spacer' }), button('New identity', { kind: 'primary', ico: 'plus', onClick: () => go('/protect') })),
    h('div', { class: 'card table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Identity', 'Site', 'Tier', 'Status', 'Mail', 'Leaks', ''].map(t => h('th', {}, t)))), body)));
}

export async function aliasDetailView(id) {
  const a = await api(`/api/aliases/${id}`);
  const reload = () => { rerender(); refreshStatus(); };
  const real = a.tier === 3;
  const toggle = h('button', { class: `btn ${a.status === 'active' ? 'btn-danger' : 'btn-secondary'}` }, icon(a.status === 'active' ? 'ban' : 'check', 16), a.status === 'active' ? 'Block alias' : 'Reactivate');
  toggle.addEventListener('click', () => withBusy(toggle, async () => {
    await api(`/api/aliases/${a.id}`, { method: 'PATCH', body: { status: a.status === 'active' ? 'blocked' : 'active' } });
    toast(a.status === 'active' ? 'Alias blocked — future mail to it will be quarantined' : 'Alias reactivated', 'success'); reload();
  }));

  const senderRows = a.senders.map(s => {
    const blocked = a.blocked_senders.includes(s.from_domain);
    const btn = button(blocked ? 'Unblock' : 'Block sender', { kind: blocked ? 'secondary' : 'danger', size: 'sm', onClick: async () => {
      await api(`/api/aliases/${a.id}`, { method: 'PATCH', body: blocked ? { unblockSender: s.from_domain } : { blockSender: s.from_domain } });
      toast(blocked ? 'Sender unblocked' : `Mail from ${s.from_domain} to this alias will be quarantined`, 'success'); reload();
    } });
    return h('tr', {},
      h('td', {}, h('b', {}, s.from_domain)), h('td', {}, s.n), h('td', {}, fmtDate(s.first_seen)),
      h('td', {}, s.leak ? h('span', { class: 'badge st-bad' }, 'leak') : h('span', { class: 'badge st-ok' }, 'legit')),
      h('td', { style: { textAlign: 'right' } }, real ? null : btn));
  });

  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, button('Identities', { kind: 'ghost', size: 'sm', onClick: () => go('/identities') })),
    h('div', { class: 'card card-pad' },
      h('div', { class: 'row wrap' },
        h('div', { class: 'avatar', style: { width: '44px', height: '44px', fontSize: '17px' } }, (a.site_domain || '?')[0]),
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'row wrap' }, h('h2', { class: 'mono', style: { fontSize: '17px' } }, shown(a.address)), tierBadge(a.tier), statusBadge(a.status)),
          h('div', { class: 'muted small' }, `Issued to ${a.site_domain || '—'} on ${fmtDate(a.created_at, true)}${a.expires_at ? ` · expires ${fmtDate(a.expires_at, true)}` : ''}`)),
        h('div', { class: 'spacer' }),
        real ? null : button('Copy', { ico: 'copy', onClick: () => copy(a.address) }),
        a.sid ? button('Site report', { ico: 'globe', onClick: () => go(`/sites/${a.sid}`) }) : null,
        button('Erasure request', { ico: 'doc', onClick: () => openErasureComposer({ aliasId: a.id }) }),
        real || a.status === 'expired' ? null : toggle),
      a.leaks.length ? h('div', { class: 'note warn', style: { marginTop: '14px' } }, h('b', {}, `${a.leaks.length} leak${a.leaks.length > 1 ? 's' : ''} attributed to ${a.site_domain}: `), a.leaks.map(l => l.sender_domain).join(', ')) : null),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Who has emailed this identity')),
        a.senders.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Sender', 'Msgs', 'First seen', 'Verdict', ''].map(t => h('th', {}, t)))), h('tbody', {}, senderRows)))
          : empty('No mail yet', real ? 'Real-identity disclosures are recorded but not monitored as aliases.' : 'Sign up with this alias — its first email will appear here after the next sync.')),
      h('div', { class: 'card card-pad' }, h('h3', { style: { fontSize: '14.5px', marginBottom: '10px' } }, 'Notes'),
        (() => { const t = h('textarea', { class: 'input', style: { fontFamily: 'var(--font)', minHeight: '90px' }, value: a.note || '', placeholder: 'e.g. used for the Diwali sale account' });
          const save = button('Save note', { size: 'sm', onClick: async () => { await api(`/api/aliases/${a.id}`, { method: 'PATCH', body: { note: t.value } }); toast('Saved', 'success'); } });
          return h('div', { class: 'stack' }, t, h('div', {}, save)); })())),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Messages'), h('span', { class: 'sub' }, 'headers only — bodies are never downloaded')),
      a.messages.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Received', 'From', 'Subject', 'Auth', 'Verdict'].map(t => h('th', {}, t)))),
        h('tbody', {}, a.messages.map(m => h('tr', {},
          h('td', { class: 'small' }, fmtDate(m.received_at, true)),
          h('td', {}, h('div', { class: 'cell-main' }, m.from_name || m.from_addr), h('div', { class: 'cell-sub' }, m.from_addr)),
          h('td', {}, h('div', { class: 'trunc' }, m.subject || '(no subject)'), h('div', { class: 'cell-sub trunc', title: m.reason }, m.reason)),
          h('td', { class: 'small' }, m.auth ? `SPF ${m.auth.spf || '—'} · DKIM ${m.auth.dkim?.[0]?.result || '—'} · DMARC ${m.auth.dmarc || '—'}` : '—'),
          h('td', {}, classBadge(m.classification, m.quarantined), m.in_spam ? h('div', { class: 'cell-sub' }, 'in spam') : null))))))
        : empty('No messages', 'Nothing has been delivered to this identity yet.')));
}
