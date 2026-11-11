'use strict';
// Projects: roost's own way of organising chats. Every top-level folder in
// /workspace is a project automatically; you can also create named projects
// that span several folders, pin and colour them, and move chats between them.
// All of that lives in /config/roost/projects.json. Claude's and Codex's files
// are never modified.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const chats = require('./chats');

const WORKSPACE = '/workspace';
const STORE = '/config/roost/projects.json';
const RC_CONF = '/config/roost/rc-projects.conf';
const ACTIVE_MS = 90 * 1000;
const COLORS = ['#e0913f', '#5b9bd5', '#5cc27e', '#c678dd', '#e06c75', '#56b6c2', '#d19a66', '#98a2b3'];

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, maxBuffer: 4 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout), err: String(stderr) });
    });
  });
}

// ------------------------------------------------------------------ store
function emptyStore() { return { version: 1, projects: [], assignments: {}, archived: {} }; }

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    return { ...emptyStore(), ...s };
  } catch {
    return emptyStore();
  }
}

function save(store) {
  const tmp = `${STORE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE);
}

const newId = () => 'p_' + crypto.randomBytes(5).toString('hex');

// Resolve and confine a path to the workspace (symlinks included).
async function workspacePath(p) {
  if (typeof p !== 'string' || !p) throw httpError(400, 'path required');
  const abs = path.resolve(WORKSPACE, p);
  let real;
  try { real = await fsp.realpath(abs); } catch { throw httpError(400, `no such folder: ${abs}`); }
  if (real !== WORKSPACE && !real.startsWith(WORKSPACE + '/')) throw httpError(400, 'path must be inside /workspace');
  return real;
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// ------------------------------------------------------------------ git & live state
const gitCache = new Map(); // dir -> { at, info }
async function gitInfo(dir) {
  const hit = gitCache.get(dir);
  if (hit && Date.now() - hit.at < 30000) return hit.info;
  let info = null;
  const top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD']);
  if (top.code === 0) {
    const [toplevel, branch] = top.out.trim().split('\n');
    info = { toplevel, branch, worktrees: [] };
    if (toplevel === dir) {
      const wt = await run('git', ['-C', dir, 'worktree', 'list', '--porcelain']);
      let cur = null;
      for (const line of wt.out.split('\n')) {
        if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null }; info.worktrees.push(cur); }
        else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace('refs/heads/', '');
      }
      info.worktrees = info.worktrees.filter((w) => w.path !== dir);
    }
  }
  gitCache.set(dir, { at: Date.now(), info });
  return info;
}

async function tmuxState() {
  const r = await run('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}\t#{pane_current_command}']);
  const sessions = new Map();
  for (const line of r.out.split('\n')) {
    const [name, cwd, cmd] = line.split('\t');
    if (name && !sessions.has(name)) sessions.set(name, { name, cwd, cmd });
  }
  return sessions;
}

function rcEntries() {
  let text = '';
  try { text = fs.readFileSync(RC_CONF, 'utf8'); } catch {}
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const [dir, mode = 'same-dir', ...name] = l.split(/\s+/);
    return { dir, mode, name: name.join(' ') || null, session: rcSessionName(dir) };
  });
}

function rcSessionName(p) {
  return 'rc-' + p.replace(/^\//, '').replace(/\//g, '_').replace(/[^A-Za-z0-9_-]/g, '');
}

const chatSession = (chat) => `${chat.tool === 'claude' ? 'cl' : 'cx'}-${chat.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}`;

// ------------------------------------------------------------------ tree
async function tree() {
  const store = load();
  const [all, tmux] = await Promise.all([chats.scan(), tmuxState()]);
  const rc = rcEntries();

  // Explicit projects, then one implicit project per top-level workspace folder they don't cover.
  const projects = store.projects.map((p) => ({ ...p, implicit: false }));
  const covered = new Set(projects.flatMap((p) => p.paths));
  let dirs = [];
  try { dirs = (await fsp.readdir(WORKSPACE, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch {}
  for (const name of dirs.sort((a, b) => a.localeCompare(b))) {
    const p = path.join(WORKSPACE, name);
    if (covered.has(p)) continue;
    projects.push({ id: 'dir:' + name, name, paths: [p], color: null, pinned: false, implicit: true });
  }
  const byId = new Map(projects.map((p) => [p.id, p]));

  const matchProject = (cwd) => {
    let best = null;
    let bestLen = -1;
    for (const p of projects) {
      for (const root of p.paths) {
        if ((cwd === root || (cwd || '').startsWith(root + '/')) && root.length > bestLen) { best = p; bestLen = root.length; }
      }
    }
    return best;
  };

  const out = new Map(projects.map((p) => [p.id, { ...p, chats: [] }]));
  const other = { id: 'other', name: 'Not in a project', paths: [], implicit: true, other: true, chats: [] };
  const now = Date.now();
  let archivedCount = 0;

  for (const c of all) {
    const chat = {
      key: c.key, tool: c.tool, id: c.id, title: c.title, named: c.named, cwd: c.cwd, branch: c.branch,
      prompts: c.prompts, started: c.started, updated: c.updated, remote: c.remote, prs: c.prs,
      active: now - Date.parse(c.updated) < ACTIVE_MS,
      session: tmux.has(chatSession(c)) ? chatSession(c) : null,
      archived: !!store.archived[c.key],
    };
    if (chat.archived) archivedCount++;
    const assigned = store.assignments[c.key];
    const proj = (assigned && byId.get(assigned)) || matchProject(c.cwd);
    chat.assigned = !!(assigned && byId.get(assigned));
    (proj ? out.get(proj.id) : other).chats.push(chat);
  }

  const result = [];
  for (const p of [...out.values(), other]) {
    p.chats.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
    // Group chats by where they ran: project root, a worktree, a subfolder, or elsewhere.
    const locs = new Map();
    const loc = (dir) => {
      if (!locs.has(dir)) locs.set(dir, { path: dir, label: null, kind: 'folder', branch: null, chats: [] });
      return locs.get(dir);
    };
    for (const root of p.paths) loc(root);
    let primaryGit = null;
    for (const root of p.paths) {
      const g = await gitInfo(root);
      if (g) {
        loc(root).branch = g.branch;
        loc(root).kind = 'repo';
        primaryGit = primaryGit || g;
        for (const w of g.worktrees) Object.assign(loc(w.path), { kind: 'worktree', branch: w.branch });
      }
    }
    for (const c of p.chats) loc(c.cwd || '(unknown folder)').chats.push(c);
    for (const l of locs.values()) {
      const root = p.paths.find((r) => l.path === r || l.path.startsWith(r + '/'));
      if (l.path.includes('/.claude/worktrees/')) l.kind = 'worktree';
      l.label = !root ? l.path : l.path === root ? (p.paths.length > 1 ? path.basename(root) : '.') : path.relative(root, l.path);
      if (l.kind === 'folder' && !l.branch && l.chats[0]) l.branch = l.chats[0].branch;
    }
    const locations = [...locs.values()].filter((l) => l.chats.length || l.kind !== 'folder' || p.paths.includes(l.path));
    locations.sort((a, b) => (p.paths.includes(b.path) - p.paths.includes(a.path)) || a.label.localeCompare(b.label));

    const primary = p.paths[0];
    const rcEntry = primary ? rc.find((r) => r.dir === primary) : null;
    const sessions = [...tmux.values()].filter((s) => p.paths.some((r) => s.cwd === r || (s.cwd || '').startsWith(r + '/'))).map((s) => s.name);
    const live = p.chats.filter((c) => !c.archived && (c.active || c.session)).length;
    result.push({
      id: p.id, name: p.name, color: p.color || (p.other ? '#98a2b3' : colorFor(p.name)), pinned: !!p.pinned,
      implicit: p.implicit, other: !!p.other, paths: p.paths,
      branch: primaryGit ? primaryGit.branch : null, repo: !!primaryGit,
      rc: rcEntry ? { enabled: true, mode: rcEntry.mode, session: rcEntry.session, running: tmux.has(rcEntry.session) } : { enabled: false },
      tmux: sessions, live,
      chatCount: p.chats.filter((c) => !c.archived).length,
      updated: p.chats[0] ? p.chats[0].updated : null,
      locations,
    });
  }

  result.sort((a, b) => (b.other ? -1 : 0) - (a.other ? -1 : 0) || (b.pinned - a.pinned) ||
    (Date.parse(b.updated || 0) - Date.parse(a.updated || 0)) || a.name.localeCompare(b.name));
  return { projects: result, archivedCount, workspace: WORKSPACE };
}

function colorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

// ------------------------------------------------------------------ mutations
function findOrMaterialize(store, id) {
  let p = store.projects.find((x) => x.id === id);
  if (!p && id.startsWith('dir:')) {
    const name = id.slice(4);
    if (!/^[^/]+$/.test(name)) throw httpError(400, 'bad project id');
    // Keep the folder's id, so links, expanded state and assignments carry over.
    p = { id, name, paths: [path.join(WORKSPACE, name)], color: null, pinned: false, createdAt: new Date().toISOString() };
    store.projects.push(p);
  }
  if (!p) throw httpError(404, 'unknown project');
  return p;
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GIT_URL = /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/;

async function create({ name, folder, gitUrl, paths, color }) {
  name = String(name || '').trim();
  const store = load();
  let projectPaths = [];
  if (gitUrl) {
    if (!GIT_URL.test(gitUrl)) throw httpError(400, 'git URL must start with https://, ssh:// or git@');
    const dirName = folder || path.basename(gitUrl).replace(/\.git$/, '');
    if (!SLUG.test(dirName)) throw httpError(400, 'invalid folder name');
    const dest = path.join(WORKSPACE, dirName);
    if (fs.existsSync(dest)) throw httpError(409, `${dest} already exists`);
    const r = await run('git', ['clone', '--', gitUrl, dest], { timeout: 15 * 60 * 1000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (r.code !== 0) throw httpError(400, 'git clone failed: ' + (r.err || r.out).trim().split('\n').slice(-3).join(' '));
    projectPaths = [dest];
    name = name || dirName;
  } else if (folder) {
    if (!SLUG.test(folder)) throw httpError(400, 'invalid folder name (letters, digits, . _ -)');
    const dest = path.join(WORKSPACE, folder);
    await fsp.mkdir(dest, { recursive: true });
    projectPaths = [dest];
    name = name || folder;
  } else if (Array.isArray(paths) && paths.length) {
    for (const p of paths) projectPaths.push(await workspacePath(p));
  }
  if (!name) throw httpError(400, 'name required');
  const p = { id: newId(), name: name.slice(0, 80), paths: [...new Set(projectPaths)], color: color || null, pinned: false, createdAt: new Date().toISOString() };
  store.projects.push(p);
  save(store);
  return p;
}

async function update(id, patch) {
  const store = load();
  const p = findOrMaterialize(store, id);
  if (typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim().slice(0, 80);
  if (typeof patch.pinned === 'boolean') p.pinned = patch.pinned;
  if (patch.color === null || (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color))) p.color = patch.color;
  if (Array.isArray(patch.paths)) {
    const resolved = [];
    for (const x of patch.paths) resolved.push(await workspacePath(x));
    p.paths = [...new Set(resolved)];
  }
  save(store);
  return p;
}

function remove(id) {
  const store = load();
  const before = store.projects.length;
  store.projects = store.projects.filter((p) => p.id !== id);
  if (store.projects.length === before) throw httpError(404, 'unknown project (folder projects disappear when their folder does)');
  for (const [k, v] of Object.entries(store.assignments)) if (v === id) delete store.assignments[k];
  save(store);
}

function assign(key, projectId) {
  if (!/^(claude|codex):[A-Za-z0-9-]+$/.test(String(key))) throw httpError(400, 'bad chat key');
  const store = load();
  if (projectId) {
    const p = findOrMaterialize(store, projectId);
    store.assignments[key] = p.id;
  } else {
    delete store.assignments[key];
  }
  save(store);
}

function archive(key, archived) {
  if (!/^(claude|codex):[A-Za-z0-9-]+$/.test(String(key))) throw httpError(400, 'bad chat key');
  const store = load();
  if (archived) store.archived[key] = new Date().toISOString();
  else delete store.archived[key];
  save(store);
}

// Open a chat in a persistent tmux session (resuming it), or start a new one.
async function openChat(key) {
  const { projects } = await tree();
  const chat = projects.flatMap((p) => p.locations.flatMap((l) => l.chats)).find((c) => c.key === key);
  if (!chat) throw httpError(404, 'unknown chat');
  const name = chatSession(chat);
  if (chat.session) return { session: name };
  if (!chat.cwd || !fs.existsSync(chat.cwd)) throw httpError(409, `the folder this chat ran in no longer exists (${chat.cwd})`);
  if (chat.tool === 'claude') await run('/usr/local/bin/roost-trust', [chat.cwd]);
  const cmd = chat.tool === 'claude' ? `roost-env claude --resume ${chat.id}` : `roost-env codex resume ${chat.id}`;
  const r = await run('tmux', ['new-session', '-d', '-s', name, '-c', chat.cwd, `${cmd}; exec bash -l`]);
  if (r.code !== 0) throw httpError(500, r.err.trim() || 'could not start tmux session');
  return { session: name };
}

async function newChat(projectId, tool, dir) {
  if (tool !== 'claude' && tool !== 'codex') throw httpError(400, 'tool must be claude or codex');
  const { projects } = await tree();
  const p = projects.find((x) => x.id === projectId);
  if (!p || !p.paths.length) throw httpError(404, 'unknown project');
  const cwd = dir ? await workspacePath(dir) : p.paths[0];
  if (tool === 'claude') await run('/usr/local/bin/roost-trust', [cwd]);
  const name = `${tool === 'claude' ? 'cl' : 'cx'}-new-${crypto.randomBytes(3).toString('hex')}`;
  const r = await run('tmux', ['new-session', '-d', '-s', name, '-c', cwd, `roost-env ${tool}; exec bash -l`]);
  if (r.code !== 0) throw httpError(500, r.err.trim() || 'could not start tmux session');
  return { session: name };
}

// Turn a project's own Remote Control server on or off (edits rc-projects.conf).
async function setRemoteControl(projectId, enabled, mode) {
  const { projects } = await tree();
  const p = projects.find((x) => x.id === projectId);
  if (!p || !p.paths.length) throw httpError(404, 'unknown project');
  const dir = p.paths[0];
  if (mode && !['same-dir', 'worktree', 'session'].includes(mode)) throw httpError(400, 'bad mode');
  if (enabled && mode === 'worktree' && !p.repo) throw httpError(400, 'worktree mode needs a git repository');
  let lines = [];
  try { lines = fs.readFileSync(RC_CONF, 'utf8').split('\n'); } catch {}
  const isLine = (l) => { const t = l.trim(); return t && !t.startsWith('#') && t.split(/\s+/)[0] === dir; };
  lines = lines.filter((l) => !isLine(l));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (enabled) lines.push(`${dir}  ${mode || 'same-dir'}  ${p.name}`);
  fs.writeFileSync(RC_CONF, lines.join('\n') + '\n');
  // Restart (or stop) its server; the watchdog starts it again within ~15s if still configured.
  await run('tmux', ['kill-session', '-t', `=${rcSessionName(dir)}`]);
  return { dir, enabled, mode: mode || 'same-dir' };
}

// Working folder for a new chat: a project's main folder, or a folder inside the workspace.
async function resolveCwd(projectId, dir) {
  if (dir) return workspacePath(dir);
  const { projects } = await tree();
  const p = projects.find((x) => x.id === projectId);
  if (!p || !p.paths.length) throw httpError(404, 'unknown project');
  return p.paths[0];
}

module.exports = { resolveCwd, tree, create, update, remove, assign, archive, openChat, newChat, setRemoteControl, transcript: chats.transcript };
