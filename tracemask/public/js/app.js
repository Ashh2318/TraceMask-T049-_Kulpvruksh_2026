import { h, api, icon, toast, $ } from './lib.js';
import { authView } from './views/auth.js';
import { onboardingView } from './views/onboarding.js';
import { dashboardView } from './views/dashboard.js';
import { protectView } from './views/protect.js';
import { identitiesView, aliasDetailView } from './views/identities.js';
import { leaksView } from './views/leaks.js';
import { exposureView } from './views/exposure.js';
import { requestsView } from './views/requests.js';
import { sitesView, siteDetailView } from './views/sites.js';
import { settingsView } from './views/settings.js';

const root = document.getElementById('root');
export const state = { mailbox: null, openLeaks: 0, events: null };

const ROUTES = [
  { path: /^\/?$|^\/dashboard$/, view: dashboardView, title: 'Dashboard', nav: 'dashboard' },
  { path: /^\/protect$/, view: protectView, title: 'Protect a sign-up', nav: 'protect' },
  { path: /^\/identities$/, view: identitiesView, title: 'Identities', nav: 'identities' },
  { path: /^\/identities\/(\d+)$/, view: aliasDetailView, title: 'Identity', nav: 'identities' },
  { path: /^\/leaks$/, view: leaksView, title: 'Leak Center', nav: 'leaks' },
  { path: /^\/exposure$/, view: exposureView, title: 'Exposure Map', nav: 'exposure' },
  { path: /^\/requests$/, view: requestsView, title: 'Erasure Requests', nav: 'requests' },
  { path: /^\/sites$/, view: sitesView, title: 'Site Reports', nav: 'sites' },
  { path: /^\/sites\/(\d+)$/, view: siteDetailView, title: 'Site Report', nav: 'sites' },
  { path: /^\/settings$/, view: settingsView, title: 'Settings', nav: 'settings' }
];

const NAV = [
  ['dashboard', 'Dashboard', 'dash'], ['protect', 'Protect a sign-up', 'plus'],
  ['label', 'Monitor'], ['identities', 'Identities', 'mask'], ['leaks', 'Leak Center', 'alert'], ['exposure', 'Exposure Map', 'map'],
  ['label', 'Act'], ['requests', 'Erasure Requests', 'doc'], ['sites', 'Site Reports', 'globe'], ['settings', 'Settings', 'gear']
];

export const go = (path) => { location.hash = '#' + path; };
export const rerender = () => render();

async function boot() {
  let st;
  try { st = await api('/api/status'); } catch { root.replaceChildren(h('div', { class: 'loading' }, 'Cannot reach the TraceMask server.')); return; }
  if (!st.initialized || !st.unlocked) return root.replaceChildren(authView(st.initialized, boot));
  const mb = await api('/api/mailbox');
  state.mailbox = mb.connected ? mb : null;
  if (!state.mailbox) return root.replaceChildren(onboardingView(boot));
  renderShell();
  connectEvents();
  window.onhashchange = render;
  render();
}

let shell;
function renderShell() {
  const navEl = h('nav', { class: 'nav' }, NAV.map(([key, label, ic]) => key === 'label'
    ? h('div', { class: 'nav-label' }, label)
    : h('a', { href: `#/${key}`, 'data-nav': key }, icon(ic), h('span', {}, label), key === 'leaks' ? h('span', { class: 'count', id: 'leak-count', hidden: true }) : null)));
  const syncPill = h('span', { class: 'pill', id: 'sync-pill' }, h('span', { class: 'dot' }), 'Mailbox');
  const syncBtn = h('button', { class: 'btn btn-secondary btn-sm', id: 'sync-btn', onClick: syncNow }, icon('sync', 15), h('span', {}, 'Sync now'));
  const lockBtn = h('button', { class: 'btn btn-ghost btn-sm', onClick: lockVault, title: 'Lock vault' }, icon('lock', 15), h('span', {}, 'Lock'));
  shell = h('div', { class: 'shell' },
    h('aside', { class: 'side' },
      h('div', { class: 'logo' }, h('div', { class: 'logo-mark' }, icon('mask', 20)), h('div', {}, h('b', {}, 'TraceMask'), h('small', {}, 'Identity firewall'))),
      navEl,
      h('div', { class: 'side-foot' }, h('div', { class: 'muted' }, 'Protecting'), h('div', { class: 'addr' }, state.mailbox.base_address),
        h('div', { class: 'muted', style: { marginTop: '6px' } }, state.mailbox.alias_mode === 'domain' ? `Aliases on @${state.mailbox.alias_domain}` : 'Plus-address aliases'))),
    h('div', { class: 'main' },
      h('header', { class: 'top' }, h('h1', { id: 'page-title' }, ''), h('div', { class: 'spacer' }), syncPill, syncBtn, lockBtn),
      h('main', { class: 'content', id: 'content' })));
  root.replaceChildren(shell);
  refreshStatus();
  setInterval(refreshStatus, 30000);
}

export async function refreshStatus() {
  try {
    const d = await api('/api/dashboard');
    state.openLeaks = d.kpis.openLeaks;
    const c = $('#leak-count'); if (c) { c.textContent = d.kpis.openLeaks; c.hidden = !d.kpis.openLeaks; }
    const pill = $('#sync-pill');
    if (pill && d.mailbox) {
      const cls = d.syncing ? 'live' : d.mailbox.lastSyncStatus === 'error' ? 'bad' : d.mailbox.lastSyncAt ? 'ok' : 'warn';
      const { ago } = await import('./lib.js');
      pill.replaceChildren(h('span', { class: `dot ${cls}` }), d.syncing ? 'Syncing…' : d.mailbox.lastSyncStatus === 'error'
        ? 'Sync error' : d.mailbox.lastSyncAt ? `Synced ${ago(d.mailbox.lastSyncAt)}` : 'Not synced yet');
      pill.title = d.mailbox.lastSyncError || '';
    }
    return d;
  } catch { return null; }
}

async function syncNow() {
  const btn = $('#sync-btn');
  btn.disabled = true; btn.classList.add('busy');
  try {
    const r = await api('/api/sync', { method: 'POST' });
    toast(`Synced ${r.scanned} new message(s) · ${r.aliasMessages} to aliases · ${r.newLeaks.length} new leak(s)${r.quarantined ? ` · ${r.quarantined} quarantined` : ''}`, r.newLeaks.length ? 'leak' : 'success');
    render();
  } catch (e) { toast(e.message, 'error', 8000); }
  finally { btn.disabled = false; btn.classList.remove('busy'); refreshStatus(); }
}

async function lockVault() {
  await api('/api/vault/lock', { method: 'POST' });
  state.events?.close();
  location.hash = '';
  boot();
}

function connectEvents() {
  state.events?.close();
  const es = new EventSource('/api/events');
  state.events = es;
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'sync.started') refreshStatus();
    if (e.type === 'sync.finished') {
      for (const l of e.newLeaks) toast(h('div', {}, h('b', {}, l.severity === 'review' ? 'Lookalike sender: ' : 'Leak detected: '), `${l.sender} emailed the alias you gave ${l.site}`), 'leak', 9000);
      refreshStatus();
      if (e.scanned && ['dashboard', 'leaks', 'identities'].includes(currentNav)) render();
    }
    if (e.type === 'sync.error') refreshStatus();
  };
}

let currentNav = '';
async function render() {
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/dashboard';
  const route = ROUTES.find(r => r.path.test(path)) || ROUTES[0];
  const params = path.match(route.path).slice(1);
  currentNav = route.nav;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === route.nav));
  if (window.innerWidth <= 900) document.querySelector('[data-nav].active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  $('#page-title').textContent = route.title;
  document.title = `${route.title} · TraceMask`;
  const content = $('#content');
  content.replaceChildren(h('div', { class: 'loading' }, 'Loading'));
  try {
    const view = await route.view(...params);
    if (currentNav === route.nav) content.replaceChildren(view);
  } catch (e) {
    content.replaceChildren(h('div', { class: 'err' }, e.message));
  }
}

window.addEventListener('tm:locked', () => { state.events?.close(); boot(); });
boot();
