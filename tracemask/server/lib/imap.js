// Minimal, dependency-free IMAP4rev1 client over TLS (RFC 3501 + UIDPLUS/MOVE/IDLE/SPECIAL-USE).
// Only implicit TLS (port 993) is supported on purpose: credentials never travel in plaintext.
import tls from 'node:tls';
import { EventEmitter } from 'node:events';

export function quote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function uidSet(uids) {
  const u = [...new Set(uids)].sort((a, b) => a - b);
  const out = []; let start = null, prev = null;
  for (const n of u) {
    if (start === null) { start = prev = n; continue; }
    if (n === prev + 1) { prev = n; continue; }
    out.push(start === prev ? `${start}` : `${start}:${prev}`); start = prev = n;
  }
  if (start !== null) out.push(start === prev ? `${start}` : `${start}:${prev}`);
  return out.join(',');
}

export function tokenize(parts) {
  const root = []; const stack = [root];
  const top = () => stack[stack.length - 1];
  for (let pi = 0; pi < parts.length; pi++) {
    const p = parts[pi];
    if (Buffer.isBuffer(p)) { top().push(p); continue; }
    let s = p;
    if (pi + 1 < parts.length && Buffer.isBuffer(parts[pi + 1])) s = s.replace(/\{\d+\+?\}$/, '');
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ') { i++; continue; }
      if (c === '(') { const a = []; top().push(a); stack.push(a); i++; continue; }
      if (c === ')') { if (stack.length > 1) stack.pop(); i++; continue; }
      if (c === '"') {
        let j = i + 1, out = '';
        while (j < s.length && s[j] !== '"') { if (s[j] === '\\') j++; out += s[j] ?? ''; j++; }
        top().push(out); i = j + 1; continue;
      }
      let j = i, depth = 0;
      while (j < s.length) {
        const d = s[j];
        if (d === '[') depth++;
        else if (d === ']') depth = Math.max(0, depth - 1);
        else if (depth === 0 && (d === ' ' || d === '(' || d === ')')) break;
        j++;
      }
      const atom = s.slice(i, j);
      top().push(atom.toUpperCase() === 'NIL' ? null : atom);
      i = j;
    }
  }
  return root;
}

export class ImapClient extends EventEmitter {
  constructor({ host, port = 993, user, pass, timeoutMs = 45000 }) {
    super();
    Object.assign(this, { host, port, user, pass, timeoutMs });
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.literalLeft = -1;
    this.tagN = 0;
    this.current = null;
    this.queue = Promise.resolve();
    this.capabilities = new Set();
    this.closed = false;
    this.greeted = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = tls.connect({ host: this.host, port: this.port, servername: this.host, minVersion: 'TLSv1.2' });
      this.sock = sock;
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; reject(err); } };
      sock.setTimeout(this.timeoutMs, () => { const e = new Error('IMAP connection timed out'); this._abort(e); fail(e); sock.destroy(); });
      sock.on('error', (e) => { this._abort(e); fail(e); });
      sock.on('close', () => { this.closed = true; this._abort(new Error('IMAP connection closed')); fail(new Error('IMAP connection closed')); this.emit('close'); });
      sock.on('data', (d) => this._onData(d));
      this.once('greeting', (line) => {
        if (settled) return;
        settled = true;
        if (/^\* (OK|PREAUTH)/i.test(line)) { this._parseCaps(line); resolve(); }
        else reject(new Error(`IMAP server refused connection: ${line}`));
      });
    });
  }

  _abort(err) {
    if (this.current) { const c = this.current; this.current = null; c.reject(err); }
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.literalLeft < 0 && this.buf.length > 1024 * 1024 && this.buf.indexOf('\r\n') < 0) { this.sock.destroy(new Error('IMAP line too long')); return; }
    for (;;) {
      if (this.literalLeft >= 0) {
        if (this.buf.length < this.literalLeft) return;
        this.parts.push(this.buf.subarray(0, this.literalLeft));
        this.buf = this.buf.subarray(this.literalLeft);
        this.literalLeft = -1;
        continue;
      }
      const idx = this.buf.indexOf('\r\n');
      if (idx < 0) return;
      const line = this.buf.subarray(0, idx).toString('latin1');
      this.buf = this.buf.subarray(idx + 2);
      this.parts.push(line);
      const lit = line.match(/\{(\d+)\+?\}$/);
      if (lit) {
        this.literalLeft = parseInt(lit[1], 10);
        if (this.literalLeft > 25 * 1024 * 1024) { this.sock.destroy(new Error('IMAP literal too large')); return; }
        continue;
      }
      const parts = this.parts; this.parts = [];
      this._onResponse(parts);
    }
  }

  _onResponse(parts) {
    const text = parts.filter(p => typeof p === 'string').join(' ');
    if (!this.greeted) { this.greeted = true; this.emit('greeting', text); return; }
    if (text.startsWith('+')) { if (this.current?.onContinue) this.current.onContinue(text); return; }
    if (text.startsWith('*')) {
      const resp = { text, parts };
      if (/^\* \d+ EXISTS/i.test(text)) this.emit('exists', parseInt(text.split(' ')[1], 10));
      if (/^\* CAPABILITY /i.test(text) || /^\* OK \[CAPABILITY/i.test(text)) this._parseCaps(text);
      if (/^\* BYE/i.test(text)) this.emit('bye', text);
      if (this.current) this.current.untagged.push(resp);
      return;
    }
    const [tag, status = '', ...rest] = text.split(' ');
    if (this.current && tag === this.current.tag) {
      const c = this.current; this.current = null;
      const info = rest.join(' ');
      if (/\[CAPABILITY/i.test(info)) this._parseCaps(info);
      if (status.toUpperCase() === 'OK') c.resolve({ untagged: c.untagged, text: info });
      else { const e = new Error(`IMAP ${status}: ${info}`); e.imapStatus = status; c.reject(e); }
    }
  }

  _parseCaps(text) {
    const m = text.match(/CAPABILITY ([^\]]+)/i);
    if (m) this.capabilities = new Set(m[1].trim().toUpperCase().split(/\s+/));
  }

  run(command, { onContinue } = {}) {
    const exec = () => new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('IMAP connection closed'));
      const tag = `T${++this.tagN}`;
      this.current = { tag, resolve, reject, untagged: [], onContinue };
      this.sock.write(`${tag} ${command}\r\n`);
    });
    const p = this.queue.then(exec, exec);
    this.queue = p.catch(() => {});
    return p;
  }

  async login() {
    if (!this.capabilities.size) await this.run('CAPABILITY');
    try {
      if (this.capabilities.has('AUTH=PLAIN') && this.capabilities.has('SASL-IR')) {
        const NUL = String.fromCharCode(0);
        const token = Buffer.from(NUL + this.user + NUL + this.pass, 'utf8').toString('base64');
        await this.run(`AUTHENTICATE PLAIN ${token}`);
      } else {
        await this.run(`LOGIN ${quote(this.user)} ${quote(this.pass)}`);
      }
    } catch (e) {
      const err = new Error(/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed|AUTHENTICATE failed/i.test(e.message)
        ? 'Login rejected by the mail server. For Gmail, use a 16-character App Password (Google Account → Security → 2-Step Verification → App passwords), not your normal password.'
        : e.message);
      err.status = 401;
      throw err;
    }
    await this.run('CAPABILITY');
  }

  async list() {
    const r = await this.run('LIST "" "*"');
    return r.untagged.filter(u => /^\* LIST /i.test(u.text)).map(u => {
      const t = tokenize(u.parts);
      const flags = (Array.isArray(t[2]) ? t[2] : []).map(f => String(f).toLowerCase());
      const name = Buffer.isBuffer(t[4]) ? t[4].toString('latin1') : String(t[4] ?? '');
      return { name, flags, delimiter: t[3] };
    });
  }

  async select(folder) {
    const r = await this.run(`SELECT ${quote(folder)}`);
    const info = { exists: 0, uidvalidity: null, uidnext: null };
    for (const u of r.untagged) {
      let m;
      if ((m = u.text.match(/^\* (\d+) EXISTS/i))) info.exists = parseInt(m[1], 10);
      if ((m = u.text.match(/UIDVALIDITY (\d+)/i))) info.uidvalidity = m[1];
      if ((m = u.text.match(/UIDNEXT (\d+)/i))) info.uidnext = parseInt(m[1], 10);
    }
    return info;
  }

  async uidSearch(criteria) {
    const r = await this.run(`UID SEARCH ${criteria}`);
    const out = [];
    for (const u of r.untagged) {
      if (/^\* SEARCH/i.test(u.text)) out.push(...u.text.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean).map(Number));
    }
    return out.filter(Number.isFinite);
  }

  async fetchHeaders(uids, fields) {
    if (!uids.length) return [];
    const r = await this.run(`UID FETCH ${uidSet(uids)} (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (${fields.join(' ')})])`);
    const out = [];
    for (const u of r.untagged) {
      if (!/^\* \d+ FETCH/i.test(u.text)) continue;
      const t = tokenize(u.parts);
      const list = t.find(Array.isArray) || [];
      const item = {};
      for (let i = 0; i < list.length - 1; i += 2) {
        const key = String(list[i]).toUpperCase();
        const val = list[i + 1];
        if (key === 'UID') item.uid = parseInt(val, 10);
        else if (key === 'INTERNALDATE') item.internalDate = val;
        else if (key.startsWith('BODY[')) item.header = Buffer.isBuffer(val) ? val : Buffer.from(String(val ?? ''), 'latin1');
      }
      if (item.uid) out.push(item);
    }
    return out;
  }

  async ensureFolder(name) {
    try { await this.run(`CREATE ${quote(name)}`); }
    catch (e) { if (!/ALREADYEXISTS|exists|duplicate/i.test(e.message)) throw e; }
  }

  async moveUids(uids, dest) {
    if (!uids.length) return 0;
    const set = uidSet(uids);
    if (this.capabilities.has('MOVE')) await this.run(`UID MOVE ${set} ${quote(dest)}`);
    else {
      await this.run(`UID COPY ${set} ${quote(dest)}`);
      await this.run(`UID STORE ${set} +FLAGS.SILENT (\\Deleted)`);
      if (this.capabilities.has('UIDPLUS')) await this.run(`UID EXPUNGE ${set}`);
    }
    return uids.length;
  }

  // IDLE (RFC 2177): resolves once the server says "+ idling"; stopIdle() ends it.
  startIdle() {
    return new Promise((resolve, reject) => {
      this.sock.setTimeout(0);
      this.idlePromise = this.run('IDLE', { onContinue: () => resolve() });
      this.idlePromise.catch(reject);
    });
  }
  async stopIdle() {
    if (!this.idlePromise) return;
    const p = this.idlePromise;
    this.sock.write('DONE\r\n');
    try { await p; } finally { this.idlePromise = null; if (!this.closed) this.sock.setTimeout(this.timeoutMs); }
  }

  async logout() {
    try { await Promise.race([this.run('LOGOUT'), new Promise(r => setTimeout(r, 3000))]); } catch { /* ignore */ }
    this.sock?.destroy();
  }
}

export async function withImap(cfg, fn) {
  const c = new ImapClient(cfg);
  await c.connect();
  try { await c.login(); return await fn(c); }
  finally { await c.logout(); }
}
