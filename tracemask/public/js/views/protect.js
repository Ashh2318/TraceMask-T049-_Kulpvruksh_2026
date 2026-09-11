import { h, api, apiStream, icon, copy, toast, withBusy, tierBadge, button } from '../lib.js';
import { riskReport } from './report.js';
import { go } from '../app.js';

const STEPS = { dns: 'DNS & email-auth records', tls: 'TLS certificate', rdap: 'Domain registration (RDAP)', breaches: 'Breach history (Have I Been Pwned)', page: 'Homepage, trackers & headers', privacy: 'Privacy policy analysis' };

export async function protectView() {
  const meta = await api('/api/meta');
  let purpose = 'regular';
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const urlIn = h('input', { class: 'input input-lg', placeholder: 'Paste the sign-up page, e.g. myntra.com or a newsletter link', value: params.get('url') || '', required: true, autocomplete: 'off' });
  const purposeBox = h('div', { class: 'purpose' }, Object.entries(meta.purposes).map(([k, v]) =>
    h('button', { type: 'button', 'data-k': k, class: k === purpose ? 'on' : '', onClick: () => {
      purpose = k; purposeBox.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
    } }, h('b', {}, v.split(':')[0]), h('span', {}, v.split(':')[1] || ''))));
  const scanBtn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, icon('search', 17), 'Scan site');
  const out = h('div', { class: 'stack', style: { marginTop: '18px' } });

  async function runScan() {
    const steps = {};
    const list = h('div', { class: 'steplist' }, Object.entries(STEPS).map(([k, label]) => {
      const sum = h('span', { class: 's-sum' }, 'waiting');
      const el = h('div', { class: 'stepitem' }, h('span', { class: 's-ico' }), h('b', {}, label), sum);
      steps[k] = { el, sum };
      return el;
    }));
    const targetLine = h('div', { class: 'muted small' }, 'Resolving target…');
    out.replaceChildren(h('div', { class: 'card card-pad' }, h('div', { class: 'row' }, icon('bolt', 16), h('b', {}, 'Live scan in progress'), h('div', { class: 'spacer' }), targetLine), h('div', { style: { marginTop: '12px' } }, list)));
    let site = null;
    await apiStream('/api/scan', { url: urlIn.value }, (e) => {
      if (e.type === 'target') targetLine.textContent = `${e.target.host} → registrable domain ${e.target.domain}`;
      if (e.type === 'step' && steps[e.step]) {
        const s = steps[e.step]; s.el.className = `stepitem ${e.status}`;
        s.el.querySelector('.s-ico').replaceChildren(e.status === 'done' ? icon('check', 13) : e.status === 'error' ? icon('alert', 13) : '');
        s.sum.textContent = e.summary || (e.status === 'running' ? 'checking…' : '');
      }
      if (e.type === 'result') site = e.site;
      if (e.type === 'error') throw new Error(e.error);
    });
    if (site) await showResult(site);
  }

  async function showResult(site) {
    const rec = await api('/api/recommend', { method: 'POST', body: { siteId: site.id, purpose } });
    let tier = rec.tier;
    const tierBox = h('div', { class: 'tiercards' }, Object.entries(meta.tiers).map(([k, t]) =>
      h('button', { type: 'button', 'data-k': k, class: Number(k) === tier ? 'on' : '', onClick: () => {
        tier = Number(k); tierBox.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.k) === tier));
      } }, Number(k) === rec.tier ? h('div', { class: 'rec' }, 'Recommended') : null, h('b', {}, `${t.short} · ${t.name}`), h('small', {}, t.desc))));
    const label = h('input', { class: 'input', placeholder: `Label (optional) — e.g. “${site.domain} account”` });
    const createBtn = h('button', { class: 'btn btn-primary btn-lg' }, icon('mask', 17), 'Create identity for this site');
    const resultBox = h('div');
    createBtn.addEventListener('click', () => withBusy(createBtn, async () => {
      try {
        const a = await api('/api/aliases', { method: 'POST', body: { siteId: site.id, purpose, tier, label: label.value } });
        const address = a.realIdentity ? a.address : a.address;
        resultBox.replaceChildren(h('div', { class: 'card card-pad stack' },
          a.realIdentity
            ? h('div', { class: 'note warn' }, h('b', {}, 'Real identity recorded. '), `Use ${address} on ${site.domain}. TraceMask logged this disclosure so it appears in your exposure history.`)
            : [h('div', { class: 'row' }, h('h3', {}, 'Your identity for ', site.domain), tierBadge(a.tier), a.expires_at ? h('span', { class: 'badge st-warn' }, `expires ${new Date(a.expires_at).toLocaleString('en-IN')}`) : null),
              h('div', { class: 'alias-box' }, icon('mail', 22), h('span', { class: 'mono', style: { flex: 1 } }, address),
                button('Copy', { kind: 'primary', ico: 'copy', onClick: () => copy(address, 'Alias copied — paste it into the sign-up form') })),
              h('div', { class: 'small muted' }, 'This is a real, deliverable address: the welcome email and every password reset will reach your inbox. Only ', h('b', {}, site.domain), ' knows it — so if anyone else ever emails it, TraceMask will flag the leak.')],
          h('div', { class: 'row' }, button('View identity', { ico: 'arrow', onClick: () => go(`/identities/${a.id}`) }), button('Protect another sign-up', { kind: 'ghost', onClick: () => { urlIn.value = ''; out.replaceChildren(); urlIn.focus(); } }))));
        toast(a.realIdentity ? 'Disclosure recorded' : 'Identity created', 'success');
        resultBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) { toast(e.message, 'error', 7000); }
    }));

    out.replaceChildren(
      riskReport(site),
      h('div', { class: 'card card-pad stack' },
        h('div', { class: 'row' }, icon('shield', 18), h('h3', {}, 'Recommended trust tier'), tierBadge(rec.tier)),
        h('ul', { class: 'small', style: { margin: 0, paddingLeft: '18px', color: 'var(--text-2)' } }, rec.reasons.map(r => h('li', {}, r))),
        h('div', { class: 'small' }, h('b', {}, 'Share only: '), rec.share.join(' · ')),
        tierBox, label, h('div', { class: 'row' }, createBtn)),
      resultBox);
  }

  const form = h('form', { onSubmit: (e) => { e.preventDefault(); withBusy(scanBtn, () => runScan().catch(x => { toast(x.message, 'error', 7000); out.replaceChildren(h('div', { class: 'err' }, x.message)); })); } },
    h('div', { class: 'row', style: { gap: '10px' } }, urlIn, scanBtn));

  if (params.get('url')) setTimeout(() => form.requestSubmit(), 50);
  return h('div', {},
    h('div', { class: 'hero-scan' },
      h('h2', {}, 'Before you sign up, check who you are giving your identity to'),
      h('p', {}, 'TraceMask checks the site live — certificate, domain age, breach history, trackers and privacy policy — then gives you the right identity for it.'),
      form),
    h('div', { class: 'section-title' }, h('h2', {}, 'What is this sign-up for?')),
    purposeBox, out);
}
