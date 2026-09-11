// RFC 5322 header parsing, RFC 2047 encoded-word decoding, address-list and
// Authentication-Results parsing. Written in-house so the app has zero third-party dependencies.

export function parseHeaders(raw) {
  const text = (Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw || '')).slice(0, 65536); // cap hostile headers
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
  const out = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim().slice(0, 8192);
    (out[name] ||= []).push(value);
  }
  return out;
}
export const first = (h, name) => (h[name] && h[name][0]) || '';

function latin1ToUtf8IfNeeded(s) {
  // Raw 8-bit headers arrive as latin1 code units; reinterpret them as UTF-8 when valid.
  if (!/[\x80-\xff]/.test(s)) return s;
  const buf = Buffer.from(s, 'latin1');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return s; }
}

export function decodeWords(value) {
  if (!value) return '';
  let s = latin1ToUtf8IfNeeded(value);
  s = s.replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, '$1'); // whitespace between encoded words is dropped
  return s.replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bBqQ])\?([^?]*)\?=/g, (m, charset, enc, data) => {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') bytes = Buffer.from(data, 'base64');
      else bytes = Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g,
        (x, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch { return m; }
  });
}

// Split on commas that are not inside quotes, angle brackets or comments
function splitAddressList(s) {
  const parts = []; let cur = ''; let q = false, angle = 0, paren = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && q) { cur += c + (s[++i] || ''); continue; }
    if (c === '"') q = !q;
    else if (!q && c === '<') angle++;
    else if (!q && c === '>') angle = Math.max(0, angle - 1);
    else if (!q && c === '(') paren++;
    else if (!q && c === ')') paren = Math.max(0, paren - 1);
    if (c === ',' && !q && !angle && !paren) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const EMAIL_RE = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

export function parseAddressList(value) {
  if (!value) return [];
  let s = decodeWords(value);
  s = s.replace(/[^:,<>"]+:([^;]*);/g, '$1'); // flatten RFC 5322 groups "Team: a@x, b@y;"
  const out = [];
  for (const part of splitAddressList(s)) {
    const angle = part.match(/<([^>]*)>/);
    let address = angle ? angle[1] : (part.replace(/\([^)]*\)/g, '').match(EMAIL_RE) || [''])[0];
    address = address.trim().replace(/^mailto:/i, '').toLowerCase();
    if (!EMAIL_RE.test(address)) continue;
    let name = angle ? part.slice(0, angle.index) : '';
    name = name.replace(/^\s*"|"\s*$/g, '').replace(/\\"/g, '"').trim();
    out.push({ address, name, domain: address.split('@')[1] });
  }
  return out;
}

// Authentication-Results (RFC 8601): results added by the receiving provider (e.g. Gmail's mx.google.com)
export function parseAuthResults(values = [], dkimSigs = []) {
  const res = { spf: null, spfDomain: null, dkim: [], dmarc: null, dmarcDomain: null, authserv: null };
  const v = values[0] || ''; // topmost header = added by the user's own provider
  if (v) {
    res.authserv = v.split(';')[0].trim().split(/\s/)[0];
    for (const clause of v.split(';').slice(1)) {
      const c = clause.trim();
      let m;
      if ((m = c.match(/^spf=(\w+)/i))) {
        res.spf = m[1].toLowerCase();
        const d = c.match(/smtp\.mailfrom=(?:"?[^\s@"]*@)?([^\s;"]+)/i);
        if (d) res.spfDomain = d[1].toLowerCase();
      } else if ((m = c.match(/^dkim=(\w+)/i))) {
        const d = c.match(/header\.(?:d|i)=@?(?:[^\s@]*@)?([^\s;]+)/i);
        res.dkim.push({ result: m[1].toLowerCase(), domain: d ? d[1].toLowerCase() : null });
      } else if ((m = c.match(/^dmarc=(\w+)/i))) {
        res.dmarc = m[1].toLowerCase();
        const d = c.match(/header\.from=([^\s;]+)/i);
        if (d) res.dmarcDomain = d[1].toLowerCase();
      }
    }
  }
  // DKIM-Signature d= tags give the claimed signing domains even when no A-R header exists
  res.signers = dkimSigs.map(s => (s.match(/(?:^|;)\s*d=([^;\s]+)/i) || [])[1]).filter(Boolean).map(x => x.toLowerCase());
  return res;
}

export function parseDate(value) {
  if (!value) return null;
  const d = new Date(value.replace(/\([^)]*\)/g, '').trim());
  return isNaN(d) ? null : d.toISOString();
}
