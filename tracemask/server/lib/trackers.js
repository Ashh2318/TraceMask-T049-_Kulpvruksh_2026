// Tracker classification using Disconnect's open tracking-protection list (the list used by
// Firefox Enhanced Tracking Protection). Downloaded on first use and cached for 7 days.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../db.js';
import { registrable } from './psl.js';

const CACHE = path.join(DATA_DIR, 'disconnect_services.json');
const SOURCE = 'https://raw.githubusercontent.com/disconnectme/disconnect-tracking-protection/master/services.json';
const MAX_AGE = 7 * 24 * 3600 * 1000;
const TRACKING_CATEGORIES = new Set(['Advertising', 'Analytics', 'Social', 'Fingerprinting', 'FingerprintingInvasive',
  'FingerprintingGeneral', 'Cryptomining', 'Email', 'EmailAggressive']);

let index = null; // registrable domain -> { company, category }
let meta = { source: 'not loaded', loadedAt: null, domains: 0 };

function build(json) {
  const map = new Map();
  for (const [category, entries] of Object.entries(json.categories || {})) {
    if (!TRACKING_CATEGORIES.has(category)) continue;
    for (const entry of entries) {
      for (const [company, sites] of Object.entries(entry)) {
        for (const domains of Object.values(sites)) {
          if (!Array.isArray(domains)) continue;
          for (const d of domains) {
            const key = String(d).toLowerCase();
            if (!map.has(key)) map.set(key, { company, category });
          }
        }
      }
    }
  }
  return map;
}

export async function loadTrackers() {
  if (index) return meta;
  let cached = null;
  try {
    const st = fs.statSync(CACHE);
    cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    index = build(cached);
    meta = { source: 'Disconnect (cached)', loadedAt: new Date(st.mtimeMs).toISOString(), domains: index.size };
    if (Date.now() - st.mtimeMs < MAX_AGE) return meta;
  } catch { /* none */ }
  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const built = build(json);
    if (built.size < 500) throw new Error('unexpected list size');
    fs.writeFileSync(CACHE, JSON.stringify(json));
    index = built;
    meta = { source: 'Disconnect', loadedAt: new Date().toISOString(), domains: index.size };
  } catch (e) {
    if (!index) meta = { source: `unavailable (${e.message})`, loadedAt: null, domains: 0 };
    index = index || null;
  }
  return meta;
}

export function trackerMeta() { return meta; }

export function classifyHost(host) {
  if (!index) return null;
  const h = String(host).toLowerCase();
  const parts = h.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const hit = index.get(parts.slice(i).join('.'));
    if (hit) return hit;
  }
  return index.get(registrable(h)) || null;
}
