'use strict';
// Attachments for live chats: files the user attaches in roost's chat box.
//
// Each file is saved under ~/.local/share/roost/uploads/<date>/<id>-<name>, outside the
// projects so nothing lands in a git repository by accident. The agent gets:
//   - pictures (PNG, JPEG, GIF, WebP; checked by their bytes, not their name) directly,
//     as image input, so it can see them;
//   - for every file, its path in a short note under the message, so it can open it
//     with its own tools (PDFs, logs, archives, ...) or copy it into the project.
// That note is also how attachments are recognised again in a chat's history.
// Uploads older than ROOST_UPLOAD_KEEP_DAYS (default 30) are removed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const HOME = process.env.HOME || '/config/home';
const ROOT = path.join(HOME, '.local/share/roost/uploads');
const MAX_BYTES = Number(process.env.ROOST_UPLOAD_MAX_MB || 100) * 1024 * 1024;
const KEEP_DAYS = Number(process.env.ROOST_UPLOAD_KEEP_DAYS || 30);
// The Anthropic API takes images up to 5 MB once base64-encoded.
const INLINE_MAX = 3.75 * 1024 * 1024;
const ID_RE = /^(\d{4}-\d{2}-\d{2})\/([a-f0-9]{8})-([^/\\]{1,180})$/;
const NOTE_HEAD = 'Attached files (saved by roost):';

const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv', '.json': 'application/json', '.log': 'text/plain', '.zip': 'application/zip',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};
const typeOf = (name) => TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';

function safeName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).normalize('NFC');
  const s = base.replace(/[\u0000-\u001f\u007f/]+/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return (s || 'file').slice(-120);
}

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// What the picture really is, from its first bytes. Only these go to the model as images.
function sniffImage(file) {
  let b;
  try {
    const fd = fs.openSync(file, 'r');
    b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0);
    fs.closeSync(fd);
  } catch { return null; }
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Public description of a saved file (what the browser gets back).
function describe(id) {
  const m = ID_RE.exec(String(id || ''));
  if (!m) return null;
  const file = path.join(ROOT, m[1], `${m[2]}-${m[3]}`);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const image = sniffImage(file);
  return { id, name: m[3], size: st.size, type: image || typeOf(m[3]), image: !!image, path: file, url: 'api/uploads/' + id.split('/').map(encodeURIComponent).join('/') };
}

// Stream a request body to disk.
async function save(req, name) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BYTES) throw Object.assign(new Error(`files are limited to ${fmtSize(MAX_BYTES)}`), { status: 413 });
  const day = new Date().toISOString().slice(0, 10);
  const id = `${day}/${crypto.randomBytes(4).toString('hex')}-${safeName(name)}`;
  const m = ID_RE.exec(id);
  const dir = path.join(ROOT, day);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${m[2]}-${m[3]}`);
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BYTES) req.destroy(Object.assign(new Error(`files are limited to ${fmtSize(MAX_BYTES)}`), { status: 413 }));
  });
  try {
    await pipeline(req, fs.createWriteStream(file, { mode: 0o600 }));
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw Object.assign(new Error(e.message || 'upload failed'), { status: e.status || 400 });
  }
  if (!size) { fs.rmSync(file, { force: true }); throw Object.assign(new Error('that file is empty'), { status: 400 }); }
  return publicView(describe(id));
}

const publicView = (d) => (d ? { id: d.id, name: d.name, size: d.size, type: d.type, image: d.image, url: d.url } : null);

// Send a saved file back to the browser (thumbnails in the chat, or to download).
function serve(res, id) {
  const d = describe(id);
  if (!d) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, {
    'Content-Type': d.image ? d.type : 'application/octet-stream',
    'Content-Length': d.size,
    'Content-Disposition': `${d.image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.name)}`,
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  fs.createReadStream(d.path).pipe(res);
}

// Turn attachment ids from the browser into what each agent needs.
function resolve(ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  if (ids.length > 20) throw Object.assign(new Error('attach at most 20 files at a time'), { status: 400 });
  return ids.map((id) => {
    const d = describe(id);
    if (!d) throw Object.assign(new Error(`attachment not found: ${String(id).slice(0, 80)}`), { status: 400 });
    return d;
  });
}

// The note added under the message text, naming every attached file by path.
function note(atts) {
  if (!atts.length) return '';
  return `${NOTE_HEAD}\n${atts.map((a) => `- ${a.path} (${a.type}, ${fmtSize(a.size)})`).join('\n')}`;
}
function withNote(text, atts) {
  const n = note(atts);
  return [String(text || '').trim(), n].filter(Boolean).join('\n\n');
}

// The reverse, for chat history: split the note off a message and turn it back into attachments.
function split(text) {
  const s = String(text || '');
  const i = s.lastIndexOf(NOTE_HEAD);
  if (i < 0) return { text: s, attachments: null };
  const lines = s.slice(i + NOTE_HEAD.length).split('\n').filter((l) => l.trim());
  const attachments = [];
  for (const l of lines) {
    const m = /^- (\/.+?) \(([^,()]+), [^()]+\)$/.exec(l.trim());
    if (!m) return { text: s, attachments: null }; // not our note after all
    const rel = path.relative(ROOT, m[1]);
    const id = rel.split(path.sep).join('/');
    const d = !rel.startsWith('..') && describe(id);
    attachments.push(d ? publicView(d) : { name: path.basename(m[1]).replace(/^[a-f0-9]{8}-/, ''), type: m[2], missing: true });
  }
  return { text: s.slice(0, i).trim(), attachments };
}

// Content for Claude (Agent SDK user message): pictures as image blocks, then the text.
function claudeContent(text, atts) {
  const blocks = [];
  for (const a of atts) {
    if (!a.image || a.size > INLINE_MAX) continue;
    blocks.push({ type: 'image', source: { type: 'base64', media_type: a.type, data: fs.readFileSync(a.path).toString('base64') } });
  }
  const t = withNote(text, atts);
  if (!blocks.length) return t;
  blocks.push({ type: 'text', text: t });
  return blocks;
}

// Input items for Codex (app-server turn/start).
function codexInput(text, atts) {
  return [
    { type: 'text', text: withNote(text, atts), text_elements: [] },
    ...atts.filter((a) => a.image).map((a) => ({ type: 'localImage', path: a.path })),
  ];
}

function cleanup() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let days = [];
  try { days = fs.readdirSync(ROOT); } catch { return; }
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (Date.parse(d + 'T23:59:59Z') < cutoff) fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
  }
}
if (KEEP_DAYS > 0) {
  try { cleanup(); } catch {}
  setInterval(() => { try { cleanup(); } catch {} }, 6 * 3600 * 1000).unref();
}

module.exports = { ROOT, MAX_BYTES, save, serve, resolve, split, claudeContent, codexInput, publicView };
