import { h, api, icon, num, ago, classBadge, button, empty, downloadPdf, toast } from '../lib.js';
import { go } from '../app.js';

const kpi = (label, value, hint, ic, cls = '') => h('div', { class: `card kpi ${cls}` },
  h('div', { class: 'label' }, icon(ic, 15), label), h('div', { class: 'value' }, value), h('div', { class: 'hint' }, hint));

export async function dashboardView() {
  const d = await api('/api/dashboard');
  const k = d.kpis;
  const firstRun = !d.mailbox?.lastSyncAt;

  const header = h('div', { class: 'hero-scan', style: { marginBottom: '18px' } },
    h('div', { class: 'row wrap' },
      h('div', {},
        h('h2', {}, k.openLeaks ? `${k.openLeaks} open leak${k.openLeaks > 1 ? 's' : ''} need your attention` : k.totalAliases ? 'Your identities are being watched' : 'Protect your first sign-up'),
        h('p', { style: { marginBottom: 0 } }, k.totalAliases
          ? `${num(k.activeAliases)} active aliases · ${num(k.aliasMail)} alias messages attributed · ${num(k.exposedOrgs)} organisation${k.exposedOrgs === 1 ? '' : 's'} still hold${k.exposedOrgs === 1 ? 's' : ''} your real address`
          : 'Scan a website before you sign up, get a tracked alias, and TraceMask will tell you if that site ever leaks it.')),
      h('div', { class: 'spacer' }),
      button(k.openLeaks ? 'Open Leak Center' : 'Protect a sign-up', { kind: 'primary', ico: k.openLeaks ? 'alert' : 'plus', size: 'lg', onClick: () => go(k.openLeaks ? '/leaks' : '/protect') })));

  const kpis = h('div', { class: 'grid g4' },
    kpi('Open leaks', num(k.openLeaks), `${num(k.leakingCompanies)} compan${k.leakingCompanies === 1 ? 'y' : 'ies'} caught leaking`, 'alert', k.openLeaks ? 'bad' : ''),
    kpi('Active aliases', num(k.activeAliases), `${num(k.totalAliases)} created in total`, 'mask'),
    kpi('Real-address exposure', num(k.exposedOrgs), 'organisations mailing your real inbox', 'map'),
    kpi('Quarantined', num(k.quarantined), `${num(k.legitMail)} legitimate alias emails delivered`, 'ban', k.quarantined ? 'ok' : ''));

  const leaksCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('alert', 16), h('h3', {}, 'Latest leak attributions'), h('div', { class: 'spacer' }), button('View all', { kind: 'ghost', size: 'sm', onClick: () => go('/leaks') })),
    d.recentLeaks.length ? d.recentLeaks.map(l => h('div', { class: 'feed-item' },
      h('div', { class: 'avatar bad' }, (l.sender_domain || '?')[0]),
      h('div', { style: { minWidth: 0, flex: 1 } },
        h('div', {}, h('b', {}, l.site_domain), h('span', { class: 'muted' }, l.severity === 'review' ? ' — lookalike sender ' : ' leaked to '), h('b', { style: { color: l.severity === 'review' ? 'var(--warn)' : 'var(--bad)' } }, l.sender_domain)),
        h('div', { class: 'cell-sub trunc' }, `${l.address} · ${l.message_count} message(s) · first seen ${ago(l.first_seen)}`)),
      h('span', { class: `badge ${l.status === 'open' ? 'st-bad' : 'st-muted'}` }, l.status)))
      : empty('No leaks detected yet', firstRun ? 'Waiting for the first mailbox sync.' : 'Every message to your aliases so far came from the site it was created for.'));

  const activityCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('inbox', 16), h('h3', {}, 'Alias mail activity'), h('div', { class: 'spacer' }), h('span', { class: 'sub' }, 'live from your mailbox')),
    d.activity.length ? d.activity.map(m => h('div', { class: 'feed-item' },
      h('div', { class: `avatar ${m.classification === 'leak' ? 'bad' : 'ok'}` }, (m.from_domain || '?')[0]),
      h('div', { style: { minWidth: 0, flex: 1 } },
        h('div', { class: 'trunc' }, h('b', {}, m.from_name || m.from_domain), h('span', { class: 'muted' }, ` → ${m.site_domain || 'alias'}`)),
        h('div', { class: 'cell-sub trunc' }, `${m.subject || '(no subject)'} · ${ago(m.received_at)}`)),
      classBadge(m.classification, m.quarantined)))
      : empty('No alias mail yet', 'When a site emails one of your aliases, it appears here with a legit / leak verdict.'));

  const run = d.lastRun;
  const syncCard = h('div', { class: 'card card-pad' },
    h('div', { class: 'row' }, icon('sync', 16), h('h3', { style: { fontSize: '14.5px' } }, 'Monitoring status'), h('div', { class: 'spacer' }), button('Posture report (PDF)', { size: 'sm', ico: 'download', onClick: () => downloadPdf('/api/reports/posture').catch(e => toast(e.message, 'error')) })),
    h('dl', { class: 'kv', style: { marginTop: '12px' } },
      h('dt', {}, 'Mailbox'), h('dd', {}, d.mailbox?.address || '—'),
      h('dt', {}, 'Server'), h('dd', {}, d.mailbox?.host || '—'),
      h('dt', {}, 'Last sync'), h('dd', {}, d.mailbox?.lastSyncAt ? `${ago(d.mailbox.lastSyncAt)} (${d.mailbox.lastSyncStatus})` : 'pending'),
      run ? [h('dt', {}, 'Last run'), h('dd', {}, `${num(run.scanned)} headers read, ${num(run.alias_messages)} alias messages, ${num(run.new_leaks)} new leaks, ${num(run.quarantined)} quarantined`)] : null,
      d.mailbox?.lastSyncError ? [h('dt', {}, 'Error'), h('dd', { style: { color: 'var(--bad)' } }, d.mailbox.lastSyncError)] : null,
      h('dt', {}, 'Sites scanned'), h('dd', {}, `${num(k.sitesScanned)}${k.sitesScanned ? ` · average risk ${k.avgRisk}/100` : ''}`),
      h('dt', {}, 'Erasure requests'), h('dd', {}, `${num(k.openRequests)} open`)));

  return h('div', {}, header, kpis,
    h('div', { class: 'grid g2', style: { marginTop: '16px' } }, leaksCard, activityCard),
    h('div', { class: 'grid g2', style: { marginTop: '16px' } }, syncCard,
      h('div', { class: 'card card-pad' },
        h('div', { class: 'row' }, icon('shield', 16), h('h3', { style: { fontSize: '14.5px' } }, 'How attribution works')),
        h('ol', { class: 'small', style: { color: 'var(--text-2)', paddingLeft: '18px', margin: '10px 0 0' } },
          h('li', {}, 'Every sign-up gets a unique, deliverable alias tied to exactly one site.'),
          h('li', {}, 'TraceMask reads each alias email’s sender and its SPF / DKIM / DMARC results from your provider.'),
          h('li', {}, 'Mail from that site (or domains you trust) is legitimate. Anyone else had to get the alias from that site — that is a leak.'),
          h('li', {}, 'Tracked aliases quarantine leaked mail automatically; you get evidence and an erasure letter.')))));
}
