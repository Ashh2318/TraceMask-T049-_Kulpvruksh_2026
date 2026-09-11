// Minimal, dependency-free PDF 1.7 writer with a simple flow layout engine
// (headings, paragraphs, key-value blocks, tables with repeating headers, callouts, code blocks,
// running header/footer with "Page X of Y"). Uses the PDF standard-14 fonts with WinAnsi encoding.
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const A4 = { w: 595.28, h: 841.89 };
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELVB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const SPECIAL = { 0x80: 556, 0x85: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0x99: 1000 };
const SPECIAL_B = { ...SPECIAL, 0x91: 278, 0x92: 278, 0x93: 500, 0x94: 500 };
const WIN = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
const TRANSLIT = { '₹': 'Rs.', '→': '->', '←': '<-', '↔': '<->', '✓': 'v', '✔': 'v', '✗': 'x', '≥': '>=', '≤': '<=', '≈': '~', '−': '-', ' ': ' ', ' ': ' ', '​': '' };

export function toWinAnsi(str) {
  const out = [];
  for (const ch of String(str ?? '').normalize('NFC')) {
    const cp = ch.codePointAt(0);
    if (ch === '\n' || ch === '\t') { out.push(32); continue; }
    if (cp >= 32 && cp < 127) out.push(cp);
    else if (WIN[ch]) out.push(WIN[ch]);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp);
    else if (TRANSLIT[ch] !== undefined) for (const c of TRANSLIT[ch]) out.push(c.charCodeAt(0));
    else if (cp > 0xffff || (cp >= 0x2600 && cp <= 0x27bf)) continue; // emoji & symbols: drop
    else {
      const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      const b = base.charCodeAt(0);
      out.push(base && b >= 32 && b < 256 ? b : 63);
    }
  }
  return out;
}
const esc = (bytes) => bytes.map(b => (b === 40 || b === 41 || b === 92) ? '\\' + String.fromCharCode(b) : (b >= 32 && b < 127) ? String.fromCharCode(b) : '\\' + b.toString(8).padStart(3, '0')).join('');

const FONTS = { reg: 'F1', bold: 'F2', mono: 'F3', ital: 'F4' };
function charWidth(code, font) {
  if (font === 'mono') return 600;
  const t = font === 'bold' ? HELVB : HELV;
  if (code >= 32 && code <= 126) return t[code - 32];
  const s = font === 'bold' ? SPECIAL_B : SPECIAL;
  return s[code] || (code >= 0xc0 ? 611 : 556);
}
export function textWidth(str, font = 'reg', size = 10) {
  return toWinAnsi(str).reduce((w, c) => w + charWidth(c, font), 0) * size / 1000;
}
const hex = (c) => { const n = parseInt(c.replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255].map(v => v.toFixed(3)).join(' '); };

export class PdfDoc {
  constructor({ title, subject = '', reportId = '', classification = 'CONFIDENTIAL', accent = '#4f46e5' } = {}) {
    Object.assign(this, { title, subject, reportId, classification, accent });
    this.m = { l: 50, r: 50, t: 78, b: 64 };
    this.pages = [];
    this.createdAt = new Date();
    this.newPage();
  }
  get width() { return A4.w - this.m.l - this.m.r; }
  newPage() { this.page = []; this.pages.push(this.page); this.y = A4.h - this.m.t; }
  ensure(h) { if (this.y - h < this.m.b) { this.newPage(); return true; } return false; }
  op(s) { this.page.push(s); }
  text(x, y, str, { font = 'reg', size = 10, color = '#111827' } = {}) {
    this.op(`BT /${FONTS[font]} ${size} Tf ${hex(color)} rg ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(toWinAnsi(str))}) Tj ET`);
  }
  rect(x, y, w, h, { fill, stroke, lw = 0.6 } = {}) {
    let s = 'q ';
    if (fill) s += `${hex(fill)} rg `;
    if (stroke) s += `${hex(stroke)} RG ${lw} w `;
    s += `${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'} Q`;
    this.op(s);
  }
  line(x1, y1, x2, y2, color = '#e5e7eb', lw = 0.6) { this.op(`q ${hex(color)} RG ${lw} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S Q`); }

  wrap(str, font, size, maxW) {
    const lines = [];
    for (const para of String(str ?? '').split('\n')) {
      const words = para.split(/(\s+)/).filter(w => w.length);
      let cur = '';
      for (const w of words) {
        const cand = cur + w;
        if (textWidth(cand.trimEnd(), font, size) <= maxW) { cur = cand; continue; }
        if (cur.trim()) lines.push(cur.trimEnd());
        cur = /^\s+$/.test(w) ? '' : w;
        while (textWidth(cur, font, size) > maxW) { // hard-break very long tokens (addresses, hashes)
          let i = cur.length;
          while (i > 1 && textWidth(cur.slice(0, i), font, size) > maxW) i--;
          lines.push(cur.slice(0, i)); cur = cur.slice(i);
        }
      }
      lines.push(cur.trimEnd());
    }
    return lines;
  }

  // ---------- flow elements ----------
  cover({ kicker, title, subtitle, meta = [] }) {
    this.hasCover = true;
    this.rect(0, A4.h - 210, A4.w, 210, { fill: '#0d1224' });
    this.rect(0, A4.h - 214, A4.w, 4, { fill: this.accent });
    this.text(this.m.l, A4.h - 70, kicker || 'TRACEMASK', { font: 'bold', size: 9.5, color: '#a5b4fc' });
    let y = A4.h - 102;
    for (const l of this.wrap(title, 'bold', 22, this.width)) { this.text(this.m.l, y, l, { font: 'bold', size: 22, color: '#ffffff' }); y -= 27; }
    if (subtitle) for (const l of this.wrap(subtitle, 'reg', 10.5, this.width)) { this.text(this.m.l, y - 2, l, { size: 10.5, color: '#c7cbe6' }); y -= 14; }
    this.y = A4.h - 240;
    if (meta.length) this.kv(meta, { labelW: 120, size: 9.5 });
    this.space(6);
  }
  h1(t) { this.ensure(90); this.space(8); this.text(this.m.l, this.y - 14, t, { font: 'bold', size: 14, color: '#0d1224' }); this.y -= 20; this.line(this.m.l, this.y, this.m.l + this.width, this.y, this.accent, 1.2); this.y -= 10; }
  h2(t) { this.ensure(70); this.space(4); this.text(this.m.l, this.y - 11, t, { font: 'bold', size: 11, color: '#1f2937' }); this.y -= 18; }
  space(n = 8) { this.y -= n; }
  p(str, { size = 9.5, font = 'reg', color = '#374151', indent = 0, lh = 1.42 } = {}) {
    for (const l of this.wrap(str, font, size, this.width - indent)) {
      this.ensure(size * lh);
      this.text(this.m.l + indent, this.y - size, l, { font, size, color });
      this.y -= size * lh;
    }
    this.y -= 3;
  }
  bullets(items, { size = 9.5 } = {}) {
    for (const it of items) {
      const lines = this.wrap(it, 'reg', size, this.width - 14);
      lines.forEach((l, i) => {
        this.ensure(size * 1.42);
        if (i === 0) this.text(this.m.l + 3, this.y - size, '•', { size, color: this.accent });
        this.text(this.m.l + 14, this.y - size, l, { size, color: '#374151' });
        this.y -= size * 1.42;
      });
    }
    this.y -= 3;
  }
  kv(pairs, { labelW = 150, size = 9.5 } = {}) {
    for (const [k, v] of pairs) {
      const lines = this.wrap(String(v ?? '—'), 'reg', size, this.width - labelW);
      const h = lines.length * size * 1.4 + 2;
      this.ensure(h);
      this.text(this.m.l, this.y - size, k, { font: 'bold', size, color: '#6b7280' });
      lines.forEach((l, i) => this.text(this.m.l + labelW, this.y - size - i * size * 1.4, l, { size, color: '#111827' }));
      this.y -= h + 2;
    }
    this.y -= 2;
  }
  callout(title, body, { fill = '#eef0ff', stroke = '#c7cbf7', titleColor = '#3730a3' } = {}) {
    const size = 9.5;
    const lines = this.wrap(body, 'reg', size, this.width - 24);
    const h = 16 + (title ? 16 : 0) + lines.length * size * 1.42;
    this.ensure(h + 6);
    this.rect(this.m.l, this.y - h, this.width, h, { fill, stroke });
    this.rect(this.m.l, this.y - h, 3.5, h, { fill: titleColor });
    let y = this.y - 8;
    if (title) { this.text(this.m.l + 14, y - 10, title, { font: 'bold', size: 10.5, color: titleColor }); y -= 16; }
    for (const l of lines) { this.text(this.m.l + 14, y - size, l, { size, color: '#1f2937' }); y -= size * 1.42; }
    this.y -= h + 10;
  }
  code(str, { size = 7.4 } = {}) {
    const lines = this.wrap(str, 'mono', size, this.width - 16);
    let i = 0;
    while (i < lines.length) {
      this.ensure(size * 1.35 * 2 + 12);
      const room = Math.max(1, Math.floor((this.y - this.m.b - 12) / (size * 1.35)));
      const chunk = lines.slice(i, i + room);
      const h = chunk.length * size * 1.35 + 12;
      this.rect(this.m.l, this.y - h, this.width, h, { fill: '#f3f4f6', stroke: '#e5e7eb' });
      chunk.forEach((l, k) => this.text(this.m.l + 8, this.y - 6 - size - k * size * 1.35, l, { font: 'mono', size, color: '#111827' }));
      this.y -= h + 6; i += chunk.length;
    }
  }
  table(columns, rows, { size = 8.6, zebra = true } = {}) {
    const total = columns.reduce((s, c) => s + (c.w || 1), 0);
    const widths = columns.map(c => (c.w || 1) / total * this.width);
    const pad = 5;
    const header = () => {
      const hh = size * 1.4 + 8;
      this.rect(this.m.l, this.y - hh, this.width, hh, { fill: '#0d1224' });
      let x = this.m.l;
      columns.forEach((c, i) => { this.text(x + pad, this.y - size - 4, c.title.toUpperCase(), { font: 'bold', size: size - 0.6, color: '#e5e7eb' }); x += widths[i]; });
      this.y -= hh;
    };
    this.ensure(size * 5); header();
    rows.forEach((row, ri) => {
      const cells = row.map((v, i) => this.wrap(String(v ?? '—'), columns[i].font || 'reg', size, widths[i] - pad * 2));
      const rh = Math.max(...cells.map(c => c.length)) * size * 1.35 + 8;
      if (this.ensure(rh)) header();
      if (zebra && ri % 2) this.rect(this.m.l, this.y - rh, this.width, rh, { fill: '#f8f9fc' });
      let x = this.m.l;
      cells.forEach((lines, i) => {
        lines.forEach((l, k) => this.text(x + pad, this.y - 4 - size - k * size * 1.35, l, { font: columns[i].font || 'reg', size, color: columns[i].color?.(row[i]) || '#111827' }));
        x += widths[i];
      });
      this.y -= rh;
      this.line(this.m.l, this.y, this.m.l + this.width, this.y, '#e5e7eb', 0.5);
    });
    this.y -= 10;
  }
  meter(label, score, level) {
    this.ensure(46);
    const colors = { low: '#0f9d6b', moderate: '#c27803', high: '#d92d4b', severe: '#9f1239' };
    const c = colors[level] || '#6b7280';
    this.text(this.m.l, this.y - 12, label, { font: 'bold', size: 10, color: '#374151' });
    this.text(this.m.l + this.width - 90, this.y - 13, `${score}/100  ${String(level).toUpperCase()}`, { font: 'bold', size: 11, color: c });
    const y = this.y - 30, w = this.width;
    this.rect(this.m.l, y, w, 9, { fill: '#eef0f5' });
    this.rect(this.m.l, y, Math.max(2, w * Math.min(100, score) / 100), 9, { fill: c });
    this.y -= 44;
  }
  signature(lines) {
    this.ensure(80); this.space(14);
    const w = (this.width - 30) / 2;
    lines.slice(0, 2).forEach((l, i) => {
      const x = this.m.l + i * (w + 30);
      this.line(x, this.y - 30, x + w, this.y - 30, '#9ca3af', 0.8);
      this.text(x, this.y - 42, l, { size: 8.5, color: '#6b7280' });
    });
    this.y -= 56;
  }

  // ---------- output ----------
  toBuffer() {
    const N = this.pages.length;
    const stamp = this.createdAt;
    const ist = stamp.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    this.pages.forEach((pg, i) => {
      const save = this.page; this.page = pg;
      if (!(i === 0 && this.hasCover)) {
        this.text(this.m.l, A4.h - 40, 'TraceMask', { font: 'bold', size: 9, color: this.accent });
        const t = `${this.title}${this.reportId ? '  |  ' + this.reportId : ''}`;
        this.text(A4.w - this.m.r - textWidth(t, 'reg', 8), A4.h - 40, t, { size: 8, color: '#6b7280' });
        if (i > 0) this.line(this.m.l, A4.h - 48, A4.w - this.m.r, A4.h - 48, '#e5e7eb', 0.6);
      }
      this.line(this.m.l, 44, A4.w - this.m.r, 44, '#e5e7eb', 0.6);
      this.text(this.m.l, 30, this.classification, { font: 'bold', size: 7.5, color: '#b91c1c' });
      const pn = `Generated ${ist} IST   |   Page ${i + 1} of ${N}`;
      this.text(A4.w - this.m.r - textWidth(pn, 'reg', 7.5), 30, pn, { size: 7.5, color: '#6b7280' });
      this.page = save;
    });
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    const catalog = add(null), pagesId = add(null);
    const fontIds = {
      F1: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
      F2: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
      F3: add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'),
      F4: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>')
    };
    const fontRes = Object.entries(fontIds).map(([k, v]) => `/${k} ${v} 0 R`).join(' ');
    const kids = [];
    for (const pg of this.pages) {
      const raw = Buffer.from(pg.join('\n'), 'latin1');
      const z = zlib.deflateSync(raw);
      const contentId = add({ stream: z, dict: `<< /Length ${z.length} /Filter /FlateDecode >>` });
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << ${fontRes} >> >> /Contents ${contentId} 0 R >>`));
    }
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R /PageLayout /OneColumn /ViewerPreferences << /DisplayDocTitle true >> /Lang (en-IN) >>`;
    const pdfDate = (d) => `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
    const str = (s) => `(${esc(toWinAnsi(s))})`;
    const info = add(`<< /Title ${str(this.title)} /Subject ${str(this.subject)} /Author (TraceMask) /Creator (TraceMask local instance) /Producer (TraceMask PDF writer 1.0) /Keywords ${str(this.reportId)} /CreationDate (${pdfDate(stamp)}) /ModDate (${pdfDate(stamp)}) >>`);

    const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const offsets = [];
    let pos = chunks[0].length;
    objs.forEach((o, i) => {
      offsets.push(pos);
      const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
      const body = typeof o === 'string' ? Buffer.from(o, 'latin1')
        : Buffer.concat([Buffer.from(`${o.dict}\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream', 'latin1')]);
      const tail = Buffer.from('\nendobj\n', 'latin1');
      chunks.push(head, body, tail); pos += head.length + body.length + tail.length;
    });
    const docId = crypto.createHash('md5').update(Buffer.concat(chunks)).digest('hex');
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R /ID [<${docId}> <${docId}>] >>\nstartxref\n${pos}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }
}
