import { h, api, icon, toast, ago, fmtDate, button, empty, modal, copy, downloadPdf } from '../lib.js';
import { rerender } from '../app.js';

export async function openErasureComposer(source, existing) {
  const meta = await api('/api/meta');
  let law = existing?.law || 'dpdp';
  let draft = existing ? { ...existing, orgDomain: existing.org_domain, recipients: existing.recipient ? [existing.recipient] : [] } : null;
  const lawSel = h('select', { class: 'input' }, Object.entries(meta.laws).map(([k, v]) => h('option', { value: k, selected: k === law }, v.name)));
  const lawNote = h('div', { class: 'note warn small' });
  const recipient = h('input', { class: 'input', placeholder: 'privacy@company.com' });
  const suggestions = h('div', { class: 'small' });
  const subject = h('input', { class: 'input' });
  const body = h('textarea', { class: 'input', style: { minHeight: '280px' } });

  async function load() {
    if (!existing) draft = await api('/api/requests/draft', { method: 'POST', body: { ...source, law } });
    subject.value = draft.subject; body.value = draft.body;
    lawNote.textContent = meta.laws[law].note;
    if (!recipient.value) recipient.value = draft.recipients?.[0] || '';
    suggestions.replaceChildren(draft.recipients?.length
      ? h('span', { class: 'muted' }, 'Found in their privacy policy: ', draft.recipients.map(r => h('a', { href: '#', onClick: (e) => { e.preventDefault(); recipient.value = r; } }, r, ' ')))
      : h('span', { class: 'muted' }, 'No contact address was published in their privacy policy — look for a grievance officer or privacy email on their site.'));
  }
  lawSel.addEventListener('change', () => { law = lawSel.value; if (!existing) load(); else lawNote.textContent = meta.laws[law].note; });
  await load();

  const save = async (status) => {
    let rec = existing;
    if (!rec) rec = await api('/api/requests', { method: 'POST', body: { orgDomain: draft.orgDomain, siteId: draft.siteId, aliasId: draft.aliasId, leakId: draft.leakId, law, recipient: recipient.value, subject: subject.value, body: body.value } });
    rec = await api(`/api/requests/${rec.id}`, { method: 'PATCH', body: { status: status || rec.status, recipient: recipient.value, subject: subject.value, body: body.value } });
    return rec;
  };
  const m = modal(`Erasure request — ${draft.orgDomain}`, h('div', { class: 'stack' },
    h('div', { class: 'grid g2' }, h('div', { class: 'field' }, h('label', {}, 'Legal basis'), lawSel), h('div', { class: 'field' }, h('label', {}, 'Send to'), recipient)),
    suggestions, lawNote,
    h('div', { class: 'field' }, h('label', {}, 'Subject'), subject),
    h('div', { class: 'field' }, h('label', {}, 'Letter'), body),
    h('div', { class: 'small muted' }, `Send it from ${draft.address || 'the address in question'} so the company can verify you control it.`)), [
    button('Copy letter', { ico: 'copy', onClick: () => copy(`Subject: ${subject.value}\n\n${body.value}`) }),
    button('Save draft', { onClick: async () => { await save('draft'); toast('Draft saved', 'success'); m.close(); rerender(); } }),
    button('Open in mail app & mark sent', { kind: 'primary', ico: 'send', onClick: async () => {
      if (!recipient.value) { toast('Add a recipient address first', 'warn'); return; }
      await save('sent');
      const a = h('a', { href: `mailto:${encodeURIComponent(recipient.value)}?subject=${encodeURIComponent(subject.value)}&body=${encodeURIComponent(body.value)}` });
      document.body.append(a); a.click(); a.remove();
      toast('Marked as sent — TraceMask will remind you to follow up in 30 days', 'success', 6000); m.close(); rerender();
    } })
  ]);
}

export async function requestsView() {
  const rows = await api('/api/requests');
  const setStatus = async (r, status) => { await api(`/api/requests/${r.id}`, { method: 'PATCH', body: { status } }); toast(`Marked ${status}`, 'success'); rerender(); };
  const badge = (s) => h('span', { class: `badge ${{ draft: 'st-muted', sent: 'st-info', responded: 'st-ok', closed: 'st-ok' }[s]}` }, s);
  const overdue = (r) => r.status === 'sent' && r.follow_up_at && new Date(r.follow_up_at) < new Date();
  return h('div', { class: 'stack' },
    h('div', { class: 'note' }, 'Unsubscribing stops the emails, but your data stays on file. These letters ask the organisation to erase it — backed by leak evidence where TraceMask has it.'),
    h('div', { class: 'card table-wrap' }, rows.length ? h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Organisation', 'Basis', 'Status', 'Created', 'Follow up', ''].map(t => h('th', {}, t)))),
      h('tbody', {}, rows.map(r => h('tr', {},
        h('td', {}, h('div', { class: 'cell-main' }, r.org_domain), h('div', { class: 'cell-sub' }, r.recipient || 'no recipient yet'), r.leak_id ? h('span', { class: 'badge st-bad' }, 'with leak evidence') : null),
        h('td', { class: 'small' }, r.law.toUpperCase()),
        h('td', {}, badge(r.status), overdue(r) ? h('div', { class: 'cell-sub', style: { color: 'var(--bad)' } }, 'follow-up due') : null),
        h('td', { class: 'small' }, fmtDate(r.created_at)),
        h('td', { class: 'small' }, r.follow_up_at ? ago(r.follow_up_at) : '—'),
        h('td', { style: { textAlign: 'right' } }, h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
          button('Open', { size: 'sm', onClick: () => openErasureComposer(null, r) }),
          button('PDF', { size: 'sm', kind: 'ghost', ico: 'download', title: 'Download the letter as PDF', onClick: () => downloadPdf(`/api/reports/request/${r.id}`).catch(e => toast(e.message, 'error')) }),
          r.status === 'sent' ? button('Got reply', { size: 'sm', kind: 'ghost', onClick: () => setStatus(r, 'responded') }) : null,
          r.status === 'responded' ? button('Close', { size: 'sm', kind: 'ghost', onClick: () => setStatus(r, 'closed') }) : null,
          r.status === 'draft' ? h('button', { class: 'icon-btn', title: 'Delete draft', onClick: async () => { await api(`/api/requests/${r.id}`, { method: 'DELETE' }); rerender(); } }, icon('trash', 16)) : null))))))
      : empty('No erasure requests yet', 'Draft one from a leak in the Leak Center, or for any organisation on your Exposure Map.')));
}
