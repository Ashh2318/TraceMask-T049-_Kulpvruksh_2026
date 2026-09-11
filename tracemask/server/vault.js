// Local zero-knowledge vault: the master password never leaves this machine and is never stored.
// scrypt -> key-encryption key (KEK) -> unwraps a random 256-bit data key -> AES-256-GCM for secrets.
import crypto from 'node:crypto';
import { getMeta, setMeta, audit } from './db.js';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

let dataKey = null;              // held only in memory while unlocked
const sessions = new Map();      // token -> { lastSeen }
const failures = { count: 0, until: 0 };

const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 32, SCRYPT, (e, k) => (e ? rej(e) : res(k))));

function seal(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
}
function open(key, sealed) {
  const [iv, tag, ct] = sealed.split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export const isInitialized = () => !!getMeta('vault');
export const isUnlocked = () => !!dataKey;

export function passwordProblems(pw) {
  const p = [];
  if (typeof pw !== 'string' || pw.length < 10) p.push('Use at least 10 characters');
  if (!/[A-Za-z]/.test(pw || '') || !/[0-9\W_]/.test(pw || '')) p.push('Mix letters with numbers or symbols');
  return p;
}

export async function initVault(password) {
  if (isInitialized()) throw Object.assign(new Error('Vault already exists'), { status: 409 });
  const problems = passwordProblems(password);
  if (problems.length) throw Object.assign(new Error(problems.join('. ')), { status: 400 });
  const salt = crypto.randomBytes(16);
  const kek = await scrypt(password, salt);
  const dk = crypto.randomBytes(32);
  setMeta('vault', {
    v: 1,
    salt: salt.toString('base64'),
    wrapped: seal(kek, dk),
    check: seal(dk, Buffer.from('tracemask-ok')),
    createdAt: new Date().toISOString()
  });
  dataKey = dk;
  audit('vault.created');
  return newSession();
}

export async function unlock(password) {
  const v = getMeta('vault');
  if (!v) throw Object.assign(new Error('Vault not initialised'), { status: 400 });
  if (Date.now() < failures.until) {
    const s = Math.ceil((failures.until - Date.now()) / 1000);
    throw Object.assign(new Error(`Too many attempts. Try again in ${s}s`), { status: 429 });
  }
  const kek = await scrypt(String(password || ''), Buffer.from(v.salt, 'base64'));
  let dk;
  try {
    dk = open(kek, v.wrapped);
    if (open(dk, v.check).toString() !== 'tracemask-ok') throw new Error('check');
  } catch {
    failures.count += 1;
    if (failures.count >= 3) failures.until = Date.now() + Math.min(300, 2 ** (failures.count - 2) * 5) * 1000;
    audit('auth.failed', `attempt ${failures.count}`);
    throw Object.assign(new Error('Incorrect master password'), { status: 401 });
  }
  failures.count = 0; failures.until = 0;
  dataKey = dk;
  audit('auth.unlocked');
  return newSession();
}

export async function changePassword(oldPw, newPw) {
  const v = getMeta('vault');
  const kekOld = await scrypt(String(oldPw || ''), Buffer.from(v.salt, 'base64'));
  let dk;
  try { dk = open(kekOld, v.wrapped); } catch { throw Object.assign(new Error('Current password is incorrect'), { status: 401 }); }
  const problems = passwordProblems(newPw);
  if (problems.length) throw Object.assign(new Error(problems.join('. ')), { status: 400 });
  const salt = crypto.randomBytes(16);
  const kek = await scrypt(newPw, salt);
  setMeta('vault', { ...v, salt: salt.toString('base64'), wrapped: seal(kek, dk) });
  audit('vault.password_changed');
}

function newSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { lastSeen: Date.now() });
  return token;
}
export function checkSession(token) {
  if (!token || !dataKey) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() - s.lastSeen > SESSION_IDLE_MS) { sessions.delete(token); return false; }
  s.lastSeen = Date.now();
  return true;
}
// "Lock" locks the whole vault: every browser session and the browser extension lose access until the
// master password is entered again.
export function lock() {
  sessions.clear();
  dataKey = null;
  audit('auth.locked');
}
export function lockAll() { sessions.clear(); dataKey = null; }

export function encryptSecret(str) {
  if (!dataKey) throw Object.assign(new Error('Vault locked'), { status: 423 });
  return seal(dataKey, Buffer.from(str, 'utf8'));
}
export function decryptSecret(sealed) {
  if (!dataKey) throw Object.assign(new Error('Vault locked'), { status: 423 });
  return open(dataKey, sealed).toString('utf8');
}
