// Leak attribution: an alias is created for exactly one organisation, so any *other* organisation
// that emails it must have obtained it from that organisation (sharing, sale or breach).
import { registrable, brandLabel } from './psl.js';

export function classifyAliasMessage({ fromDomain, auth, siteDomain, trusted = [] }) {
  const from = registrable(fromDomain || '');
  const site = registrable(siteDomain || '');
  const signers = new Set([...(auth?.dkim || []).filter(d => d.result === 'pass' && d.domain).map(d => registrable(d.domain))]);
  const authenticated = auth?.dmarc === 'pass' || [...signers].includes(from);

  if (!site) return { classification: 'review', reason: 'Alias has no linked site to compare against', authenticated };
  if (from === site) return { classification: 'legit', reason: `Sender domain matches ${site}`, authenticated };
  if (trusted.includes(from)) return { classification: 'legit', reason: `${from} was marked as part of ${site}`, authenticated };
  if (signers.has(site)) return { classification: 'legit', reason: `Message is DKIM-signed by ${site}`, authenticated: true };
  if (brandLabel(from) === brandLabel(site) && brandLabel(site).length >= 3) {
    // Could be the same company on another TLD (hdfcbank.net) or a lookalike phishing domain (myntra.shop).
    // Never auto-trust it: flag for the user to confirm.
    return { classification: 'review', severity: 'review',
      reason: `${from} shares the “${brandLabel(site)}” brand but is not ${site} — confirm it is the same company (or a lookalike)`, authenticated };
  }
  return {
    classification: 'leak',
    severity: authenticated ? 'high' : 'medium',
    reason: authenticated
      ? `${from} (authenticated sender) is using an address that only ${site} was given`
      : `${from} (unauthenticated — possible spam/phishing) is using an address that only ${site} was given`,
    authenticated
  };
}
