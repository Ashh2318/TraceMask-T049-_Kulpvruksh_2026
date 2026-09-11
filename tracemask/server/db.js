// SQLite storage using Node's built-in node:sqlite (no third-party driver).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.TRACEMASK_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'tracemask.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mailbox (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  enc_password TEXT NOT NULL,
  base_address TEXT NOT NULL,
  alias_mode TEXT NOT NULL DEFAULT 'plus',
  alias_domain TEXT,
  created_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_sync_status TEXT,
  last_sync_error TEXT
);
CREATE TABLE IF NOT EXISTS folder_state (
  folder TEXT PRIMARY KEY,
  uidvalidity TEXT NOT NULL,
  last_uid INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  title TEXT,
  risk_score INTEGER,
  risk_level TEXT,
  scan_json TEXT,
  privacy_url TEXT,
  contact_emails TEXT NOT NULL DEFAULT '[]',
  trusted_domains TEXT NOT NULL DEFAULT '[]',
  scanned_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  tier INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  expires_at TEXT,
  blocked_senders TEXT NOT NULL DEFAULT '[]',
  note TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder TEXT NOT NULL,
  uidvalidity TEXT NOT NULL,
  uid INTEGER NOT NULL,
  message_id TEXT,
  alias_id INTEGER REFERENCES aliases(id) ON DELETE CASCADE,
  to_addr TEXT,
  from_addr TEXT,
  from_name TEXT,
  from_domain TEXT,
  subject TEXT,
  received_at TEXT,
  auth_json TEXT,
  classification TEXT NOT NULL,
  reason TEXT,
  has_unsubscribe INTEGER NOT NULL DEFAULT 0,
  in_spam INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  UNIQUE (folder, uidvalidity, uid)
);
CREATE INDEX IF NOT EXISTS idx_messages_alias ON messages(alias_id);
CREATE INDEX IF NOT EXISTS idx_messages_class ON messages(classification);
CREATE INDEX IF NOT EXISTS idx_messages_domain ON messages(from_domain);
CREATE TABLE IF NOT EXISTS leaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_id INTEGER NOT NULL REFERENCES aliases(id) ON DELETE CASCADE,
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  sender_domain TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 1,
  evidence_json TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  UNIQUE (alias_id, sender_domain)
);
CREATE TABLE IF NOT EXISTS erasure_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  org_domain TEXT NOT NULL,
  alias_id INTEGER REFERENCES aliases(id) ON DELETE SET NULL,
  leak_id INTEGER REFERENCES leaks(id) ON DELETE SET NULL,
  law TEXT NOT NULL,
  recipient TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  sent_at TEXT,
  follow_up_at TEXT,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  scanned INTEGER NOT NULL DEFAULT 0,
  alias_messages INTEGER NOT NULL DEFAULT 0,
  new_leaks INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE TABLE IF NOT EXISTS ext_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT
);
`);

// Lightweight migrations for databases created by earlier versions
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
if (!cols('messages').includes('raw_headers')) db.exec('ALTER TABLE messages ADD COLUMN raw_headers TEXT');
if (!cols('messages').includes('header_sha256')) db.exec('ALTER TABLE messages ADD COLUMN header_sha256 TEXT');

export const now = () => new Date().toISOString();

export function getMeta(key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setMeta(key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function audit(event, detail = '') {
  db.prepare('INSERT INTO audit_log(ts, event, detail) VALUES(?, ?, ?)').run(now(), event, String(detail).slice(0, 500));
}

export const DEFAULT_SETTINGS = {
  syncIntervalMin: 2,
  lookbackDays: 60,
  burnerHours: 24,
  quarantineEnabled: true,
  quarantineFolder: 'TraceMask-Quarantine',
  aliasStyle: 'named', // 'named' (site-tag + random) or 'opaque' (random only)
  idleEnabled: true
};
export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(getMeta('settings', {}) || {}) };
}
export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  setMeta('settings', next);
  return next;
}

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
