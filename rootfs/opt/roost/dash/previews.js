'use strict';
// Previews: show a web server running inside the container (say a dev server on
// localhost:3001) in the dashboard's viewer panel, or in its own tab.
//
// Each preview gets its own port from a small range (ROOST_PREVIEW_PORTS,
// default 7700-7704). A sub-path like /preview/3001/ isn't enough: most apps use
// root-relative URLs (/api/..., /_next/..., a WebSocket at /) that would escape
// it. The ports have to be published with the same numbers on the host.
//
// Access check: the dashboard (behind the roost login) hands out an HttpOnly
// cookie. Cookies ignore ports, so the browser sends that cookie to the preview
// ports on the same host too. Requests without it are refused. The cookie is
// removed before the request is forwarded, so the app never sees it.

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.HOME || '/config/home';
const STATE_FILE = path.join(HOME, '.config/roost/previews.json');
const COOKIE = 'roost_preview';
const BIND = process.env.ROOST_PREVIEW_HOST || '0.0.0.0';
// roost's own listeners, hidden from the "running in roost" list.
const INTERNAL = new Set([7680, 7681, 7682, 8443, 8081, 6080, 5900, 9222, Number(process.env.ROOST_SSH_PORT || 2222)]);
// Processes that listen on TCP but never speak HTTP.
const NOT_WEB = /^(redis-server|postgres|mysqld|mariadbd|mongod|sshd|memcached|x11vnc|Xvfb|websockify|chromium|code-server|filebrowser|caddy|ttyd)$/;

function parseRange(spec) {
  const s = String(spec == null ? '7700-7704' : spec).trim();
  if (!s || s === 'off' || s === 'false' || s === 'none') return [];
  const out = new Set();
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    for (let p = Math.min(a, b); p <= Math.max(a, b) && out.size < 64; p++) if (p > 0 && p < 65536) out.add(p);
  }
  return [...out];
}
const SLOTS = parseRange(process.env.ROOST_PREVIEW_PORTS);
for (const s of SLOTS) INTERNAL.add(s);

// ------------------------------------------------------------------ state
let state = load();
function load() {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  if (!s || typeof s.token !== 'string' || s.token.length < 32) s = { token: crypto.randomBytes(32).toString('hex'), slots: {} };
  s.slots = s.slots && typeof s.slots === 'object' ? s.slots : {};
  for (const k of Object.keys(s.slots)) if (!SLOTS.includes(Number(k))) delete s.slots[k];
  return s;
}
function save() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}
try { save(); } catch (e) { console.error('previews: could not save state:', e.message); }

const cookieHeader = () => `${COOKIE}=${state.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;

function hasCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== COOKIE) continue;
    const a = Buffer.from(part.slice(i + 1).trim()), b = Buffer.from(state.token);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}
function stripCookie(v) {
  if (!v) return v;
  const rest = v.split(';').filter((p) => p.split('=')[0].trim() !== COOKIE).join(';').trim();
  return rest || undefined;
}

// ------------------------------------------------------------------ what's listening
function listeningSockets() {
  const out = new Map(); // inode -> {port, addr}
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10 || c[3] !== '0A') continue; // 0A = LISTEN
      const [addrHex, portHex] = c[1].split(':');
      const port = parseInt(portHex, 16);
      // 127.0.0.11 is Docker's embedded DNS.
      if (addrHex === '0B00007F') continue;
      const loopbackOnly = addrHex === '0100007F' || addrHex === '00000000000000000000000001000000';
      const prev = [...out.values()].find((x) => x.port === port);
      if (prev) { prev.loopbackOnly = prev.loopbackOnly && loopbackOnly; continue; }
      out.set(c[9], { port, loopbackOnly });
    }
  }
  return out;
}

function ownerOf(inodes) {
  const found = new Map(); // inode -> pid
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch {}
  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let l;
      try { l = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(l);
      if (m && inodes.has(m[1]) && !found.has(m[1])) found.set(m[1], Number(pid));
    }
    if (found.size === inodes.size) break;
  }
  return found;
}

function procInfo(pid) {
  const rd = (f) => { try { return fs.readFileSync(`/proc/${pid}/${f}`, 'utf8'); } catch { return ''; } };
  let cwd = null;
  try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
  const argv = rd('cmdline').split('\0').filter(Boolean);
  return { pid, comm: rd('comm').trim(), cmd: argv.join(' ').slice(0, 200), cwd };
}

// Everything listening on TCP that might be a web server, with the process
// (and so the project folder) behind it when we can see it.
function listening() {
  const socks = listeningSockets();
  const owners = ownerOf(new Set(socks.keys()));
  const rows = [];
  for (const [inode, s] of socks) {
    if (INTERNAL.has(s.port)) continue;
    const pid = owners.get(inode);
    const info = pid ? procInfo(pid) : { pid: null, comm: '', cmd: '', cwd: null };
    if (info.comm && NOT_WEB.test(info.comm)) continue;
    rows.push({ port: s.port, loopbackOnly: s.loopbackOnly, ...info });
  }
  return rows.sort((a, b) => a.port - b.port);
}

// ------------------------------------------------------------------ slots
function list() {
  const slots = SLOTS.map((slot) => {
    const s = state.slots[slot];
    return { slot, port: s ? s.port : null, used: s ? s.used : null };
  });
  return { enabled: SLOTS.length > 0, slots, listening: SLOTS.length ? listening() : [] };
}

// Put `port` on a preview slot: its existing one, a free one, or the least
// recently used one.
function assign(port) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('pick a port between 1 and 65535'), { status: 400 });
  if (!SLOTS.length) throw Object.assign(new Error('previews are turned off (ROOST_PREVIEW_PORTS)'), { status: 409 });
  if (INTERNAL.has(port)) throw Object.assign(new Error(`port ${port} belongs to roost itself`), { status: 400 });
  let slot = SLOTS.find((s) => state.slots[s] && state.slots[s].port === port);
  if (!slot) slot = SLOTS.find((s) => !state.slots[s]);
  if (!slot) slot = [...SLOTS].sort((a, b) => (state.slots[a].used || 0) - (state.slots[b].used || 0))[0];
  state.slots[slot] = { port, used: Date.now() };
  save();
  return { slot, port };
}

function release(slot) {
  slot = Number(slot);
  if (!state.slots[slot]) return;
  delete state.slots[slot];
  save();
}

// ------------------------------------------------------------------ proxy
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function page(res, status, title, body, refresh) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${esc(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f6f8;color:#3b414b}
@media(prefers-color-scheme:dark){body{background:#0d0e10;color:#c3c7cd}}main{max-width:420px;padding:24px;text-align:center}h1{font-size:17px;margin:0 0 6px}p{margin:0}code{font-size:.95em}</style>
<main><h1>${esc(title)}</h1><p>${body}</p></main>`);
}

// Headers for the app: it sees itself on localhost:<port>, the way it would in a
// local dev setup, so host checks (Vite, Next.js dev origins) don't trip.
function upstreamHeaders(req, port) {
  const hdr = { ...req.headers };
  const pub = req.headers.host || '';
  const local = `localhost:${port}`;
  const proto = req.socket.encrypted ? 'https' : 'http';
  hdr.host = local;
  if (hdr.origin && /^https?:\/\//.test(hdr.origin) && hdr.origin.replace(/^https?:\/\//, '') === pub) hdr.origin = `http://${local}`;
  if (hdr.referer) hdr.referer = hdr.referer.replace(/^https?:\/\/[^/]+/, (o) => (o.replace(/^https?:\/\//, '') === pub ? `http://${local}` : o));
  const c = stripCookie(hdr.cookie);
  if (c) hdr.cookie = c; else delete hdr.cookie;
  hdr['x-forwarded-host'] = pub;
  hdr['x-forwarded-proto'] = proto;
  hdr['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
  return hdr;
}

// Let the panel frame the app, and keep redirects on the preview port.
function downstreamHeaders(headers, req, port) {
  const out = { ...headers };
  delete out['x-frame-options'];
  for (const k of ['content-security-policy', 'content-security-policy-report-only']) {
    if (!out[k]) continue;
    const v = [].concat(out[k]).map((x) => x.split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';').trim()).filter(Boolean);
    if (v.length) out[k] = v; else delete out[k];
  }
  if (out.location) out.location = String(out.location).replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=/|$)`), '') || '/';
  return out;
}

function target(req, res) {
  const slot = req.socket.localPort;
  const s = state.slots[slot];
  if (!hasCookie(req)) {
    page(res, 401, 'Open this from the roost dashboard', 'Previews are only shown to people signed in to roost. Open the dashboard on this host, then reload this page.');
    return null;
  }
  if (!s) {
    page(res, 404, 'Nothing on this preview port', `Port ${slot} isn’t showing anything at the moment. Pick a server from the dashboard’s viewer.`);
    return null;
  }
  return s;
}

function onRequest(req, res) {
  const s = target(req, res);
  if (!s) return;
  const port = s.port;
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: upstreamHeaders(req, port) }, (r) => {
    res.writeHead(r.statusCode, r.statusMessage, downstreamHeaders(r.headers, req, port));
    r.pipe(res);
  });
  up.on('error', (e) => {
    if (res.headersSent) { res.destroy(); return; }
    if (e.code === 'ECONNREFUSED') page(res, 502, `Nothing is answering on port ${port}`, `Start the server (it should listen on <code>localhost:${port}</code> or <code>0.0.0.0:${port}</code>). This page retries every few seconds.`, 3);
    else page(res, 502, `Couldn’t reach port ${port}`, esc(e.message), 5);
  });
  req.on('aborted', () => up.destroy());
  req.pipe(up);
}

function onUpgrade(req, socket, head) {
  const slot = req.socket.localPort;
  const s = state.slots[slot];
  if (!s || !hasCookie(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  const up = net.connect(s.port, '127.0.0.1', () => {
    const hdr = upstreamHeaders(req, s.port);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(hdr)) for (const x of [].concat(v)) raw += `${k}: ${x}\r\n`;
    up.write(raw + '\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const bye = () => { up.destroy(); socket.destroy(); };
  up.on('error', bye);
  socket.on('error', bye);
  up.on('close', () => socket.destroy());
  socket.on('close', () => up.destroy());
}

function start() {
  for (const slot of SLOTS) {
    const srv = http.createServer(onRequest);
    srv.on('upgrade', onUpgrade);
    srv.on('error', (e) => console.error(`previews: can't listen on ${BIND}:${slot}: ${e.message}`));
    srv.listen(slot, BIND, () => console.log(`roost preview port on ${BIND}:${slot}`));
  }
}

module.exports = { start, list, assign, release, cookieHeader, SLOTS };
