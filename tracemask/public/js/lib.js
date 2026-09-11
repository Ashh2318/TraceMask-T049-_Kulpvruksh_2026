// UI toolkit: element builder, API client, formatting, toasts, icons.
export function h(tag, props = {}, ...children) {
  const el = tag === 'svg' || props.svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false || k === 'svg') continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (k === 'html') el.innerHTML = v; // only used with trusted, static SVG markup
    else if (k in el && !(el instanceof SVGElement) && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
// Only http(s) links from scanned sites are ever rendered (blocks javascript:/data: URLs)
export const safeHref = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };

export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

export async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-tracemask': '1' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/vault/unlock') { window.dispatchEvent(new CustomEvent('tm:locked')); }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data;
}

// Streams newline-delimited JSON (used for the live scan progress)
export async function apiStream(path, body, onEvent) {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-tracemask': '1' }, body: JSON.stringify(body) });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new ApiError(d.error || `Request failed (${res.status})`, res.status); }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onEvent(JSON.parse(line)); }
  }
}

export function toast(msg, kind = 'info', timeout = 4500) {
  const t = h('div', { class: `toast toast-${kind}` }, h('span', { class: 'toast-dot' }), h('div', {}, msg));
  document.getElementById('toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, timeout);
}

export const fmtDate = (iso, withTime = false) => !iso ? '—' : new Date(iso).toLocaleString('en-IN', withTime
  ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' });
export function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 0) { const f = -s; return f < 3600 ? `in ${Math.round(f / 60)} min` : f < 86400 ? `in ${Math.round(f / 3600)} h` : `in ${Math.round(f / 86400)} d`; }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return fmtDate(iso);
}
export const num = (n) => Number(n || 0).toLocaleString('en-IN');

export async function copy(text, label = 'Copied to clipboard') {
  try { await navigator.clipboard.writeText(text); toast(label, 'success', 2500); }
  catch { toast('Copy failed — select the text and press Ctrl+C', 'warn'); }
}

export async function downloadPdf(path, fallbackName = 'tracemask-report.pdf') {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new ApiError(d.error || `Export failed (${res.status})`, res.status); }
  const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Saved ${name}`, 'success');
}

export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const P = {
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8.5-8 9.9C7.5 20.5 4 17 4 12V6z"/>',
  dash: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  mask: '<path d="M3 8c3-2 15-2 18 0 0 6-3 9-6 9-1.5 0-2-2-3-2s-1.5 2-3 2c-3 0-6-3-6-9z"/><circle cx="8.5" cy="10.5" r="1.2"/><circle cx="15.5" cy="10.5" r="1.2"/>',
  alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/>',
  map: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M12 3a14 14 0 000 18M12 3a14 14 0 010 18M3.5 9h17M3.5 15h17"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 118 0v3"/>',
  sync: '<path d="M20 11a8 8 0 00-14.9-3M4 13a8 8 0 0014.9 3"/><path d="M4 4v4h4M20 20v-4h-4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2"/>'
};
export function icon(name, size = 18, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('class', `ico ${cls}`); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = P[name] || '';
  return s;
}

export function riskBadge(level, score) {
  const l = level || 'unknown';
  return h('span', { class: `badge risk-${l}` }, score != null ? `${score} · ${l}` : l);
}
export function tierBadge(tier) {
  const names = { 0: 'T0 Burner', 1: 'T1 Tracked', 2: 'T2 Protected', 3: 'T3 Real' };
  return h('span', { class: `badge tier-${tier}` }, names[tier] ?? `T${tier}`);
}
export function classBadge(c, quarantined) {
  const map = { legit: ['ok', 'Legit'], leak: ['bad', 'Leak'], review: ['warn', 'Review'], real: ['muted', 'Real address'] };
  const [k, t] = map[c] || ['muted', c];
  return h('span', { class: `badge st-${k}` }, t, quarantined ? ' · quarantined' : '');
}

export function button(label, opts = {}) {
  const { kind = 'secondary', ico, onClick, type = 'button', size, disabled, title } = opts;
  return h('button', { class: `btn btn-${kind}${size ? ' btn-' + size : ''}`, type, onClick, disabled, title }, ico ? icon(ico, 16) : null, label ? h('span', {}, label) : null);
}

export async function withBusy(btn, fn) {
  btn.disabled = true; btn.classList.add('busy');
  try { return await fn(); } finally { btn.disabled = false; btn.classList.remove('busy'); }
}

export function empty(title, text, action) {
  return h('div', { class: 'empty' }, icon('mask', 34), h('h3', {}, title), h('p', {}, text), action || null);
}

export function modal(title, body, actions = []) {
  const close = () => wrap.remove();
  const wrap = h('div', { class: 'modal-wrap', onClick: (e) => { if (e.target === wrap) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', onClick: close, 'aria-label': 'Close' }, icon('x'))),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-foot' }, actions) : null));
  document.body.append(wrap);
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  return { close, el: wrap };
}
