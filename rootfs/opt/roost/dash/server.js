'use strict';
// roost dashboard: a tiny zero-dependency status/control API plus a static page.
// Listens on localhost only; Caddy puts it (and the login) on the public port.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const projects = require('./projects');
const live = require('./live');
const secrets = require('./secrets');

const PORT = Number(process.env.DASH_PORT || 7682);
const HOME = process.env.HOME || '/config/home';
const STATE = '/config/roost';
const LOG_DIR = path.join(STATE, 'logs');
const RC_CONF = path.join(STATE, 'rc-projects.conf');
const PUBLIC = path.join(__dirname, 'public');
const SUPERVISOR = ['-c', '/etc/roost/supervisord.conf'];
const SERVICES = new Set([
  'caddy', 'dash', 'ttyd', 'code-server', 'filebrowser', 'xvfb', 'openbox',
  'chromium', 'x11vnc', 'novnc', 'claude-rc', 'sshd',
]);
const LOGS = new Set([...SERVICES, 'code-server-extensions', 'update']);

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 2 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout), err: String(stderr) });
    });
  });
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const nonEmpty = (file) => { try { return fs.statSync(file).size > 0; } catch { return false; } };
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

// Version strings are stable for the life of the container; resolve them once.
const versions = { roost: readText('/etc/roost/version').trim() || 'dev' };
(async () => {
  const first = (r) => (r.out || r.err).trim().split('\n')[0] || null;
  versions.claude = first(await run('claude', ['--version'], 20000));
  versions.codex = first(await run('codex', ['--version'], 20000));
  versions.codeServer = first(await run('code-server', ['--version'], 20000));
})();

async function services() {
  const r = await run('supervisorctl', [...SUPERVISOR, 'status']);
  return r.out.split('\n').map((line) => {
    const m = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
    return m && { name: m[1], state: m[2], detail: m[3].trim() };
  }).filter(Boolean);
}

function rcSessionName(p) {
  return 'rc-' + p.replace(/^\//, '').replace(/\//g, '_').replace(/[^A-Za-z0-9_-]/g, '');
}

function rcProjects() {
  return readText(RC_CONF).split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [dir, mode = 'same-dir', ...name] = l.split(/\s+/);
      return { dir, mode, name: name.join(' ') || null, session: rcSessionName(dir) };
    });
}

async function rcStatus() {
  const projects = rcProjects();
  const live = new Set((await run('tmux', ['list-sessions', '-F', '#{session_name}'])).out.split('\n').filter(Boolean));
  for (const p of projects) {
    p.running = live.has(p.session);
    if (p.running) {
      const cap = await run('tmux', ['capture-pane', '-p', '-J', '-t', `=${p.session}:`, '-S', '-60']);
      p.console = cap.out.replace(/\s+$/, '').split('\n').slice(-40).join('\n');
    }
  }
  return { projects, sessions: [...live].sort() };
}

async function browserStatus() {
  try {
    const res = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(1500) });
    const j = await res.json();
    return { up: true, version: j.Browser || null };
  } catch {
    return { up: false };
  }
}

function accounts() {
  const claudeCfg = readJson(path.join(HOME, '.claude.json')) || {};
  const ghHosts = readText(path.join(HOME, '.config/gh/hosts.yml'));
  const ghUser = (ghHosts.match(/^\s+user:\s*(\S+)/m) || [])[1] || null;
  const keys = (readText(path.join(HOME, '.ssh/authorized_keys')) + '\n' + readText(path.join(STATE, 'ssh/authorized_keys')))
    .split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
  return {
    claude: {
      signedIn: nonEmpty(path.join(HOME, '.claude/.credentials.json')) || !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
      account: (claudeCfg.oauthAccount && claudeCfg.oauthAccount.emailAddress) || null,
      browserMcp: !!(claudeCfg.mcpServers && claudeCfg.mcpServers.browser),
    },
    codex: { signedIn: nonEmpty(path.join(HOME, '.codex/auth.json')) },
    github: { signedIn: !!ghUser, user: ghUser },
    ssh: { enabled: process.env.ROOST_SSH === 'true', port: Number(process.env.ROOST_SSH_PORT || 2222), authorizedKeys: keys },
  };
}

function tail(file, bytes = 64 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > max) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const t = await readBody(req);
  if (!t) return {};
  try { return JSON.parse(t); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/ui.js': 'ui.js', '/secrets.js': 'secrets.js', '/style.css': 'style.css', '/icon.svg': 'icon.svg' };
// Changes on every dashboard restart (i.e. every image update), so browsers never run stale assets.
const ASSET_VERSION = Date.now().toString(36);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && STATIC[p]) {
      const f = path.join(PUBLIC, STATIC[p]);
      let body = fs.readFileSync(f);
      if (f.endsWith('.html')) body = body.toString('utf8').replace(/__V__/g, ASSET_VERSION);
      return send(res, 200, body, TYPES[path.extname(f)]);
    }
    if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/api/status') {
      const [svc, rc, browser] = await Promise.all([services(), rcStatus(), browserStatus()]);
      return send(res, 200, {
        name: process.env.ROOST_NAME || 'roost',
        versions, services: svc, rc, browser, accounts: accounts(),
        vnc: { mode: process.env.ROOST_VNC_MODE || 'localhost' },
        sudo: process.env.ROOST_SUDO === 'true',
      });
    }
    let m;
    if (req.method === 'GET' && p === '/api/projects') return send(res, 200, { ...(await projects.tree()), live: live.list() });
    if (req.method === 'GET' && p === '/api/live') return send(res, 200, { sessions: live.list() });
    if (req.method === 'GET' && p === '/api/secrets') return send(res, 200, await secrets.list());
    if (req.method === 'GET' && p === '/api/live/models') return send(res, 200, await live.models());
    if (req.method === 'GET' && p === '/api/live/stream') {
      const key = url.searchParams.get('key') || '';
      if (!/^(claude|codex):[A-Za-z0-9-]+$/.test(key)) return send(res, 400, { error: 'bad key' });
      return live.watch(key, res, Number(url.searchParams.get('since') || 0));
    }
    if (req.method === 'GET' && p === '/api/live/history') {
      const key = url.searchParams.get('key') || '';
      if (!/^(claude|codex):[A-Za-z0-9-]+$/.test(key)) return send(res, 400, { error: 'bad key' });
      const events = await live.history(key);
      return events ? send(res, 200, { events }) : send(res, 404, { error: 'unknown chat' });
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/chats\/(claude|codex)\/([A-Za-z0-9-]+)$/))) {
      const items = await projects.transcript(`${m[1]}:${m[2]}`);
      return items ? send(res, 200, { items }) : send(res, 404, { error: 'unknown chat' });
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/logs\/([\w-]+)$/))) {
      if (!LOGS.has(m[1])) return send(res, 404, { error: 'unknown log' });
      return send(res, 200, tail(path.join(LOG_DIR, `${m[1]}.log`)), 'text/plain; charset=utf-8');
    }
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE') {
      // A custom header can't be sent cross-origin without a CORS preflight we never
      // answer, so this blocks other sites from driving these endpoints via the browser.
      if (req.headers['x-roost'] !== '1') return send(res, 403, { error: 'missing X-Roost header' });
      if (req.method === 'POST' && p === '/api/projects') return send(res, 201, await projects.create(await readJsonBody(req)));
      if ((m = p.match(/^\/api\/projects\/([^/]+)$/))) {
        const id = decodeURIComponent(m[1]);
        if (req.method === 'PATCH') return send(res, 200, await projects.update(id, await readJsonBody(req)));
        if (req.method === 'DELETE') { projects.remove(id); return send(res, 200, { ok: true }); }
      }
      if (req.method === 'POST' && (m = p.match(/^\/api\/projects\/([^/]+)\/(new-chat|remote-control)$/))) {
        const id = decodeURIComponent(m[1]);
        const b = await readJsonBody(req);
        if (m[2] === 'new-chat') return send(res, 200, await projects.newChat(id, b.tool, b.dir));
        return send(res, 200, await projects.setRemoteControl(id, !!b.enabled, b.mode));
      }
      // Keys & secrets. Values are accepted but never returned.
      if ((m = p.match(/^\/api\/secrets\/env\/([^/]+)$/))) {
        const name = decodeURIComponent(m[1]);
        if (req.method === 'PUT') return send(res, 200, secrets.setEnv(name, await readJsonBody(req)));
        if (req.method === 'DELETE') { secrets.deleteEnv(name); return send(res, 200, { ok: true }); }
      }
      if (req.method === 'POST' && p === '/api/secrets/keys') {
        const b = await readJsonBody(req);
        const key = b.privateKey ? await secrets.importKey(String(b.name || ''), b) : await secrets.generateKey(String(b.name || ''), b);
        return send(res, 201, key);
      }
      if ((m = p.match(/^\/api\/secrets\/keys\/([^/]+)(\/test)?$/))) {
        const name = decodeURIComponent(m[1]);
        if (m[2] && req.method === 'POST') return send(res, 200, await secrets.testKey(name, (await readJsonBody(req)).host));
        if (!m[2] && req.method === 'PATCH') return send(res, 200, await secrets.updateKey(name, await readJsonBody(req)));
        if (!m[2] && req.method === 'DELETE') { secrets.deleteKey(name); return send(res, 200, { ok: true }); }
      }
      if (req.method === 'POST' && p.startsWith('/api/live/')) {
        const b = await readJsonBody(req);
        const action = p.slice('/api/live/'.length);
        if (action === 'send') {
          let cwd;
          if (!b.key || b.key.split(':')[1].startsWith('new-')) cwd = await projects.resolveCwd(b.project, b.dir);
          return send(res, 200, await live.send({ key: b.key, tool: b.tool, cwd, text: b.text, model: b.model, mode: b.mode }));
        }
        const s = live.get(String(b.key || ''));
        if (action === 'interrupt') { await s.interrupt(); return send(res, 200, { ok: true }); }
        if (action === 'permission') { s.answer(String(b.id), String(b.decision), b.message); return send(res, 200, { ok: true }); }
        if (action === 'settings') {
          if (typeof b.mode === 'string') await s.setMode(b.mode);
          if (typeof b.model === 'string') await s.setModel(b.model);
          return send(res, 200, { ok: true });
        }
        if (action === 'close') { live.close(String(b.key)); return send(res, 200, { ok: true }); }
        return send(res, 404, { error: 'unknown action' });
      }
      if (req.method === 'POST' && p === '/api/chats/assign') {
        const b = await readJsonBody(req);
        projects.assign(b.chat, b.project || null);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/chats/rename') {
        const b = await readJsonBody(req);
        if (!/^(claude|codex):[A-Za-z0-9-]+$/.test(String(b.chat))) return send(res, 400, { error: 'bad chat key' });
        await live.rename(b.chat, b.title);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/chats/archive') {
        const b = await readJsonBody(req);
        projects.archive(b.chat, !!b.archived);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && (m = p.match(/^\/api\/chats\/(claude|codex)\/([A-Za-z0-9-]+)\/open$/))) {
        return send(res, 200, await projects.openChat(`${m[1]}:${m[2]}`));
      }
      if ((m = p.match(/^\/api\/services\/([\w-]+)\/restart$/))) {
        if (!SERVICES.has(m[1])) return send(res, 404, { error: 'unknown service' });
        const r = await run('supervisorctl', [...SUPERVISOR, 'restart', m[1]], 30000);
        return send(res, r.code === 0 ? 200 : 500, { output: (r.out + r.err).trim() });
      }
      if ((m = p.match(/^\/api\/rc\/([\w-]+)\/restart$/))) {
        if (!rcProjects().some((x) => x.session === m[1])) return send(res, 404, { error: 'unknown project' });
        await run('tmux', ['kill-session', '-t', `=${m[1]}`]);
        return send(res, 200, { output: 'killed; the watchdog restarts it within ~15s' });
      }
      if ((m = p.match(/^\/api\/rc\/([\w-]+)\/keys$/))) {
        // Send a short answer (e.g. "y") to a Remote Control console prompt.
        const body = await new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 64) req.destroy(); }); req.on('end', () => r(d)); });
        const keys = String(body).slice(0, 32);
        if (!rcProjects().some((x) => x.session === m[1])) return send(res, 404, { error: 'unknown project' });
        await run('tmux', ['send-keys', '-t', `=${m[1]}:`, '-l', keys]);
        await run('tmux', ['send-keys', '-t', `=${m[1]}:`, 'Enter']);
        return send(res, 200, { output: 'sent' });
      }
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, (e && e.status) || 500, { error: String((e && e.message) || e) });
  }
});

// Only Caddy (with the login) should reach the dashboard; DASH_HOST exists for debugging.
const HOST = process.env.DASH_HOST || '127.0.0.1';
server.listen(PORT, HOST, () => console.log(`roost dashboard on ${HOST}:${PORT}`));
try { secrets.regenerateIfPresent(); } catch (e) { console.error('secrets: could not regenerate:', e.message); }
