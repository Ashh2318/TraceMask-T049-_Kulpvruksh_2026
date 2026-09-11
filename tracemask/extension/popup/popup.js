// TraceMask popup: risk of the current site, its alias, and recent leaks.
const $ = (s) => document.querySelector(s);
const main = $('#main');
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r)));

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return e;
}
const show = (...nodes) => main.replaceChildren(...nodes);
const loading = (t) => show(el('div', { class: 'loading' }, el('span', { class: 'spin' }), t));
function setState(text, cls = '') { const s = $('#state'); s.textContent = text; s.className = `pill ${cls}`; }

$('#open-app').addEventListener('click', () => { send({ type: 'openApp', hash: '' }); window.close(); });
$('#open-opts').addEventListener('click', () => { send({ type: 'openOptions' }); window.close(); });

async function activeTab() {
  const q = new URLSearchParams(location.search);
  if (q.get('url')) return { id: Number(q.get('tabId')) || null, url: q.get('url') }; // used by automated tests
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || {};
}

function pairingView(server, error) {
  const srv = el('input', { class: 'inp', value: server || 'http://localhost:4390', spellcheck: 'false' });
  const code = el('input', { class: 'inp code', placeholder: 'XXXX-XXXX', maxlength: '9', autocomplete: 'off', spellcheck: 'false' });
  const go = el('button', { class: 'btn wide', type: 'submit' }, 'Pair with TraceMask');
  const err = el('div', { class: 'msg err', hidden: !error }, error || '');
  const form = el('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault(); go.disabled = true; err.hidden = true;
    const r = await send({ type: 'pair', server: srv.value, code: code.value });
    go.disabled = false;
    if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
    render();
  } },
  el('h3', {}, 'Connect this browser'),
  el('ol', { class: 'steps' }, el('li', {}, 'Start the TraceMask app and unlock it.'), el('li', {}, 'Open Settings → Browser extension → Generate pairing code.'), el('li', {}, 'Type the 8-character code below.')),
  el('label', {}, 'Pairing code', code), el('label', {}, 'TraceMask address', srv), err, go);
  setState('Not paired');
  show(form);
  setTimeout(() => code.focus(), 50);
}

function riskCard(site) {
  if (!site || site.score == null) return el('div', { class: 'risk' }, el('div', { class: 'score lv-unknown' }, '?'),
    el('div', {}, el('b', {}, 'Not checked yet'), el('div', { class: 'muted' }, 'Scan it before you sign up.')));
  return el('div', { class: 'risk' }, el('div', { class: `score lv-${site.level}` }, String(site.score)),
    el('div', {}, el('b', {}, `${site.level} risk`),
      el('div', { class: 'muted' }, [site.breaches != null ? `${site.breaches} breach${site.breaches === 1 ? '' : 'es'}` : null, site.trackers != null ? `${site.trackers} tracker${site.trackers === 1 ? '' : 's'}` : null, site.coverage != null ? `${site.coverage}% verified` : null].filter(Boolean).join(' · '))));
}

const PURPOSES = [['oneoff', 'One-time', 'download, trial'], ['regular', 'Regular', 'shop, newsletter'], ['critical', 'Recoverable', 'must reset password'], ['kyc', 'Bank / KYC', 'real identity']];

async function mainView(tab, status) {
  const n = status.openLeaks || 0;
  setState(n ? `${n} open leak${n > 1 ? 's' : ''}` : 'Protected', n ? 'bad' : 'ok');
  const nodes = [];
  const isWeb = /^https?:\/\//.test(tab.url || '') && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(tab.url);
  if (!isWeb) {
    nodes.push(el('div', { class: 'msg info' }, 'Open a website’s sign-up page to check its risk and fill a TraceMask alias.'));
  } else {
    const look = await send({ type: 'lookup', url: tab.url });
    if (!look.ok) nodes.push(el('div', { class: 'msg err' }, look.error));
    else nodes.push(siteCard(tab, look.data));
  }
  const leaks = await send({ type: 'leaks' });
  if (leaks.ok) nodes.push(leakCard(leaks.data));
  show(...nodes);
}

function siteCard(tab, d, purpose = 'regular', note, warn) {
  const card = el('div', { class: 'card' });
  const host = new URL(tab.url).hostname;
  const active = d.aliases.filter(a => a.status === 'active' && a.tier < 3);
  // Letter avatar instead of a remote favicon: the popup never tells a third party which site you are on.
  const fav = el('span', { class: 'av', 'aria-hidden': 'true' }, (d.domain || host).charAt(0).toUpperCase());
  const kids = [el('div', { class: 'site' }, fav, el('div', {}, el('b', {}, d.domain), d.openLeaks ? el('div', {}, el('span', { class: 'tag bad' }, `${d.openLeaks} leak${d.openLeaks > 1 ? 's' : ''} from this site`)) : null)), riskCard(d.site)];
  if (d.site?.findings?.length) kids.push(el('ul', { class: 'finds' }, d.site.findings.slice(0, 3).map(f => el('li', {}, f.detail))));
  const scanBtn = el('button', { class: 'btn sec', onclick: async () => {
    scanBtn.disabled = true; scanBtn.textContent = 'Scanning…';
    const r = await send({ type: 'scan', url: tab.url });
    if (!r.ok) { scanBtn.disabled = false; scanBtn.textContent = 'Retry scan'; card.append(el('div', { class: 'msg err' }, r.error)); return; }
    card.replaceWith(siteCard(tab, { ...d, site: r.data.site, recommendations: r.data.recommendations }, purpose));
  } }, d.site?.score == null ? 'Scan site now' : 'Rescan');
  if (note) kids.push(el('div', { class: 'msg ok' }, note));
  if (warn) kids.push(el('div', { class: 'msg info' }, warn));
  if (active.length) {
    for (const a of active.slice(0, 2)) {
      kids.push(el('div', { class: 'muted' }, `Your alias here`), el('div', { class: 'alias' }, a.address),
        el('div', { class: 'row' }, el('span', { class: 'tag' }, `T${a.tier} ${a.tierName}`), a.leaks ? el('span', { class: 'tag bad' }, `${a.leaks} leak${a.leaks > 1 ? 's' : ''}`) : el('span', { class: 'tag muted' }, 'no leaks'),
          el('span', { class: 'grow' }), el('button', { class: 'btn', onclick: () => fill(tab, a.address) }, 'Fill'), el('button', { class: 'btn sec', onclick: () => copy(a.address) }, 'Copy')));
    }
    kids.push(el('div', { class: 'row' }, scanBtn));
  } else {
    const rec = d.recommendations[purpose];
    const create = el('button', { class: 'btn', onclick: async () => {
      create.disabled = true; create.textContent = d.site?.score == null ? 'Checking site…' : 'Creating…';
      const r = await send({ type: 'createAlias', url: tab.url, purpose });
      if (!r.ok) { create.disabled = false; create.textContent = 'Try again'; card.append(el('div', { class: 'msg err' }, r.error)); return; }
      const look = await send({ type: 'lookup', url: tab.url });
      const filled = await fill(tab, r.data.alias.address, true);
      card.replaceWith(siteCard(tab, look.ok ? look.data : d, purpose,
        r.data.alias.realIdentity ? 'Real identity recorded for this site.' : (filled ? 'Alias created and filled into the sign-up form.' : 'Alias created and copied. Paste it into the email field.'),
        r.data.scanError ? `The live site check could not finish (${r.data.scanError}). Your alias is monitored anyway; try "Scan site now" later.` : null));
    } }, purpose === 'kyc' ? 'Use my real email' : 'Create alias & fill');
    kids.push(el('div', { class: 'muted' }, 'What is this sign-up for?'),
      el('div', { class: 'chips' }, PURPOSES.map(([k, t, s]) => el('button', { class: `chip${k === purpose ? ' on' : ''}`, onclick: () => card.replaceWith(siteCard(tab, d, k)) }, el('b', {}, t), el('span', {}, s)))),
      el('div', { class: 'rec' }, el('b', {}, `Recommended: T${rec.tier} ${rec.name}. `), rec.reasons[0]),
      el('div', { class: 'row' }, create, scanBtn));
  }
  card.append(...kids);
  return card;
}

function leakCard(leaks) {
  return el('div', { class: 'card' }, el('h3', {}, leaks.length ? `Open leaks (${leaks.length})` : 'Leaks'),
    leaks.length ? leaks.slice(0, 3).map(l => el('div', { class: 'leak' }, el('span', { class: 'dot' }),
      el('div', {}, el('b', {}, l.site_domain), ` leaked to `, el('b', {}, l.sender_domain), el('small', {}, l.address))))
      : el('div', { class: 'muted' }, 'No open leaks. Every alias email so far came from the right site.'),
    leaks.length ? el('button', { class: 'link', onclick: () => { send({ type: 'openApp', hash: '#/leaks' }); window.close(); } }, 'Open Leak Center →') : null);
}

async function fill(tab, value, quiet) {
  if (!tab.id) { await copy(value); return false; }
  const r = await send({ type: 'fillTab', tabId: tab.id, value });
  if (!r.ok || !r.data?.filled) { await copy(value, quiet); return false; }
  if (!quiet) window.close();
  return true;
}
async function copy(text, quiet) { try { await navigator.clipboard.writeText(text); if (!quiet) setState('Copied', 'ok'); } catch { /* ignore */ } }

async function render() {
  loading('Connecting to TraceMask…');
  const tab = await activeTab();
  const st = await send({ type: 'status' });
  if (!st.ok) {
    if (st.code === 'not_paired') return pairingView(null, st.error);
    setState(st.code === 'offline' ? 'Offline' : 'Error', 'warn');
    return show(el('div', { class: 'msg err' }, st.error),
      el('div', { class: 'card' }, el('h3', {}, 'Start TraceMask'), el('div', { class: 'muted' }, 'Double-click start.bat in the TraceMask folder (or run npm start), then try again.'),
        el('button', { class: 'btn', onclick: render }, 'Retry')));
  }
  const s = st.data;
  if (!s.paired) return pairingView(s.server);
  $('#sub').textContent = s.mailbox?.address ? `Protecting ${s.mailbox.address}` : 'Identity firewall';
  if (!s.unlocked) {
    setState('Locked', 'warn');
    return show(el('div', { class: 'msg info' }, 'TraceMask is locked. Unlock it with your master password to scan sites and create aliases.'),
      el('button', { class: 'btn wide', onclick: () => { send({ type: 'openApp', hash: '' }); window.close(); } }, 'Open TraceMask to unlock'));
  }
  if (!s.mailbox) {
    setState('Setup', 'warn');
    return show(el('div', { class: 'msg info' }, 'Connect your mailbox in TraceMask so every alias is monitored for leaks.'),
      el('button', { class: 'btn wide', onclick: () => { send({ type: 'openApp', hash: '' }); window.close(); } }, 'Open TraceMask'));
  }
  mainView(tab, s);
}
render();
