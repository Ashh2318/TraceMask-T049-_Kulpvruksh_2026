import { h, api, icon, withBusy, toast } from '../lib.js';

export async function mailboxForm({ onSaved, existing } = {}) {
  const providers = await api('/api/providers');
  let provider = existing?.provider || 'gmail';
  let aliasMode = existing?.alias_mode || 'plus';
  const host = h('input', { class: 'input', value: existing?.host || providers[provider].host, placeholder: 'imap.example.com' });
  const user = h('input', { class: 'input', name: 'imap-username', value: existing?.username || '', placeholder: 'you@gmail.com', autocomplete: 'off', spellcheck: false });
  // autocomplete=new-password stops browsers auto-filling the TraceMask master password into this field
  const pass = h('input', { class: 'input', type: 'password', name: 'imap-app-password', placeholder: existing ? 'Re-enter app password to update' : '16-character app password', autocomplete: 'new-password', spellcheck: false });
  const base = h('input', { class: 'input', value: existing?.base_address || '', placeholder: 'Same as username for most accounts' });
  const aliasDomain = h('input', { class: 'input', value: existing?.alias_domain || '', placeholder: 'e.g. mask.yourdomain.in' });
  const help = h('div', { class: 'note' });
  const err = h('div', { class: 'err', hidden: true });
  const result = h('div', { hidden: true });
  const domainField = h('div', { class: 'field' }, h('label', {}, 'Catch-all domain'), aliasDomain,
    h('div', { class: 'help' }, 'A domain whose catch-all (*@domain) forwards to this mailbox. Each alias becomes site-xxxxx@domain.'));

  const provBtns = h('div', { class: 'provider' }, Object.entries(providers).map(([k, p]) =>
    h('button', { type: 'button', 'data-k': k, onClick: () => setProvider(k) }, h('b', {}, p.label), h('span', {}, p.host || 'Any IMAP server'))));
  const modeSeg = h('div', { class: 'seg' },
    h('button', { type: 'button', 'data-m': 'plus', onClick: () => setMode('plus') }, 'Plus-address (you+site-x@…)'),
    h('button', { type: 'button', 'data-m': 'domain', onClick: () => setMode('domain') }, 'Catch-all domain'));

  function setProvider(k) {
    provider = k;
    provBtns.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
    if (providers[k].host) host.value = providers[k].host;
    help.textContent = providers[k].help;
    if (!providers[k].plus && aliasMode === 'plus' && k !== 'gmail') setMode('domain'); else if (k === 'gmail') setMode('plus');
  }
  function setMode(m) {
    aliasMode = m;
    modeSeg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
    domainField.hidden = m !== 'domain';
  }
  setProvider(provider); setMode(aliasMode);

  const body = () => ({ provider, host: host.value, port: 993, username: user.value, password: pass.value, baseAddress: base.value || user.value, aliasMode, aliasDomain: aliasDomain.value });
  const testBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, icon('bolt', 16), 'Test connection');
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('check', 16), existing ? 'Save mailbox' : 'Connect & start monitoring');
  const showResult = (t) => {
    result.hidden = false;
    result.replaceChildren(h('div', { class: 'success-box' },
      h('b', {}, 'Connected. '), `Logged in over TLS, found “${t.inbox}” with ${t.messages.toLocaleString('en-IN')} messages`,
      t.junk ? ` and spam folder “${t.junk}”.` : '. No spam folder detected.',
      h('div', { class: 'small', style: { marginTop: '4px' } }, `Server supports: ${t.capabilities.join(', ') || 'basic IMAP'}`)));
  };
  testBtn.addEventListener('click', () => withBusy(testBtn, async () => {
    err.hidden = true; result.hidden = true;
    try { showResult(await api('/api/mailbox/test', { method: 'POST', body: body() })); }
    catch (e) { err.textContent = e.message; err.hidden = false; }
  }));

  return h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); withBusy(saveBtn, async () => {
    err.hidden = true;
    try { const r = await api('/api/mailbox', { method: 'POST', body: body() }); showResult(r.test); toast('Mailbox connected — first sync started', 'success'); onSaved?.(); }
    catch (x) { err.textContent = x.message; err.hidden = false; }
  }); } },
  h('div', { class: 'field' }, h('label', {}, 'Mail provider'), provBtns), help,
  h('div', { class: 'grid g2' },
    h('div', { class: 'field' }, h('label', {}, 'IMAP server'), host, h('div', { class: 'help' }, 'TLS on port 993 only — plaintext IMAP is refused.')),
    h('div', { class: 'field' }, h('label', {}, 'Username / email'), user)),
  h('div', { class: 'grid g2' },
    h('div', { class: 'field' }, h('label', {}, 'App password'), pass, h('div', { class: 'help' }, 'Encrypted with your master password before it is saved.')),
    h('div', { class: 'field' }, h('label', {}, 'Your real address'), base, h('div', { class: 'help' }, 'The identity TraceMask keeps private.'))),
  h('div', { class: 'field' }, h('label', {}, 'How aliases are created'), modeSeg), domainField,
  err, result,
  h('div', { class: 'row' }, testBtn, h('div', { class: 'spacer' }), saveBtn));
}

export function onboardingView(done) {
  const wrap = h('div', { class: 'onb' },
    h('div', { class: 'logo', style: { color: 'var(--text)', padding: '0 0 8px' } }, h('div', { class: 'logo-mark' }, icon('mask', 20)), h('div', {}, h('b', {}, 'TraceMask'), h('small', { style: { color: 'var(--text-3)' } }, 'Identity firewall'))),
    h('h2', { style: { fontSize: '26px' } }, 'Connect the inbox TraceMask should protect'),
    h('p', { class: 'muted', style: { margin: '6px 0 0' } }, 'TraceMask reads only message headers (sender, recipient, date, authentication results) to attribute mail to the site each alias was created for. Message bodies are never downloaded.'),
    h('div', { class: 'steps' }, h('div', { class: 'on' }), h('div', { class: 'on' }), h('div', {})),
    h('div', { class: 'card card-pad', id: 'mbform' }, h('div', { class: 'loading' }, 'Loading')));
  mailboxForm({ onSaved: done }).then(f => wrap.querySelector('#mbform').replaceChildren(f));
  return wrap;
}
