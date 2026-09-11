import { h, api, icon, withBusy } from '../lib.js';

function strength(pw) {
  let s = 0;
  if (pw.length >= 10) s++; if (pw.length >= 14) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++; if (/\d/.test(pw)) s++; if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}

export function authView(initialized, done) {
  const err = h('div', { class: 'err', hidden: true });
  const pw = h('input', { class: 'input input-lg', type: 'password', placeholder: 'Master password', autocomplete: initialized ? 'current-password' : 'new-password', required: true });
  const pw2 = h('input', { class: 'input input-lg', type: 'password', placeholder: 'Repeat master password', autocomplete: 'new-password' });
  const meter = h('div', { class: 'strength' }, h('div', { style: { width: '0%' } }));
  pw.addEventListener('input', () => {
    const s = strength(pw.value);
    Object.assign(meter.firstChild.style, { width: `${(s / 4) * 100}%`, background: ['#d92d4b', '#d92d4b', '#c27803', '#0f9d6b', '#0f9d6b'][s] });
  });
  const submit = h('button', { class: 'btn btn-primary btn-lg', type: 'submit', style: { width: '100%' } }, initialized ? 'Unlock vault' : 'Create vault');
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault(); err.hidden = true;
    if (!initialized && pw.value !== pw2.value) { err.textContent = 'Passwords do not match'; err.hidden = false; return; }
    await withBusy(submit, async () => {
      try { await api(initialized ? '/api/vault/unlock' : '/api/vault/init', { method: 'POST', body: { password: pw.value } }); done(); }
      catch (x) { err.textContent = x.message; err.hidden = false; }
    });
  } },
  pw, initialized ? null : meter, initialized ? null : pw2, err, submit,
  h('p', { class: 'muted small', style: { margin: '4px 0 0' } }, icon('lock', 13), ' ',
    initialized ? 'Your mailbox credentials stay encrypted until you unlock.'
      : 'This password encrypts your mailbox credentials on this computer (scrypt + AES-256-GCM). It is never stored or sent anywhere — if you forget it, the vault cannot be recovered.'));

  setTimeout(() => pw.focus(), 50);
  return h('div', { class: 'auth' },
    h('section', { class: 'auth-hero' },
      h('div', { class: 'logo' }, h('div', { class: 'logo-mark' }, icon('mask', 20)), h('div', {}, h('b', {}, 'TraceMask'), h('small', {}, 'Identity firewall'))),
      h('h1', {}, 'A different you for every website — and proof of who leaked it.'),
      h('p', {}, 'Stop handing your real email to every sign-up form. TraceMask gives each site its own identity, watches who uses it, and catches the company that leaked it.'),
      h('div', { class: 'hero-points' },
        h('div', {}, icon('globe'), h('span', {}, h('b', {}, 'Live risk scan'), ' — breaches, trackers, domain age and privacy policy checked before you sign up.')),
        h('div', {}, icon('mask'), h('span', {}, h('b', {}, 'One alias per site'), ' — real, deliverable addresses, so password resets keep working.')),
        h('div', {}, icon('alert'), h('span', {}, h('b', {}, 'Automatic leak attribution'), ' — the moment a stranger emails an alias, you know who sold it.')),
        h('div', {}, icon('doc'), h('span', {}, h('b', {}, 'Erasure requests'), ' — evidence-backed DPDP / GDPR deletion letters in one click.')))),
    h('section', { class: 'auth-form' },
      h('div', { class: 'auth-card' },
        h('h2', {}, initialized ? 'Welcome back' : 'Create your local vault'),
        h('p', { class: 'sub' }, initialized ? 'Enter your master password to unlock TraceMask.' : 'Everything TraceMask stores lives on this computer only.'),
        form,
        h('div', { class: 'team-credit' }, h('img', { src: '/team-logo.svg', alt: '', width: 26, height: 26 }), h('span', {}, 'Built by ', h('b', {}, 'Team Cryptic_Vruksh'), ' · Kalpvruksh 2.0')))));
}
