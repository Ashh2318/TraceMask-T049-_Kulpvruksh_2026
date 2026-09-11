// TraceMask options page: pairing, connection status and preferences.
const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (r || { ok: false, error: 'No response' }))));

$('#ver').textContent = `v${chrome.runtime.getManifest().version}`;

function row(label, value, dot) {
  const dt = document.createElement('dt'); dt.textContent = label;
  const dd = document.createElement('dd');
  if (dot) { const d = document.createElement('span'); d.className = `dot ${dot}`; dd.append(d); }
  dd.append(document.createTextNode(value));
  return [dt, dd];
}
function setState(text, cls) { const p = $('#state'); p.textContent = text; p.className = `pill ${cls || ''}`; }
function msg(elSel, text, cls) { const m = $(elSel); m.textContent = text || ''; m.className = `msg ${cls || ''}`; m.hidden = !text; }
const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleString();
};

async function refresh(showResult = false) {
  setState('Checking…');
  const st = await send({ type: 'status' });
  const rows = $('#rows');
  rows.replaceChildren();
  msg('#conn-msg', '');
  if (!st.ok) {
    const offline = st.code === 'offline';
    if (st.code === 'not_paired') return notPaired(st);
    setState(offline ? 'App not running' : 'Error', 'bad');
    rows.append(...row('TraceMask app', offline ? 'Not running on this computer' : st.error, 'bad'));
    msg('#conn-msg', offline ? 'Start TraceMask with start.bat (or npm start in the TraceMask folder), then click Test connection.' : st.error, 'err');
    $('#unpair').hidden = false;
    $('#pair-card').hidden = true;
    return;
  }
  const s = st.data;
  $('#opt-inline').checked = s.inline !== false;
  $('#opt-notify').checked = s.notify !== false;
  if (!s.paired) return notPaired({ data: s });
  $('#pair-card').hidden = true;
  $('#unpair').hidden = false;
  rows.append(
    ...row('TraceMask app', `Running at ${s.server}`, 'ok'),
    ...row('This browser', `Paired as “${s.deviceName || 'Chrome'}”`, 'ok'),
    ...row('Vault', s.unlocked ? 'Unlocked' : 'Locked. Unlock TraceMask to create aliases.', s.unlocked ? 'ok' : 'warn'),
    ...row('Mailbox', s.mailbox ? `${s.mailbox.address} (last check ${ago(s.mailbox.lastSyncAt)})` : 'Not connected yet. Connect it in TraceMask.', s.mailbox ? 'ok' : 'warn'),
    ...(s.unlocked ? row('Open leaks', String(s.openLeaks || 0), s.openLeaks ? 'bad' : 'ok') : [])
  );
  if (!s.unlocked) setState('Locked', 'warn');
  else if (!s.mailbox) setState('Setup needed', 'warn');
  else setState(s.openLeaks ? `${s.openLeaks} open leak${s.openLeaks > 1 ? 's' : ''}` : 'Protected', s.openLeaks ? 'bad' : 'ok');
  if (showResult) msg('#conn-msg', 'Connection works. The extension can reach your TraceMask app.', 'ok');
}

function notPaired(st) {
  setState('Not paired', 'warn');
  $('#rows').replaceChildren(...row('This browser', 'Not paired with TraceMask yet', 'warn'));
  $('#unpair').hidden = true;
  $('#pair-card').hidden = false;
  if (st.data?.server) $('#server').value = st.data.server;
  if (st.data) { $('#opt-inline').checked = st.data.inline !== false; $('#opt-notify').checked = st.data.notify !== false; }
  setTimeout(() => $('#code').focus(), 30);
}

$('#code').addEventListener('input', (e) => {
  const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  e.target.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
});
$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = $('#pair-btn');
  b.disabled = true; b.textContent = 'Pairing…'; msg('#pair-msg', '');
  const r = await send({ type: 'pair', code: $('#code').value, server: $('#server').value });
  b.disabled = false; b.textContent = 'Pair with TraceMask';
  if (!r.ok) { msg('#pair-msg', r.error, 'err'); return; }
  $('#code').value = '';
  await refresh();
  msg('#conn-msg', `Paired! This browser is now connected as “${r.data.name}”. Open any sign-up page and click an email field.`, 'ok');
});
$('#test').addEventListener('click', () => refresh(true));
$('#open-app').addEventListener('click', () => send({ type: 'openApp', hash: '' }));
$('#unpair').addEventListener('click', async () => {
  if (!confirm('Unpair this browser? The extension will stop filling aliases until you pair it again.')) return;
  await send({ type: 'unpair' });
  refresh();
});
$('#opt-inline').addEventListener('change', (e) => send({ type: 'settings', inline: e.target.checked }));
$('#opt-notify').addEventListener('change', (e) => send({ type: 'settings', notify: e.target.checked }));
$('#shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
chrome.commands.getAll((cmds) => {
  const c = cmds.find(x => x.name === 'fill-alias');
  $('#shortcut').textContent = c?.shortcut || 'not set';
});

refresh();
