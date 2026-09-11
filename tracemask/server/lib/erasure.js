// Drafts data-erasure requests from real records (alias, site, leak evidence).
const fmt = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : 'an earlier date';

export const LAWS = {
  dpdp: { name: "India — Digital Personal Data Protection Act, 2023", followUpDays: 30,
    note: 'Under the DPDP Rules 2025, most data-principal obligations on companies apply from 13 May 2027. Until then this is a formal request citing the Act and the company\'s own policy.' },
  gdpr: { name: 'EU/UK — GDPR Article 17 (right to erasure)', followUpDays: 30,
    note: 'Applies to organisations established in, or targeting people in, the EU/UK. Controllers must respond within one month (Art. 12(3)).' },
  generic: { name: 'Policy-based request', followUpDays: 30,
    note: 'Relies on the organisation\'s own privacy policy and deletion process.' }
};

export function draftErasure({ law = 'dpdp', orgDomain, orgName, address, aliasCreated, leak, userName }) {
  const org = orgName || orgDomain;
  const subject = `Request to erase my personal data — ${address}`;
  const lines = [];
  lines.push(`To the Grievance / Data Protection Officer, ${org},`, '');
  if (law === 'dpdp') {
    lines.push(`I am writing as a Data Principal to request, in line with Sections 12 and 13 of the Digital Personal Data Protection Act, 2023 and your published privacy policy, that you:`);
  } else if (law === 'gdpr') {
    lines.push(`I am writing to exercise my right to erasure under Article 17 of the General Data Protection Regulation. Please:`);
  } else {
    lines.push(`In accordance with your published privacy policy, I request that you:`);
  }
  lines.push(
    `  1. Erase all personal data associated with the email address ${address}, including account, marketing and analytics records;`,
    `  2. Stop all processing of that data, including marketing communications and any sharing with third parties;`,
    law === 'dpdp'
      ? `  3. Inform me of the identities of all other Data Fiduciaries and Data Processors with whom this data has been shared (Section 11(1)(b));`
      : `  3. Inform me of every third party with whom this data has been shared, and pass this erasure request on to them;`,
    `  4. Confirm in writing once erasure is complete.`, '');
  if (leak) {
    lines.push(
      `Evidence of onward disclosure: the address ${address} was created exclusively for ${orgDomain} on ${fmt(aliasCreated)} and was never given to anyone else. ` +
      `On ${fmt(leak.first_seen)}, it received email from ${leak.sender_domain}${leak.message_count > 1 ? ` (${leak.message_count} messages so far)` : ''}. ` +
      `This indicates the address was shared, sold or exposed in a breach. Please explain how ${leak.sender_domain} obtained it.`, '');
  }
  lines.push(`Please treat this message as verification that I control this address — reply to it directly.`, '',
    `Regards,`, userName || 'Data Principal', address);
  return { subject, body: lines.join('\n'), lawInfo: LAWS[law] };
}
