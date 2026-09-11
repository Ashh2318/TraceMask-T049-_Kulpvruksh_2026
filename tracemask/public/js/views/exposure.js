import { h, api, icon, ago, num, button, empty } from '../lib.js';
import { go } from '../app.js';
import { openErasureComposer } from './requests.js';

export async function exposureView() {
  const d = await api('/api/exposure');
  const orgs = d.organisations;
  const max = Math.max(1, ...orgs.map(o => o.messages));
  const q = h('input', { class: 'input', placeholder: 'Filter organisations…', style: { maxWidth: '300px' } });
  const body = h('tbody');
  const draw = () => {
    const t = q.value.toLowerCase();
    const list = orgs.filter(o => !t || o.domain.includes(t) || String(o.name || '').toLowerCase().includes(t));
    body.replaceChildren(...list.map(o => h('tr', {},
      h('td', {}, h('div', { class: 'cell-main' }, o.name || o.domain), h('div', { class: 'cell-sub' }, o.domain)),
      h('td', {}, h('div', { class: 'row' }, h('div', { class: 'bar', style: { width: '120px' } }, h('div', { style: { width: `${(o.messages / max) * 100}%` } })), h('span', { class: 'small' }, num(o.messages)))),
      h('td', { class: 'small' }, ago(o.first_seen), h('div', { class: 'cell-sub' }, `last ${ago(o.last_seen)}`)),
      h('td', {}, o.marketing ? h('span', { class: 'badge st-warn' }, 'marketing') : h('span', { class: 'badge st-muted' }, 'transactional'), o.spam ? h('span', { class: 'badge st-bad', style: { marginLeft: '4px' } }, `${o.spam} in spam`) : null),
      h('td', {}, o.protected ? h('span', { class: 'badge st-ok' }, 'alias created') : h('span', { class: 'badge st-bad' }, 'real address')),
      h('td', { style: { textAlign: 'right' } }, h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        o.protected ? null : button('Move to alias', { size: 'sm', ico: 'mask', onClick: () => go(`/protect?url=${encodeURIComponent(o.domain)}`) }),
        button(o.erasureRequested ? 'Requested' : 'Erase', { size: 'sm', kind: 'ghost', ico: 'doc', onClick: () => openErasureComposer({ domain: o.domain }) }))))));
    if (!list.length) body.replaceChildren(h('tr', {}, h('td', { colspan: 6 }, empty(orgs.length ? 'No match' : 'Nothing mapped yet', orgs.length ? '' : 'The first mailbox sync builds this map from the senders of mail to your real address.'))));
  };
  q.addEventListener('input', draw); draw();

  return h('div', { class: 'stack' },
    h('div', { class: 'note' }, h('b', {}, `Who holds ${d.address}? `), `Built from the headers of mail delivered to your real address in the last ${d.lookbackDays} days (inbox + spam). Each organisation below has your real identity on file — move the ones you still use to an alias and ask the rest to erase it.`),
    h('div', { class: 'grid g3' },
      h('div', { class: 'card kpi bad' }, h('div', { class: 'label' }, icon('map', 15), 'Organisations with your real address'), h('div', { class: 'value' }, num(d.totals.organisations))),
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, icon('mail', 15), 'Sending marketing'), h('div', { class: 'value' }, num(d.totals.marketing)), h('div', { class: 'hint' }, 'have a List-Unsubscribe header')),
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, icon('ban', 15), 'Landing in spam'), h('div', { class: 'value' }, num(d.totals.spamSenders)), h('div', { class: 'hint' }, `${num(d.individualSenders)} messages from individuals excluded`))),
    h('div', { class: 'row' }, q),
    h('div', { class: 'card table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Organisation', 'Messages', 'First seen', 'Type', 'Status', ''].map(t => h('th', {}, t)))), body)));
}
