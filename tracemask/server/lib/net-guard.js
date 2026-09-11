// SSRF protection for the site scanner: only public internet addresses may be contacted,
// and every redirect hop is re-validated.
import dns from 'node:dns/promises';
import net from 'node:net';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

function ipv4ToInt(ip) { return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0; }
function inCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}
const V4_BLOCK = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
  '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'];

export function isPublicIp(ip) {
  if (net.isIPv4(ip)) return !V4_BLOCK.some(c => inCidr(ip, c));
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return false;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    if (/^(fc|fd)/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || /^2001:db8/.test(x) || /^64:ff9b/.test(x)) return false;
    return true;
  }
  return false;
}

// Resolves a hostname and throws unless every address it resolves to is public.
export async function assertPublicHost(hostname) {
  let lookupError = null;
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw bad('Only public websites can be scanned');
  if (net.isIP(host)) { if (!isPublicIp(host)) throw bad('Only public websites can be scanned'); return [host]; }
  let addrs = [];
  try { addrs = (await dns.lookup(host, { all: true })).map(a => a.address); }
  catch (e) { lookupError = e.code || e.message; }
  if (!addrs.length) {
    // Fallback to direct DNS queries (some Windows setups fail getaddrinfo for Node while DNS works)
    const r = new dns.Resolver({ timeout: 4000, tries: 2 });
    const [a4, a6] = await Promise.all([r.resolve4(host).catch(() => []), r.resolve6(host).catch(() => [])]);
    addrs = [...a4, ...a6];
  }
  if (!addrs.length) throw bad(`${host} does not resolve in DNS${lookupError ? ` (${lookupError})` : ''}`);
  if (!addrs.length || addrs.some(a => !isPublicIp(a))) throw bad(`${host} points to a private or reserved network address — refused`);
  return addrs;
}

// fetch() with manual redirects; each hop must be http(s) and resolve to public IPs.
export async function safeFetch(url, init = {}, maxHops = 5) {
  let current = new URL(url);
  for (let hop = 0; hop <= maxHops; hop++) {
    if (!/^https?:$/.test(current.protocol)) throw bad('Only http(s) URLs are allowed');
    if (current.username || current.password) throw bad('URLs with embedded credentials are not allowed');
    await assertPublicHost(current.hostname);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      current = new URL(res.headers.get('location'), current);
      continue;
    }
    Object.defineProperty(res, 'finalUrl', { value: current.href });
    return res;
  }
  throw bad('Too many redirects');
}
