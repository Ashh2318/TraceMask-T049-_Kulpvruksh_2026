// TraceMask content script: offers a TraceMask alias inside email fields of sign-up forms.
// Runs in Chrome's isolated world. UI lives in a closed shadow root, so the page can neither style nor read it.
// Nothing about the page is sent anywhere except the page URL (to the local TraceMask app) when the user clicks.
(() => {
  if (window.top !== window) return;
  // If an older copy of this script is still attached (extension updated or injected twice), retire it first.
  try { window.__traceMaskTeardown?.(); } catch { /* old copy already gone */ }
  const cleanups = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  function teardown() {
    cleanups.splice(0).forEach((f) => { try { f(); } catch { /* ignore */ } });
    try { document.removeEventListener('mousedown', outside, true); host?.remove(); } catch { /* ignore */ }
    if (window.__traceMaskTeardown === teardown) delete window.__traceMaskTeardown;
  }
  window.__traceMaskTeardown = teardown;

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) resolve({ ok: false, code: 'ext', error: 'TraceMask was updated — reload this page.' });
        else resolve(r || { ok: false, code: 'ext', error: 'No response from TraceMask' });
      });
    } catch { resolve({ ok: false, code: 'ext', error: 'TraceMask was updated — reload this page.' }); }
  });

  // ---------- email field detection ----------
  const EMAIL_HINT = /e-?mail|correo|courriel|ईमेल|mail address|login id/i;
  const NOT_EMAIL = /(otp|code|phone|mobile|search|coupon|promo|captcha|password)/i;
  function labelText(el) {
    let t = '';
    if (el.id) { try { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) t += ' ' + l.textContent; } catch {} }
    const wrap = el.closest('label'); if (wrap) t += ' ' + wrap.textContent;
    return t;
  }
  function isEmailField(el) {
    if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'email') return true;
    if (!['text', ''].includes(type)) return false;
    const hay = [el.name, el.id, el.getAttribute('autocomplete'), el.placeholder, el.getAttribute('aria-label'), labelText(el)].join(' ');
    return EMAIL_HINT.test(hay) && !NOT_EMAIL.test([el.name, el.id, el.getAttribute('autocomplete')].join(' '));
  }
  const FILLABLE = new Set(['email', 'text', '']);
  const fillable = (x) => x instanceof HTMLInputElement && !x.disabled && !x.readOnly && FILLABLE.has((x.getAttribute('type') || 'text').toLowerCase());
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 30 && r.height > 12 && getComputedStyle(el).visibility !== 'hidden'; };

  // ---------- value setting that frameworks (React/Vue/Angular) notice ----------
  function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus({ preventScroll: true });
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function fillAll(primary, value) {
    const prev = primary.value;
    setValue(primary, value);
    // Also fill "confirm email" fields of the same form that are empty or still hold the old value
    const scope = primary.form || document;
    for (const el of scope.querySelectorAll('input')) {
      if (el === primary || !isEmailField(el) || !visible(el)) continue;
      if (!el.value || el.value === prev) setValue(el, value);
    }
    primary.focus({ preventScroll: true });
  }

  // ---------- shadow UI ----------
  let host, root, btn, panel, toastEl, field = null, hideTimer = null, inlineOn = false;
  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif; }
  .tm-btn { position: fixed; width: 24px; height: 24px; border-radius: 7px; border: 0; padding: 0; cursor: pointer;
    background: linear-gradient(135deg,#6366f1,#8b5cf6); box-shadow: 0 2px 6px rgba(79,70,229,.45); display: grid; place-items: center; transition: transform .12s; }
  .tm-btn:hover { transform: scale(1.08); }
  .tm-btn svg { width: 16px; height: 16px; }
  .tm-panel { position: fixed; width: 340px; max-width: calc(100vw - 16px); background: #fff; color: #111827; border-radius: 14px;
    box-shadow: 0 18px 44px -10px rgba(13,18,36,.45), 0 0 0 1px rgba(13,18,36,.08); overflow: hidden; font-size: 13px; line-height: 1.45; }
  .tm-panel.enter { animation: tmIn .14s ease-out; }
  @keyframes tmIn { from { opacity: 0; transform: translateY(-4px); } }
  .hd { display: flex; align-items: center; gap: 9px; padding: 11px 13px; background: #0d1224; color: #fff; }
  .hd .mk { width: 26px; height: 26px; border-radius: 8px; background: linear-gradient(135deg,#6366f1,#8b5cf6); display: grid; place-items: center; flex: none; }
  .hd .mk svg { width: 17px; height: 17px; }
  .hd b { font-size: 13.5px; } .hd small { display: block; color: #a9b1c9; font-size: 11.5px; margin-top: -1px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hd .x { margin-left: auto; background: none; border: 0; color: #a9b1c9; cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 4px; border-radius: 6px; }
  .hd .x:hover { color: #fff; background: rgba(255,255,255,.1); }
  .bd { padding: 13px; display: grid; gap: 10px; }
  .muted { color: #6b7280; font-size: 12px; }
  .risk { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 10px; background: #f6f7fb; }
  .score { width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: 15px; color: #fff; flex: none; }
  .lv-low { background: #0f9d6b; } .lv-moderate { background: #c27803; } .lv-high { background: #d92d4b; } .lv-severe { background: #9f1239; } .lv-unknown { background: #9ca3af; }
  .risk b { text-transform: capitalize; }
  .find { font-size: 11.5px; color: #4b5563; margin-top: 2px; }
  .chips { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .chip { border: 1.5px solid #e4e7ef; background: #fff; border-radius: 9px; padding: 6px 8px; cursor: pointer; text-align: left; font-size: 12px; color: #111827; }
  .chip b { display: block; font-size: 12.5px; } .chip span { color: #6b7280; font-size: 11px; }
  .chip.on { border-color: #4f46e5; background: #eef0ff; }
  .rec { font-size: 12px; background: #eef0ff; color: #3730a3; border-radius: 9px; padding: 7px 9px; }
  .alias { font-family: Consolas, "Cascadia Code", monospace; font-size: 13px; font-weight: 600; color: #3730a3; background: #eef0ff; border: 1.5px dashed #c7cbf7; border-radius: 10px; padding: 9px 10px; word-break: break-all; }
  .row { display: flex; gap: 8px; align-items: center; }
  .btn { border: 0; border-radius: 9px; padding: 9px 12px; font-weight: 700; font-size: 13px; cursor: pointer; background: #4f46e5; color: #fff; flex: 1; }
  .btn:hover { background: #4338ca; } .btn:disabled { opacity: .6; cursor: wait; }
  .btn.sec { background: #fff; color: #111827; border: 1px solid #e4e7ef; flex: none; }
  .btn.sec:hover { background: #f6f7fb; }
  .link { background: none; border: 0; color: #4f46e5; cursor: pointer; font-size: 12px; padding: 0; text-align: left; }
  .tag { display: inline-block; font-size: 11px; font-weight: 700; border-radius: 99px; padding: 1px 8px; background: #eef0ff; color: #4f46e5; }
  .tag.bad { background: #fdebee; color: #d92d4b; }
  .msg { padding: 10px; border-radius: 10px; font-size: 12.5px; }
  .msg.err { background: #fdebee; color: #9f1239; } .msg.ok { background: #e6f6ef; color: #065f46; } .msg.info { background: #f6f7fb; color: #374151; }
  .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid #c7cbf7; border-top-color: #4f46e5; animation: sp .8s linear infinite; flex: none; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .toast { position: fixed; max-width: 360px; background: #0f172a; color: #e5e7eb; border-radius: 10px; padding: 9px 12px; font-size: 12.5px; box-shadow: 0 10px 24px rgba(0,0,0,.25); animation: tmIn .15s ease-out; }
  .toast.error { background: #3b0a14; }
  .ft { display: flex; justify-content: space-between; padding: 8px 13px; border-top: 1px solid #eef0f5; background: #fafbfd; }
  `;
  // The mask icon is built with DOM calls (no innerHTML), so it also works on pages that enforce Trusted Types.
  function maskIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    const svg = mk('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: '#fff', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    svg.append(mk('path', { d: 'M3 8c3-2 15-2 18 0 0 6-3 9-6 9-1.5 0-2-2-3-2s-1.5 2-3 2c-3 0-6-3-6-9z' }),
      mk('circle', { cx: '8.5', cy: '10.5', r: '1.1', fill: '#fff' }), mk('circle', { cx: '15.5', cy: '10.5', r: '1.1', fill: '#fff' }));
    return svg;
  }

  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'svg') e.append(maskIcon());
      else e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return e;
  }
  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('tracemask-ui');
    for (const [k, v] of [['all', 'initial'], ['position', 'fixed'], ['top', '0'], ['left', '0'], ['width', '0'], ['height', '0'], ['z-index', '2147483647']]) host.style.setProperty(k, v, 'important');
    root = host.attachShadow({ mode: 'closed' });
    // Constructable stylesheet: not affected by the page's Content-Security-Policy. <style> is the fallback.
    try { const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); root.adoptedStyleSheets = [sheet]; }
    catch { const st = document.createElement('style'); st.textContent = CSS; root.append(st); }
    document.documentElement.append(host);
  }

  // ---------- inline button ----------
  function placeButton() {
    if (!btn || !field || !field.isConnected) return;
    const r = field.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) { btn.style.display = 'none'; return; }
    btn.style.display = 'grid';
    btn.style.left = `${Math.round(r.right - 30)}px`;
    btn.style.top = `${Math.round(r.top + r.height / 2 - 12)}px`;
    if (panel) placePanel();
  }
  function showButton(target) {
    ensureHost();
    field = target;
    if (!btn) {
      btn = el('button', { class: 'tm-btn', title: 'Use a TraceMask alias for this site', 'aria-label': 'Use a TraceMask alias', svg: true,
        onmousedown: (e) => e.preventDefault(), onclick: (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(); } });
      root.append(btn);
    }
    clearTimeout(hideTimer);
    placeButton();
  }
  function hideButtonSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!panel && btn) btn.style.display = 'none'; }, 250);
  }
  on(document, 'focusin', (e) => {
    if (!alive()) return teardown();
    if (!inlineOn) return;
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (isEmailField(t) && visible(t)) showButton(t);
  }, true);
  on(document, 'focusout', (e) => { if (e.target === field) hideButtonSoon(); }, true);
  on(window, 'scroll', placeButton, { capture: true, passive: true });
  on(window, 'resize', placeButton, { passive: true });

  // ---------- panel ----------
  function placePanel() {
    if (!panel || !field) return;
    const r = field.getBoundingClientRect();
    const w = Math.min(340, innerWidth - 16);
    const h = panel.offsetHeight || 300;
    let top = r.bottom + 8;
    if (top + h > innerHeight - 8 && r.top - h - 8 > 8) top = r.top - h - 8;
    panel.style.top = `${Math.max(8, Math.round(top))}px`;
    panel.style.left = `${Math.round(Math.min(Math.max(8, r.right - w), innerWidth - w - 8))}px`;
  }
  function closePanel() { panel?.remove(); panel = null; document.removeEventListener('mousedown', outside, true); if (field && document.activeElement !== field) hideButtonSoon(); }
  function outside(e) { if (!e.composedPath().includes(host)) closePanel(); }
  function togglePanel() { panel ? closePanel() : openPanel(); }
  on(window, 'keydown', (e) => { if (e.key === 'Escape' && panel) closePanel(); }, true);

  function shell(bodyKids, footer = true) {
    const hostName = location.hostname.replace(/^www\./, '');
    const p = el('div', { class: 'tm-panel', role: 'dialog', 'aria-label': 'TraceMask' },
      el('div', { class: 'hd' }, el('div', { class: 'mk', svg: true }), el('div', {}, el('b', {}, 'TraceMask'), el('small', {}, hostName)),
        el('button', { class: 'x', title: 'Close', onclick: closePanel }, '×')),
      el('div', { class: 'bd' }, bodyKids),
      footer ? el('div', { class: 'ft' },
        el('button', { class: 'link', onclick: () => send({ type: 'openApp', hash: '#/identities' }) }, 'My identities'),
        el('button', { class: 'link', onclick: () => send({ type: 'openApp', hash: '#/leaks' }) }, 'Leak Center')) : null);
    return p;
  }
  function render(bodyKids, footer) {
    ensureHost();
    const next = shell(bodyKids, footer);
    if (panel) panel.replaceWith(next); else { next.classList.add('enter'); document.addEventListener('mousedown', outside, true); }
    panel = next; root.append(panel); placePanel();
  }
  function loading(text) { render([el('div', { class: 'row' }, el('div', { class: 'spin' }), el('span', {}, text))], false); }
  function errorView(res) {
    const actions = {
      offline: ['Retry', openPanel], locked: ['Open TraceMask to unlock', () => send({ type: 'openApp', hash: '' })],
      not_paired: ['Pair the extension', () => send({ type: 'openOptions' })]
    }[res.code] || ['Retry', openPanel];
    render([el('div', { class: 'msg err' }, res.error || 'Something went wrong'), el('div', { class: 'row' }, el('button', { class: 'btn', onclick: actions[1] }, actions[0]))], false);
  }

  async function openPanel() {
    if (!field) return;
    loading('Checking this site…');
    const res = await send({ type: 'lookup', url: location.href });
    if (!res.ok) return errorView(res);
    const d = res.data;
    if (!d.mailbox) return render([el('div', { class: 'msg info' }, 'Connect your mailbox in TraceMask first, so every alias is monitored for leaks.'),
      el('button', { class: 'btn', onclick: () => send({ type: 'openApp', hash: '' }) }, 'Open TraceMask')]);
    const existing = d.aliases.find(a => a.status === 'active' && a.tier < 3);
    if (existing) return existingView(d, existing);
    createView(d);
  }

  function riskBlock(site) {
    if (!site || site.score == null) return el('div', { class: 'risk' }, el('div', { class: 'score lv-unknown' }, '?'),
      el('div', {}, el('b', {}, 'Not checked yet'), el('div', { class: 'find' }, 'TraceMask checks the site automatically when you create an alias.')));
    const f = site.findings.slice(0, 2).map(x => x.label.toLowerCase());
    return el('div', { class: 'risk' }, el('div', { class: `score lv-${site.level}` }, String(site.score)),
      el('div', {}, el('b', {}, `${site.level} risk`), el('div', { class: 'find' }, f.length ? `Main issues: ${f.join(', ')}` : 'No major issues found'),
        site.breaches ? el('div', { class: 'find' }, el('span', { class: 'tag bad' }, `${site.breaches} breach${site.breaches > 1 ? 'es' : ''} on record`)) : null));
  }

  function existingView(d, a) {
    render([
      el('div', { class: 'muted' }, `Your identity for ${d.domain}`),
      el('div', { class: 'alias' }, a.address),
      el('div', { class: 'row' }, el('span', { class: 'tag' }, `T${a.tier} ${a.tierName}`), a.leaks ? el('span', { class: 'tag bad' }, `${a.leaks} leak${a.leaks > 1 ? 's' : ''}`) : el('span', { class: 'muted' }, 'no leaks so far')),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => { fillAll(field, a.address); toast(`Filled your ${d.domain} alias`); closePanel(); } }, 'Fill this alias'),
        el('button', { class: 'btn sec', onclick: () => copy(a.address) }, 'Copy')),
      el('button', { class: 'link', onclick: () => createView(d) }, 'Create a new alias instead')
    ]);
  }

  const PURPOSE_UI = [['oneoff', 'One-time', 'download, trial'], ['regular', 'Regular', 'shop, newsletter'], ['critical', 'Recoverable', 'must reset password'], ['kyc', 'Bank / KYC', 'real identity']];
  function createView(d, purpose = 'regular') {
    const rec = d.recommendations[purpose];
    const chips = el('div', { class: 'chips' }, PURPOSE_UI.map(([k, t, s]) =>
      el('button', { class: `chip${k === purpose ? ' on' : ''}`, onclick: () => createView(d, k) }, el('b', {}, t), el('span', {}, s))));
    const go = el('button', { class: 'btn', onclick: () => create(d, purpose, go) }, purpose === 'kyc' ? 'Use my real email' : 'Create alias & fill');
    render([
      riskBlock(d.site),
      el('div', { class: 'muted' }, 'What is this sign-up for?'), chips,
      el('div', { class: 'rec' }, el('b', {}, `Recommended: T${rec.tier} ${rec.name}. `), rec.reasons[0]),
      el('div', { class: 'row' }, go,
        (!d.site || d.site.score == null) ? el('button', { class: 'btn sec', onclick: () => scanNow(d, purpose) }, 'Check site') : null)
    ]);
  }
  async function scanNow(d, purpose) {
    loading('Scanning the site live (TLS, breaches, trackers, policy)…');
    const res = await send({ type: 'scan', url: location.href });
    if (!res.ok) return errorView(res);
    createView({ ...d, site: res.data.site, recommendations: res.data.recommendations }, purpose);
  }
  async function create(d, purpose, btnEl) {
    btnEl.disabled = true;
    loading(d.site?.score == null ? 'Checking the site and creating your alias…' : 'Creating your alias…');
    const res = await send({ type: 'createAlias', url: location.href, purpose });
    if (!res.ok) return errorView(res);
    const { alias, site, scanError } = res.data;
    if (field?.isConnected) fillAll(field, alias.address);
    render([
      el('div', { class: 'msg ok' }, alias.realIdentity ? `Your real email was filled. TraceMask recorded that ${d.domain} has it.` : `Filled! Only ${d.domain} will ever know this address.`),
      el('div', { class: 'alias' }, alias.address),
      site?.score != null ? riskBlock(site) : null,
      scanError ? el('div', { class: 'msg info' }, `The live site check could not finish (${scanError}). Your alias is monitored anyway.`) : null,
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: closePanel }, 'Done'), el('button', { class: 'btn sec', onclick: () => copy(alias.address) }, 'Copy'))
    ]);
  }

  function copy(text) {
    navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', 'error'));
  }
  function toast(text, kind = 'ok') {
    ensureHost();
    toastEl?.remove();
    toastEl = el('div', { class: `toast ${kind === 'error' ? 'error' : ''}` }, text);
    root.append(toastEl);
    const r = field?.isConnected ? field.getBoundingClientRect() : { left: innerWidth - 380, bottom: 20 };
    toastEl.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 370))}px`;
    toastEl.style.top = `${Math.min(innerHeight - 50, (r.bottom || 20) + 8)}px`;
    const t = toastEl; setTimeout(() => t.remove(), 3500);
  }

  // ---------- messages from the popup / context menu ----------
  let lastContext = null;
  on(document, 'contextmenu', (e) => { lastContext = e.composedPath()[0]; }, true);
  function pickTarget(mode) {
    const act = document.activeElement?.shadowRoot?.activeElement || document.activeElement;
    if (mode === 'active') { const t = [lastContext, act].find(fillable); if (t) return t; }
    if (isEmailField(act) && visible(act)) return act;
    if (field?.isConnected && visible(field)) return field;
    return [...document.querySelectorAll('input')].find(x => isEmailField(x) && visible(x)) || null;
  }
  const onMessage = (msg, _sender, sendResponse) => {
    if (msg?.type === 'tm:fill') {
      const target = pickTarget(msg.target);
      if (!target) {
        sendResponse({ filled: false });
        navigator.clipboard.writeText(msg.value).then(() => toast('No email field found here, so your alias was copied. Paste it where needed.'),
          () => toast(`No email field found here. Your alias: ${msg.value}`));
        return;
      }
      field = target;
      fillAll(target, msg.value);
      toast(msg.toast || 'Alias filled');
      sendResponse({ filled: true });
    } else if (msg?.type === 'tm:toast') { toast(msg.text, msg.kind); sendResponse({ ok: true }); }
    else if (msg?.type === 'tm:inline') { inlineOn = !!msg.on; if (!inlineOn && btn) btn.style.display = 'none'; sendResponse({ ok: true }); }
    else if (msg?.type === 'tm:probe') { sendResponse({ emailFields: [...document.querySelectorAll('input')].filter(x => isEmailField(x) && visible(x)).length }); }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  cleanups.push(() => chrome.runtime.onMessage.removeListener(onMessage));

  send({ type: 'inlineEnabled' }).then((r) => {
    inlineOn = !!r?.data?.inline;
    const a = document.activeElement;
    if (inlineOn && isEmailField(a) && visible(a)) showButton(a);
  });
})();
