import { h, api, icon, toast, fmtDate, button, withBusy, download, downloadPdf } from '../lib.js';
import { mailboxForm } from './onboarding.js';
import { go } from '../app.js';

export async function settingsView() {
  const [s, mb, audit, runs, meta] = await Promise.all([api('/api/settings'), api('/api/mailbox'), api('/api/audit'), api('/api/sync/runs'), api('/api/meta')]);
  const n = (k, min, max, label, help) => {
    const i = h('input', { class: 'input', type: 'number', min, max, value: s[k] });
    i.dataset.k = k;
    return h('div', { class: 'field' }, h('label', {}, label), i, h('div', { class: 'help' }, help));
  };
  const c = (k, label, help) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!s[k], 'data-k': k }), h('span', {}, h('b', {}, label), h('div', { class: 'help muted small' }, help)));
  const style = h('select', { class: 'input', 'data-k': 'aliasStyle' },
    h('option', { value: 'named', selected: s.aliasStyle === 'named' }, 'Named — you+myntra-k3x9p@… (easy to recognise)'),
    h('option', { value: 'opaque', selected: s.aliasStyle === 'opaque' }, 'Opaque — you+q7m2x9k4pd@… (reveals nothing)'));
  const form = h('div', { class: 'stack' },
    h('div', { class: 'grid g3' },
      n('syncIntervalMin', 1, 60, 'Sync interval (minutes)', 'Background check of inbox + spam. IMAP IDLE also triggers instant syncs.'),
      n('lookbackDays', 7, 365, 'Initial look-back (days)', 'How far back the first sync reads headers.'),
      n('burnerHours', 1, 720, 'Burner lifetime (hours)', 'T0 aliases expire after this long.')),
    h('div', { class: 'field' }, h('label', {}, 'Alias style'), style),
    c('quarantineEnabled', 'Quarantine leaked & blocked mail', `Moves it to the “${s.quarantineFolder}” folder in your mailbox (never deletes).`),
    c('idleEnabled', 'Real-time monitoring (IMAP IDLE)', 'Keeps one connection open so new mail is checked within seconds.'));
  const saveBtn = button('Save settings', { kind: 'primary' });
  saveBtn.addEventListener('click', () => withBusy(saveBtn, async () => {
    const body = {};
    form.querySelectorAll('[data-k]').forEach(el => { body[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value; });
    await api('/api/settings', { method: 'PATCH', body }); toast('Settings saved', 'success');
  }));

  const cur = h('input', { class: 'input', type: 'password', placeholder: 'Current master password' });
  const nxt = h('input', { class: 'input', type: 'password', placeholder: 'New master password (10+ chars)' });
  const pwBtn = button('Change password', {});
  pwBtn.addEventListener('click', () => withBusy(pwBtn, async () => {
    try { await api('/api/vault/password', { method: 'POST', body: { current: cur.value, next: nxt.value } }); toast('Master password changed', 'success'); cur.value = nxt.value = ''; }
    catch (e) { toast(e.message, 'error'); }
  }));

  const mbBox = h('div');
  const showMb = () => mbBox.replaceChildren(h('dl', { class: 'kv' },
    h('dt', {}, 'Address'), h('dd', {}, mb.base_address), h('dt', {}, 'Server'), h('dd', {}, `${mb.host}:${mb.port} (TLS)`),
    h('dt', {}, 'Login'), h('dd', {}, mb.username), h('dt', {}, 'Alias mode'), h('dd', {}, mb.alias_mode === 'domain' ? `catch-all @${mb.alias_domain}` : 'plus-addressing'),
    h('dt', {}, 'Connected'), h('dd', {}, fmtDate(mb.created_at, true))),
    h('div', { class: 'row', style: { marginTop: '12px' } },
      button('Edit connection', { onClick: async () => mbBox.replaceChildren(await mailboxForm({ existing: mb, onSaved: () => go('/dashboard') })) }),
      button('Disconnect', { kind: 'danger', onClick: async () => { if (!confirm('Disconnect this mailbox? Aliases and history are kept.')) return; await api('/api/mailbox', { method: 'DELETE' }); location.reload(); } })));
  showMb();

  // ---- Browser extension pairing ----
  const extBox = h('div', { class: 'stack' });
  async function drawExt(codeInfo) {
    const devices = await api('/api/ext/devices');
    const codeEl = codeInfo ? h('div', { class: 'pair-code' },
      h('div', { class: 'muted small' }, 'Enter this code in the TraceMask extension (valid 5 minutes, single use):'),
      h('div', { class: 'code' }, codeInfo.code),
      h('div', { class: 'muted small', id: 'pair-exp' }, `Expires at ${new Date(codeInfo.expiresAt).toLocaleTimeString('en-IN')}`)) : null;
    extBox.replaceChildren(
      h('div', { class: 'small muted' }, 'Pair the TraceMask Chrome extension to scan sites and fill aliases right inside sign-up forms. Each browser gets its own revocable token; nothing leaves this computer.'),
      codeEl,
      h('div', {}, button(codeInfo ? 'Generate a new code' : 'Generate pairing code', { kind: codeInfo ? 'secondary' : 'primary', ico: 'key', onClick: async () => drawExt(await api('/api/ext/pairing-code', { method: 'POST' })) })),
      devices.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Paired browser', 'Paired', 'Last used', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, devices.map(d => h('tr', {},
          h('td', {}, h('b', {}, d.name)), h('td', { class: 'small' }, fmtDate(d.created_at, true)), h('td', { class: 'small' }, d.last_used_at ? fmtDate(d.last_used_at, true) : '—'),
          h('td', { style: { textAlign: 'right' } }, button('Revoke', { size: 'sm', kind: 'danger', onClick: async () => { await api(`/api/ext/devices/${d.id}`, { method: 'DELETE' }); toast('Extension access revoked', 'success'); drawExt(); } })))))))
        : h('div', { class: 'small muted' }, 'No browser paired yet.'));
  }
  drawExt();

  return h('div', { class: 'stack' },
    h('div', { class: 'card card-pad stack' }, h('div', { class: 'row' }, icon('ext', 17), h('h3', {}, 'Browser extension')), extBox),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card card-pad' }, h('h3', { style: { marginBottom: '12px' } }, 'Mailbox'), mbBox),
      h('div', { class: 'card card-pad stack' }, h('h3', {}, 'Security'),
        h('div', { class: 'small muted' }, 'Vault: scrypt (N=2^15) key derivation → AES-256-GCM. Server listens on 127.0.0.1 only, with CSRF, DNS-rebinding and strict CSP protection.'),
        cur, nxt, h('div', {}, pwBtn),
        h('div', { class: 'small muted' }, `Tracker list: ${meta.trackers.source}${meta.trackers.domains ? ` (${meta.trackers.domains.toLocaleString('en-IN')} domains)` : ''} · Public Suffix List: ${meta.psl}`),
        h('div', { class: 'row wrap' }, button('Privacy posture report (PDF)', { kind: 'primary', ico: 'download', onClick: () => downloadPdf('/api/reports/posture').catch(e => toast(e.message, 'error')) }),
          button('Export my data (JSON)', { ico: 'download', onClick: async () => { const r = await api('/api/export', { raw: true }); download('tracemask-export.json', await r.text()); } })))),
    h('div', { class: 'card card-pad stack' }, h('h3', {}, 'Monitoring'), form, h('div', {}, saveBtn)),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Recent sync runs')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Started', 'Trigger', 'Result'].map(t => h('th', {}, t)))),
          h('tbody', {}, runs.runs.map(r => h('tr', {}, h('td', { class: 'small' }, fmtDate(r.started_at, true)), h('td', { class: 'small' }, r.trigger),
            h('td', { class: 'small' }, r.status === 'error' ? h('span', { style: { color: 'var(--bad)' } }, r.error) : `${r.scanned} read · ${r.alias_messages} alias · ${r.new_leaks} leaks · ${r.quarantined} quarantined`))))))),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Security audit log')),
        h('div', { class: 'table-wrap', style: { maxHeight: '360px', overflow: 'auto' } }, h('table', { class: 'tbl' },
          h('tbody', {}, audit.map(a => h('tr', {}, h('td', { class: 'small', style: { whiteSpace: 'nowrap' } }, fmtDate(a.ts, true)), h('td', { class: 'small' }, h('b', {}, a.event), h('div', { class: 'cell-sub' }, a.detail))))))))));
}
