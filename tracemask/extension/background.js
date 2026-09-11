// TraceMask extension: service worker.
// Talks ONLY to the user's local TraceMask app (http://localhost:4390 by default) using a per-browser
// bearer token obtained by pairing. Page content never leaves the browser; only the address of the page
// the user acts on is sent to the local app.

const DEFAULTS = { server: 'http://localhost:4390', token: null, deviceName: null, inline: true, notify: true, seenLeaks: [] };
const SERVER_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{2,5})?$/;
const WEB_TAB = ['https://*/*', 'http://*/*'];
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//;
const isWebPage = (url) => /^https?:\/\//.test(url || '') && !LOCAL_RE.test(url);

const getCfg = () => chrome.storage.local.get(DEFAULTS);
// Keep the pairing token out of content scripts where the browser supports restricting storage access.
try { chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch?.(() => {}); } catch { /* older Chrome */ }

class ExtError extends Error { constructor(code, message) { super(message || code); this.code = code; } }

async function api(path, { method = 'GET', body, token: tokenOverride, server: serverOverride, timeout = 45000 } = {}) {
  const cfg = await getCfg();
  const server = serverOverride || cfg.server;
  const token = tokenOverride === undefined ? cfg.token : tokenOverride;
  if (!SERVER_RE.test(server)) throw new ExtError('bad_server', 'Server address must be http://localhost or http://127.0.0.1');
  if (!token && !path.endsWith('/pair')) throw new ExtError('not_paired', 'Pair the extension with TraceMask first');
  let res;
  try {
    res = await fetch(server + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeout)
    });
  } catch (e) {
    throw new ExtError(e?.name === 'TimeoutError' ? 'timeout' : 'offline', e?.name === 'TimeoutError' ? 'TraceMask took too long to answer. Try again.' : 'TraceMask app is not running on this computer');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.endsWith('/pair')) {
    await chrome.storage.local.set({ token: null, deviceName: null });
    broadcastInline(false);
    throw new ExtError('not_paired', 'This browser is no longer paired with TraceMask. Pair it again.');
  }
  if (res.status === 423) throw new ExtError('locked', 'TraceMask is locked');
  if (!res.ok) throw new ExtError(res.status === 429 ? 'busy' : 'api', data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------- badge + leak notifications ----------------
// One refresh at a time: the alarm, the popup and alias creation can all ask for one at once. A request that
// arrives during a refresh schedules one more pass, so the badge always reflects the latest state.
let badgeRun = null, badgeAgain = false;
function refreshBadge() {
  if (badgeRun) { badgeAgain = true; return badgeRun; }
  badgeRun = (async () => {
    do { badgeAgain = false; await updateBadge(); } while (badgeAgain);
  })().finally(() => { badgeRun = null; });
  return badgeRun;
}
async function updateBadge() {
  const cfg = await getCfg();
  try {
    if (!cfg.token) { await setBadge('', '#6b7280', 'TraceMask: not paired yet'); return; }
    const st = await api('/api/ext/status', { timeout: 8000 });
    if (!st.unlocked) { await setBadge('LOCK', '#6b7280', 'TraceMask is locked'); return; }
    const n = st.openLeaks || 0;
    await setBadge(n ? String(n > 99 ? '99+' : n) : '', '#d92d4b', n ? `TraceMask: ${n} open leak${n > 1 ? 's' : ''}` : 'TraceMask: protected');
    if (n && cfg.notify) await notifyNewLeaks();
  } catch (e) {
    const off = e.code === 'offline';
    await setBadge(off ? 'OFF' : '', '#6b7280', off ? 'TraceMask app is not running' : 'TraceMask');
  }
}
async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}
async function notifyNewLeaks() {
  const { seenLeaks } = await getCfg();
  const leaks = await api('/api/ext/leaks');
  const seen = new Set(seenLeaks);
  const fresh = leaks.filter(l => !seen.has(l.id));
  for (const l of fresh.slice(0, 3)) {
    await chrome.notifications.create(`leak-${l.id}`, {
      type: 'basic', iconUrl: 'icons/icon-128.png', priority: 2,
      title: l.severity === 'review' ? 'TraceMask: lookalike sender' : 'TraceMask: leak detected',
      message: `${l.sender_domain} emailed the alias you gave only to ${l.site_domain}.`,
      contextMessage: l.address
    });
  }
  await chrome.storage.local.set({ seenLeaks: [...new Set([...leaks.map(l => l.id), ...seen])].slice(0, 300) });
}
chrome.notifications.onClicked.addListener(async (id) => {
  if (id.startsWith('leak-')) await openApp('#/leaks');
  chrome.notifications.clear(id);
});

async function openApp(hash = '') {
  const { server } = await getCfg();
  const safeHash = /^#\/[a-z-]{0,30}$/.test(hash) ? hash : '';
  const url = `${server}/${safeHash}`;
  const tabs = await chrome.tabs.query({ url: `${server}/*` });
  if (tabs[0]) { await chrome.tabs.update(tabs[0].id, { active: true, url }); await chrome.windows.update(tabs[0].windowId, { focused: true }); }
  else await chrome.tabs.create({ url });
}

// ---------------- content script delivery ----------------
// Pages that were already open when the extension was installed or updated get the content script injected,
// so nobody has to reload their tabs.
async function injectInto(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content/content.js'] });
}
async function injectIntoOpenTabs() {
  for (const t of await chrome.tabs.query({ url: WEB_TAB })) {
    if (!isWebPage(t.url) || t.discarded) continue;
    injectInto(t.id).catch(() => { /* restricted pages (web store, PDF viewer) */ });
  }
}
async function sendToTab(tabId, msg, frameId = 0) {
  try { return await chrome.tabs.sendMessage(tabId, msg, { frameId }); }
  catch {
    const tab = await chrome.tabs.get(tabId);
    if (!isWebPage(tab.url)) throw new ExtError('api', 'Open a website to use TraceMask there.');
    await injectInto(tabId);
    return chrome.tabs.sendMessage(tabId, msg, { frameId });
  }
}
function broadcastInline(on) {
  chrome.tabs.query({ url: WEB_TAB }).then((tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'tm:inline', on }).catch(() => {});
  });
}

// ---------------- context menu + keyboard shortcut: fill the alias ----------------
function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'tm-fill', title: 'Fill TraceMask alias for this site', contexts: ['editable'], documentUrlPatterns: WEB_TAB });
    chrome.contextMenus.create({ id: 'tm-scan', title: 'Check this site with TraceMask', contexts: ['page'], documentUrlPatterns: WEB_TAB });
  });
}
async function aliasForSite(url, purpose = 'regular') {
  const look = await api('/api/ext/lookup', { method: 'POST', body: { url } });
  if (!look.mailbox) throw new ExtError('api', 'Connect your mailbox in TraceMask first, so aliases can be monitored.');
  const active = look.aliases.find(a => a.status === 'active' && a.tier < 3);
  if (active) return { alias: active, created: false };
  const made = await api('/api/ext/alias', { method: 'POST', body: { url, purpose }, timeout: 60000 });
  refreshBadge();
  return { alias: made.alias, created: true };
}
async function fillFor(tab, target, frameId = 0) {
  if (!tab?.id || !isWebPage(tab.url)) return;
  try {
    await sendToTab(tab.id, { type: 'tm:toast', text: 'TraceMask: getting your alias for this site…', kind: 'ok' }, frameId).catch(() => {});
    const { alias, created } = await aliasForSite(tab.url);
    await sendToTab(tab.id, { type: 'tm:fill', value: alias.address, target, toast: created ? 'New alias created for this site and filled' : 'Your alias for this site was filled' }, frameId);
  } catch (e) {
    await sendToTab(tab.id, { type: 'tm:toast', text: humanError(e), kind: 'error' }, frameId).catch(() => {});
  }
}
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'tm-fill') return fillFor(tab, 'active', info.frameId || 0);
  if (info.menuItemId === 'tm-scan') {
    try { await chrome.action.openPopup(); return; } catch { /* not supported here: scan and show the result on the page */ }
    try {
      await sendToTab(tab.id, { type: 'tm:toast', text: 'TraceMask: scanning this site…', kind: 'ok' });
      const r = await api('/api/ext/scan', { method: 'POST', body: { url: tab.url }, timeout: 60000 });
      await sendToTab(tab.id, { type: 'tm:toast', text: `${r.site.domain}: ${r.site.level} risk (${r.site.score}/100). Open the TraceMask icon for details.`, kind: r.site.score >= 50 ? 'error' : 'ok' });
    } catch (e) { await sendToTab(tab.id, { type: 'tm:toast', text: humanError(e), kind: 'error' }).catch(() => {}); }
  }
});
chrome.commands.onCommand.addListener((command, tab) => { if (command === 'fill-alias') fillFor(tab, 'best'); });

// "Chrome (Windows)", "Edge (Windows)"... shown in TraceMask → Settings so the user knows which browser to revoke.
function browserName() {
  const brands = (navigator.userAgentData?.brands || []).map(b => b.brand);
  const browser = brands.find(b => /Edge/.test(b)) ? 'Edge' : brands.find(b => /Opera/.test(b)) ? 'Opera' : brands.find(b => /Brave/.test(b)) ? 'Brave'
    : brands.includes('Google Chrome') ? 'Chrome' : brands.includes('Chromium') ? 'Chromium' : 'Chrome';
  const platform = navigator.userAgentData?.platform || (/(Windows|Mac|Linux|CrOS)/.exec(navigator.userAgent)?.[1]) || 'desktop';
  return `${browser} (${platform})`;
}

function humanError(e) {
  return {
    offline: 'TraceMask app is not running. Start it on this computer (start.bat).',
    locked: 'TraceMask is locked. Open the app and unlock it with your master password.',
    not_paired: 'Pair the extension with TraceMask first (right-click the TraceMask icon → Options).'
  }[e.code] || e.message;
}

// ---------------- message router (popup, options page, content script) ----------------
const handlers = {
  async status() {
    const cfg = await getCfg();
    if (!cfg.token) return { paired: false, server: cfg.server, inline: cfg.inline, notify: cfg.notify };
    const st = await api('/api/ext/status', { timeout: 8000 });
    refreshBadge();
    return { paired: true, server: cfg.server, deviceName: cfg.deviceName, inline: cfg.inline, notify: cfg.notify, ...st };
  },
  async pair({ server, code }) {
    server = String(server || DEFAULTS.server).trim().replace(/\/+$/, '');
    if (!SERVER_RE.test(server)) throw new ExtError('bad_server', 'The address must look like http://localhost:4390');
    const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length !== 8) throw new ExtError('api', 'The pairing code has 8 characters, like ABCD-2345.');
    const r = await api('/api/ext/pair', { method: 'POST', body: { code: clean, name: browserName() }, token: null, server });
    await chrome.storage.local.set({ server, token: r.token, deviceName: r.name, seenLeaks: [] });
    const { inline } = await getCfg();
    broadcastInline(inline);
    refreshBadge();
    return { paired: true, name: r.name };
  },
  async unpair() {
    await api('/api/ext/unpair', { method: 'POST', body: {}, timeout: 5000 }).catch(() => {}); // revoke on the server too
    await chrome.storage.local.set({ token: null, deviceName: null });
    broadcastInline(false);
    refreshBadge();
    return { paired: false };
  },
  async settings({ inline, notify }) {
    const patch = {};
    if (typeof inline === 'boolean') patch.inline = inline;
    if (typeof notify === 'boolean') patch.notify = notify;
    await chrome.storage.local.set(patch);
    if ('inline' in patch) broadcastInline(patch.inline && !!(await getCfg()).token);
    return patch;
  },
  async lookup({ url }, sender) { return api('/api/ext/lookup', { method: 'POST', body: { url: pageUrl(url, sender) } }); },
  async scan({ url }, sender) { return api('/api/ext/scan', { method: 'POST', body: { url: pageUrl(url, sender) }, timeout: 60000 }); },
  async createAlias({ url, purpose, tier }, sender) {
    const r = await api('/api/ext/alias', { method: 'POST', body: { url: pageUrl(url, sender), purpose, tier }, timeout: 60000 });
    refreshBadge(); return r;
  },
  async leaks() { return api('/api/ext/leaks'); },
  async fillTab({ tabId, value }) {
    if (!Number.isInteger(tabId)) throw new ExtError('api', 'No tab to fill');
    return sendToTab(tabId, { type: 'tm:fill', value: String(value), target: 'best', toast: 'Alias filled' });
  },
  async openApp({ hash }) { await openApp(hash || ''); return true; },
  async openOptions() { await chrome.runtime.openOptionsPage(); return true; },
  async inlineEnabled() { const c = await getCfg(); return { inline: c.inline && !!c.token }; }
};
// What a content script (running inside a web page) may ask for. Pairing, settings and leak lists are
// reserved for the extension's own pages.
const CONTENT_ALLOWED = new Set(['lookup', 'scan', 'createAlias', 'openApp', 'openOptions', 'inlineEnabled']);
const fromExtensionPage = (sender) => String(sender.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`);
// Content scripts may only act on the page they run in: their URL comes from the browser, not the message.
function pageUrl(url, sender) { return fromExtensionPage(sender) ? url : sender.url; }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const fn = handlers[msg?.type];
  if (!fn) return false;
  if (!fromExtensionPage(sender) && !CONTENT_ALLOWED.has(msg.type)) { sendResponse({ ok: false, code: 'denied', error: 'Not allowed' }); return false; }
  Promise.resolve(fn(msg, sender)).then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, code: e.code || 'api', error: humanError(e) })
  );
  return true;
});

chrome.runtime.onInstalled.addListener(async (details) => {
  setupMenus();
  chrome.alarms.create('tm-poll', { periodInMinutes: 1 });
  refreshBadge();
  injectIntoOpenTabs();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => { setupMenus(); chrome.alarms.create('tm-poll', { periodInMinutes: 1 }); refreshBadge(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tm-poll') refreshBadge(); });

// Handy from the service-worker console (chrome://extensions → Inspect views) when diagnosing a setup.
globalThis.TraceMask = { refreshBadge, fillFor, injectIntoOpenTabs };
