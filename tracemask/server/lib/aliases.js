// Alias generation and trust-tier policy.
import crypto from 'node:crypto';
import { brandLabel } from './psl.js';

export const TIERS = {
  0: { name: 'Burner', short: 'T0', desc: 'Expires automatically. For one-time downloads, events, trials.' },
  1: { name: 'Tracked', short: 'T1', desc: 'Unique alias; any third party that mails it is flagged and auto-quarantined.' },
  2: { name: 'Protected', short: 'T2', desc: 'Recovery-safe alias; leaks are flagged but mail is never auto-blocked.' },
  3: { name: 'Real identity', short: 'T3', desc: 'Bank, government or KYC — use your real details, keep a record.' }
};

export const PURPOSES = {
  oneoff: 'One-time: download, event, free trial, coupon',
  regular: 'Regular use: shopping, newsletter, community',
  critical: 'Long-term account: email, cloud, work tools I must be able to recover',
  kyc: 'Bank, government or KYC: regulated services that need verified identity'
};

export function recommendTier(purpose, riskScore) {
  const reasons = [];
  let tier;
  if (purpose === 'kyc') { tier = 3; reasons.push('Regulated services legally need your verified identity.'); }
  else if (purpose === 'oneoff') { tier = 0; reasons.push('You only need access once, so the identity should expire.'); }
  else if (purpose === 'critical') {
    tier = 2; reasons.push('You need password resets to keep working, so the alias is never auto-blocked.');
    if (riskScore >= 55) reasons.push('This site scored high risk: consider whether you need a long-term account here at all.');
  } else {
    tier = 1;
    reasons.push('Every sender other than this site will be treated as a leak and quarantined.');
    if (riskScore >= 55) reasons.push('High risk: if you will not return to this site, a Burner (T0) is safer.');
  }
  if (tier !== 3 && riskScore >= 75) reasons.push('Severe risk: share nothing beyond this alias (no phone, no date of birth).');
  const share = tier === 3 ? ['Details the regulator requires', 'Keep a copy of what you submitted']
    : tier === 0 ? ['This burner alias only', 'No phone number', 'No real name unless required']
      : tier === 1 ? ['This alias', 'First name only', 'Skip optional fields (DOB, gender, phone)']
        : ['This alias', 'Real name if the service requires it', 'Phone only if 2-factor login needs it'];
  return { tier, reasons, share, tierInfo: TIERS[tier] };
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function randomTag(n) {
  const bytes = crypto.randomBytes(n);
  return [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('');
}
function slugFor(domain) {
  return brandLabel(domain).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'site';
}

// plus mode: user+slug-rand@gmail.com  |  domain mode: slug-rand@your-catchall-domain
export function makeAlias(mailbox, domain, style = 'named') {
  const tag = style === 'opaque' ? randomTag(10) : `${slugFor(domain)}-${randomTag(5)}`;
  if (mailbox.alias_mode === 'domain' && mailbox.alias_domain) return `${tag}@${mailbox.alias_domain}`.toLowerCase();
  const [local, host] = mailbox.base_address.toLowerCase().split('@');
  return `${local.split('+')[0]}+${tag}@${host}`;
}

// Which alias, if any, a recipient address belongs to (exact match, case-insensitive)
export function recipientKey(addr) { return String(addr || '').trim().toLowerCase(); }
