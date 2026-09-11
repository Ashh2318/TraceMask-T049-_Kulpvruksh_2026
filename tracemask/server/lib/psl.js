// Registrable-domain (eTLD+1) resolution using the official Public Suffix List (publicsuffix.org).
// The list is downloaded on first run and cached in data/; a compact built-in rule set is used
// only until the download succeeds.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../db.js';

const CACHE = path.join(DATA_DIR, 'public_suffix_list.dat');
const SOURCE = 'https://publicsuffix.org/list/public_suffix_list.dat';
const MAX_AGE = 7 * 24 * 3600 * 1000;

const BUILTIN = `com net org edu gov mil int info biz io co ai app dev me in uk us au jp br cn sg nz za mx de fr
co.in net.in org.in gov.in ac.in edu.in res.in firm.in gen.in ind.in nic.in
co.uk org.uk ac.uk gov.uk me.uk com.au net.au org.au edu.au co.jp ne.jp or.jp com.br com.cn com.sg co.nz co.za com.mx
github.io blogspot.com vercel.app netlify.app herokuapp.com pages.dev web.app firebaseapp.com azurewebsites.net cloudfront.net`;

let rules = null;
let source = 'builtin';

function parse(text) {
  const r = { exact: new Set(), wild: new Set(), except: new Set() };
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('//')) continue;
    line = line.split(/\s/)[0].toLowerCase();
    if (line.startsWith('!')) r.except.add(line.slice(1));
    else if (line.startsWith('*.')) r.wild.add(line.slice(2));
    else r.exact.add(line);
  }
  return r;
}

export function pslSource() { return source; }

export async function initPsl() {
  try {
    const st = fs.statSync(CACHE);
    rules = parse(fs.readFileSync(CACHE, 'utf8'));
    source = 'publicsuffix.org (cached)';
    if (Date.now() - st.mtimeMs < MAX_AGE) return;
  } catch { /* no cache yet */ }
  if (!rules) rules = parse(BUILTIN.split(/\s+/).join('\n'));
  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length < 10000) throw new Error('unexpected list size');
    fs.writeFileSync(CACHE, text);
    rules = parse(text);
    source = 'publicsuffix.org';
  } catch (e) {
    console.warn(`[psl] could not refresh Public Suffix List (${e.message}); using ${source}`);
  }
}

export function normalizeHost(input) {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  if (s.includes('@')) s = s.split('@').pop();
  s = s.replace(/^[a-z]+:\/\//, '').split(/[\/?#:]/)[0].replace(/\.$/, '');
  try { s = new URL(`http://${s}`).hostname; } catch { /* keep */ }
  return s;
}

// Returns the registrable domain (e.g. mail.shop.example.co.in -> example.co.in)
export function registrable(hostInput) {
  const host = normalizeHost(hostInput);
  if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes('.')) return host;
  if (!rules) rules = parse(BUILTIN.split(/\s+/).join('\n'));
  const labels = host.split('.');
  let suffixLen = 1; // default rule "*"
  for (let i = 0; i < labels.length; i++) {
    const cand = labels.slice(i).join('.');
    const parent = labels.slice(i + 1).join('.');
    if (rules.except.has(cand)) { suffixLen = labels.length - i - 1; break; }
    if (rules.exact.has(cand)) { suffixLen = labels.length - i; break; }
    if (parent && rules.wild.has(parent)) { suffixLen = labels.length - i; break; }
  }
  if (suffixLen >= labels.length) return host;
  return labels.slice(labels.length - suffixLen - 1).join('.');
}

// First label of the registrable domain: "myntra" for myntra.com
export function brandLabel(hostInput) {
  const reg = registrable(hostInput);
  return reg.split('.')[0] || reg;
}
