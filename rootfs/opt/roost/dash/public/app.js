'use strict';
/* =========================================================================
   roost dashboard: app shell, router and backend wiring ("Mission Control").
   ui.js holds the renderers, the chat reducer and the views; this file feeds
   them real data:
     GET  api/projects, api/status, api/usage   polled
     GET  api/live                              polled: live sessions + board summaries
     GET  api/live/history, api/live/stream     chat history + live events (SSE)
     POST api/live/{send,interrupt,permission,settings,close}
     POST api/chats/..., api/projects/..., api/services/..., api/rc/...
   Routes: #/board, #/chat/<key> (#/chat = last chat), #/system, #/secrets
   (#/projects and #/overview still work: they are the old names).
   ========================================================================= */

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2800);
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

async function api(method, url, body, raw) {
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? {} : { 'X-Roost': '1', ...(raw ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    cache: 'no-store',
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw new Error((data && data.error) || (typeof data === 'string' && data) || res.statusText);
  return data;
}

const mqPhone = matchMedia('(max-width: 720px)');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const RECENT_MS = 3 * 3600e3;

const App = {
  data: { projects: [], archivedCount: 0, live: [] },
  live: [],            // GET api/live sessions (each may carry a `board` summary)
  status: null,
  usage: null,
  chats: new Map(),    // key -> entry {state, es, live, loaded, key, streamKey, seq}
  drafts: new Map(),   // placeholder chats created in this browser (key -> {chat, projectId})
  view: { current: null, meta: null, filter: store.get('roost.board.filter', '*'), text: '', showArchived: false, showAll: new Set(), slText: '' },
  consoles: new Set(),
  lastChat: store.get('roost.lastChat', null),
  route: 'board',
  feed: [], prevLanes: null,
  denyOpen: new Map(), denyDraft: new Map(), busy: new Set(),

  // In-roost state of a chat: needs | busy | error | idle | null (not running).
  chatStatus(key) {
    const e = this.chats.get(key);
    if (e && e.state && e.state.items.length && (e.es || !liveFor(key))) {
      const s = e.state.status;
      if (s === 'waiting' || pendingPermissions(e.state).length) return 'needs';
      if (BUSY.has(s)) return 'busy';
      if (s === 'error') return 'error';
      if (s === 'offline' || s === 'closed') return null;
      return e.live ? 'idle' : null;
    }
    const l = liveFor(key);
    if (!l || !l.running) return null;
    if (l.pending || l.status === 'waiting') return 'needs';
    if (BUSY.has(l.status)) return 'busy';
    if (l.status === 'error') return 'error';
    return 'idle';
  },
};
function liveFor(key) { return App.live.find((x) => (x.keys || [x.key]).includes(key)) || null; }

// ------------------------------------------------------------------ chats
function entryFor(key) {
  let e = App.chats.get(key);
  if (!e) {
    e = { key, state: createChatState({ key }), es: null, live: false, loaded: false };
    e.state.status = 'offline';
    App.chats.set(key, e);
  }
  return e;
}

// The single entry point for chat events, from history or the live stream.
function ingest(entry, ev, at) {
  ev.type = ev.type || ev.t;
  if (ev.type === 'session') {
    // Only keep a model name the picker knows (the server reports full model ids).
    if (!knownModel(entry, ev.model)) delete ev.model;
    rekey(entry, ev.key);
  }
  if (ev.type === 'status') entry.live = ev.status !== 'closed' && ev.status !== 'offline';
  const res = applyEvent(entry.state, ev, at || ev.at || Date.now());
  if (chatView.state === entry.state) {
    chatView.update(res);
    if (res.chrome || /^(tool|tool-result|result|user|permission|permission-resolved)$/.test(ev.type)) scheduleCtx();
  }
  if (res.chrome || ev.type === 'user' || ev.type === 'result') scheduleBoard();
  if (ev.type === 'status' && entry.es) pollLiveSoon();
}

const toolOf = (key) => String(key).split(':')[0];
const knownModel = (entry, v) => typeof v === 'string' && (MODELS[entry.state.meta.tool || toolOf(entry.key)] || []).some((m) => m.v === v);
const isDraftKey = (key) => /:new-/.test(key);

// A new chat got its real id: register it under that key and update the URL.
function rekey(entry, newKey) {
  if (!newKey || entry.key === newKey) return;
  // The server only lists a new chat once its transcript has a message in it.
  setTimeout(refreshProjects, 2500);
  const old = entry.key;
  entry.key = newKey;
  entry.state.meta.key = newKey;
  App.chats.set(newKey, entry);
  const draft = App.drafts.get(old);
  if (draft) { draft.chat.key = newKey; App.drafts.set(newKey, draft); App.drafts.delete(old); }
  if (App.view.current === old) {
    App.view.current = newKey;
    if (App.view.meta) App.view.meta.key = newKey;
    App.lastChat = newKey;
    store.set('roost.lastChat', newKey);
    history.replaceState(history.state, '', '#/chat/' + encodeURIComponent(newKey));
  }
  refreshProjects();
}

// Follow a chat's live event stream. `skipBefore` drops replayed events that the
// transcript history already showed. `resume` reconnects a chat we stopped
// following: the server replays what we missed (everything after entry.seq).
function connect(entry, streamKey, skipBefore, resume) {
  if (entry.es && entry.streamKey === streamKey) return;
  if (entry.es) entry.es.close();
  entry.streamKey = streamKey;
  entry.seq = entry.seq || 0;
  const es = new EventSource(`api/live/stream?key=${encodeURIComponent(streamKey)}&since=${entry.seq}`);
  entry.es = es;
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.t === 'snapshot') {
      const wasLive = entry.live;
      entry.live = !!ev.live;
      if (ev.live && entry.state.status !== ev.status) ingest(entry, { t: 'status', status: ev.status });
      // The session ended while we weren't following it.
      if (resume && !ev.live && wasLive) ingest(entry, { t: 'status', status: 'offline' });
      let changed = false;
      if (knownModel(entry, ev.model) && entry.state.model == null) { entry.state.model = ev.model; changed = true; }
      if (ev.mode && !entry.state.mode) { entry.state.mode = ev.mode; changed = true; }
      if (changed && chatView.state === entry.state) { chatView.update({ changed: [], chrome: true }); scheduleCtx(); }
      return;
    }
    if (ev.seq) entry.seq = Math.max(entry.seq, ev.seq);
    if (skipBefore && ev.at && ev.at < skipBefore && !/^(permission|permission-resolved|status|session|settings)$/.test(ev.t)) return;
    ingest(entry, ev);
  };
}

// Only the chat on screen keeps a live stream. Browsers allow 6 connections per
// host over HTTP/1.1 (roost's web UI is plain HTTP), and each EventSource holds
// one for good: with a stream per visited chat, a handful of chats used them
// all up and every other request (sending a message, the Secrets page) queued
// forever. Every other chat's state comes from the GET api/live poll.
function followOnly(keep) {
  for (const e of App.chats.values()) {
    if (e !== keep && e.es) { e.es.close(); e.es = null; }
  }
}

async function loadHistory(entry) {
  if (entry.loaded || isDraftKey(entry.key)) {
    entry.loaded = true;
    // Seen before: pick its stream back up where we left off.
    if (entry.streamKey) connect(entry, entry.streamKey, 0, true);
    return;
  }
  entry.loaded = true;
  const opened = Date.now();
  try {
    const { events, mode, model } = await api('GET', `api/live/history?key=${encodeURIComponent(entry.key)}`);
    const t0 = opened - 60000;
    events.forEach((ev, i) => ingest(entry, ev, ev.at || t0 + i));
    // The chat's remembered settings, so its pickers show what it will actually resume with.
    let changed = false;
    if (mode && !entry.state.mode) { entry.state.mode = mode; changed = true; }
    if (model != null && entry.state.model == null && knownModel(entry, model)) { entry.state.model = model; changed = true; }
    if (changed && chatView.state === entry.state) chatView.update({ changed: [], chrome: true });
  } catch (e) {
    ingest(entry, { t: 'notice', level: 'error', text: `Couldn't load this chat's history: ${e.message}` });
  }
  if (entry.state.status === 'offline' || entry.state.status === 'idle') applyEvent(entry.state, { type: 'status', status: 'offline' });
  connect(entry, entry.key, opened);
  scheduleCtx();
}

// Upload attachments one by one (raw body, name in the query); returns their ids.
async function uploadFiles(files) {
  const ids = [];
  for (const [i, f] of files.entries()) {
    if (files.length > 1 || f.size > 2e6) toast(`Uploading ${files.length > 1 ? `${i + 1} of ${files.length}: ` : ''}${f.name}\u2026`);
    const r = await api('POST', 'api/uploads?name=' + encodeURIComponent(f.name), f, true);
    ids.push(r.id);
  }
  return ids;
}

// `files` are new File objects to upload; `ids` are attachments already uploaded (a retry).
async function sendMessage(text, files, ids) {
  const key = App.view.current;
  const entry = App.chats.get(key);
  if (!entry) return false;
  const st = entry.state;
  const draft = App.drafts.get(key);
  let attachments = ids && ids.length ? ids : undefined;
  if (files && files.length) {
    try { attachments = await uploadFiles(files); } catch (e) { toast(`Couldn\u2019t upload: ${e.message}`); return false; }
  }
  const body = { tool: toolOf(key), text, attachments, model: st.model ?? undefined, mode: st.mode || undefined };
  if (draft && isDraftKey(entry.key)) Object.assign(body, { project: draft.projectId, dir: draft.chat.cwd });
  else body.key = entry.key;
  // Sent mid-turn, the message joins the running turn: leave the status alone.
  const midTurn = entry.live && BUSY.has(st.status);
  if (!midTurn) ingest(entry, { t: 'status', status: 'starting' });
  try {
    const r = await api('POST', 'api/live/send', body);
    // Moved to another chat meanwhile: remember the stream, connect on return.
    if (App.chats.get(App.view.current) === entry) connect(entry, r.pendingKey || r.key, 0);
    else entry.streamKey = r.pendingKey || r.key;
  } catch (e) {
    ingest(entry, { t: 'notice', level: 'error', text: e.message });
    if (!midTurn) ingest(entry, { t: 'status', status: 'error' });
  }
  pollLiveSoon();
}

const liveKey = (entry) => entry.streamKey || entry.key;

function decideCurrent(id, decision, reason) {
  const e = App.chats.get(App.view.current);
  if (!e) return;
  const item = e.state.byId.get('perm:' + id);
  if (item && reason) item.reasonNote = reason;
  api('POST', 'api/live/permission', { key: liveKey(e), id, decision, message: reason || undefined })
    .then(() => { if (decision === 'always' && item && item.req.always) toast(`Allowed ${item.req.always}`); pollLiveSoon(); })
    .catch((x) => toast(x.message));
}

const chatView = createChatView($('#chat-pane'), {
  onSend: (text, files) => sendMessage(text, files),
  onStop: () => { const e = App.chats.get(App.view.current); if (e) api('POST', 'api/live/interrupt', { key: liveKey(e) }).catch((x) => toast(x.message)); },
  onDecide: decideCurrent,
  onModel: (v) => { const e = App.chats.get(App.view.current); if (e) DEFAULTS[toolOf(e.key)].model = v; if (e && e.live) api('POST', 'api/live/settings', { key: liveKey(e), model: v }).catch(() => {}); scheduleCtx(); },
  onMode: (v) => { const e = App.chats.get(App.view.current); if (e && !NO_CARRY_MODES.has(v)) DEFAULTS[toolOf(e.key)].mode = v; if (e && e.live) api('POST', 'api/live/settings', { key: liveKey(e), mode: v }).catch(() => {}); scheduleCtx(); },
  onBack: () => { location.hash = '#/board'; },
  onClose: () => { location.hash = '#/board'; },
  onTerminal: () => openInTerminal(App.view.current),
  onViewer: (anchor) => { const x = chatContext(App.view.current); Viewer.pick(anchor, x ? x.p : null); },
  onDetails: () => {
    if (mqPhone.matches) { document.body.classList.toggle('show-ctx'); return; }
    const off = document.body.dataset.ctx === 'off';
    document.body.dataset.ctx = off ? 'on' : 'off';
    store.set('roost.ctx', off ? 'on' : 'off');
  },
  onMore: (anchor) => { const it = itemFor(App.view.current); if (it) chatMenu(it, anchor, true); },
  onRename: (title) => renameChat(App.view.current, title),
  onRetry: () => {
    const e = App.chats.get(App.view.current);
    const last = e && [...e.state.items].reverse().find((i) => i.kind === 'user');
    if (last) sendMessage(last.text, null, (last.attachments || []).filter((a) => a.id && !a.missing).map((a) => a.id)); else toast('Nothing to retry');
  },
});

async function openInTerminal(key) {
  if (!key || isDraftKey(key)) { toast('Send a message first'); return; }
  const w = window.open('about:blank', '_blank');
  try {
    const { session } = await api('POST', `api/chats/${key.replace(':', '/')}/open`);
    const url = `term/?arg=${encodeURIComponent(session)}`;
    if (w) w.location.href = url; else location.href = url;
  } catch (e) {
    if (w) w.close();
    toast(e.message);
  }
}

function renameChat(key, title) {
  const c = findChat(key);
  if (c) c.title = title;
  if (App.view.current === key) { chatView.retitle(title); App.view.currentTitle = title; if (App.view.meta) App.view.meta.title = title; }
  scheduleBoard();
  if (isDraftKey(key)) return;
  api('POST', 'api/chats/rename', { chat: key, title }).catch((x) => toast(x.message));
}

// ------------------------------------------------------------------ projects data
function allChats() {
  const out = [];
  for (const p of App.data.projects) for (const l of p.locations) for (const c of l.chats) out.push({ p, l, c });
  return out;
}
function findChat(key) { const x = allChats().find((y) => y.c.key === key); return x ? x.c : null; }
function chatContext(key) { return allChats().find((y) => y.c.key === key) || null; }
function projectFor(cwd) {
  let best = null, len = -1;
  for (const p of App.data.projects) for (const path of p.paths || []) {
    const q = path.replace(/\/+$/, '');
    if ((cwd === q || String(cwd).startsWith(q + '/')) && q.length > len) { best = p; len = q.length; }
  }
  return best || App.data.projects.find((p) => p.other) || null;
}

// Merge chats created in this browser that the server doesn't list yet.
function mergeDrafts(data) {
  const known = new Set();
  for (const p of data.projects) for (const l of p.locations) for (const c of l.chats) known.add(c.key);
  for (const [key, d] of App.drafts) {
    if (known.has(key)) { App.drafts.delete(key); continue; }
    const p = data.projects.find((x) => x.id === d.projectId) || data.projects[0];
    if (!p) continue;
    const l = p.locations.find((x) => x.path === d.chat.cwd) || p.locations[0];
    if (l) { l.chats.unshift(d.chat); p.chatCount++; }
  }
  return data;
}

let projectsLoading = null;
async function refreshProjects() {
  if (projectsLoading) return projectsLoading;
  projectsLoading = (async () => {
    try {
      const data = await api('GET', 'api/projects');
      App.data = mergeDrafts(data);
      if (Array.isArray(data.live) && !App.liveAt) App.live = data.live;
      // Keep the open chat's header title in step with the server (e.g. Claude's own title).
      const cur = App.view.current && findChat(App.view.current);
      if (cur && cur.title && cur.title !== App.view.currentTitle) { App.view.currentTitle = cur.title; chatView.retitle(cur.title); }
      setConn(true);
      renderBoard();
      scheduleCtx();
    } catch {
      setConn(false);
    } finally {
      projectsLoading = null;
    }
  })();
  return projectsLoading;
}

// Live sessions and their board summaries: every 2s while the board or a chat shows, else 5s.
let liveTimer = 0, liveLoading = false;
async function refreshLive() {
  if (liveLoading) return;
  liveLoading = true;
  try {
    const r = await api('GET', 'api/live');
    App.live = r.sessions || [];
    App.liveAt = Date.now();
    setConn(true);
    renderBoard();
  } catch {
    setConn(false);
  } finally {
    liveLoading = false;
  }
}
function pollLive() {
  clearTimeout(liveTimer);
  const next = () => { liveTimer = setTimeout(pollLive, App.route === 'board' || App.route === 'chat' ? 2000 : 5000); };
  if (document.hidden) { next(); return; }
  refreshLive().finally(next);
}
function pollLiveSoon() { clearTimeout(liveTimer); liveTimer = setTimeout(pollLive, 350); }

async function refreshStatus() {
  try {
    App.status = await api('GET', 'api/status');
    setConn(true);
    renderStrip();
    if (App.route === 'system') renderSys();
  } catch {
    setConn(false);
  }
}

function setConn(ok) {
  const c = $('#conn');
  c.classList.toggle('is-stale', !ok);
  c.querySelector('span').textContent = ok ? 'live' : 'offline';
  c.title = ok ? `Connected to ${location.host}` : 'Can\u2019t reach roost: retrying';
}

// ------------------------------------------------------------------ board model
const VERBS = { bash: 'Running', edit: 'Editing', patch: 'Editing', write: 'Writing', read: 'Reading', grep: 'Searching', glob: 'Searching', webfetch: 'Fetching', websearch: 'Searching', task: 'Delegating', todo: 'Planning', generic: 'Using' };
// What a chat loaded in this browser is doing, in the shape of the server's `board` summary.
function localSummary(st, cwd, tool) {
  const agent = agentName(tool);
  const s = {};
  s.perms = pendingPermissions(st).map((p) => ({ id: p.req.id, name: p.req.name, title: permTitle(p.req, agent), summary: permWhat(p.req, cwd), description: p.req.description || p.req.reason || null, always: p.req.always || null, at: p.at }));
  const running = [...st.items].reverse().find((i) => i.kind === 'tool' && !i.result && !i.denied && !i.interrupted);
  if (BUSY.has(st.status)) {
    if (running) {
      const sum = summarizeTool(running.tool, null, { cwd });
      const info = toolInfo(running.tool.name);
      s.activity = { verb: VERBS[info.kind] || 'Using', target: sum.path || sum.arg || info.label, tool: running.tool.name, since: running.startedAt };
      s.tail = splitLines(running.output || '').slice(-5).map((l) => l.slice(0, 200));
    } else s.activity = { verb: st.status === 'responding' ? 'Responding' : 'Thinking', target: null };
    s.since = st.turnStart;
  }
  const todos = lastTodos(st);
  if (todos && todos.length) { const cur = todos.find((t) => t.status === 'in_progress'); s.todos = { done: todos.filter((t) => t.status === 'completed').length, total: todos.length, current: cur ? cur.activeForm || cur.content : null }; }
  let prev = -1, lastRes = null, lastIdx = -1;
  st.items.forEach((it, i) => { if (it.kind === 'result') { prev = lastIdx; lastIdx = i; lastRes = it; } });
  if (lastRes) {
    const r = lastRes.res, tk = r.tokens || {};
    const files = changedFiles({ items: st.items.slice(prev + 1, lastIdx) }, cwd);
    s.lastTurn = { ok: r.ok !== false, durationMs: r.durationMs ?? lastRes.turnMs, cost: r.cost ?? null, tokens: (tk.input || 0) + (tk.cached || 0) + (tk.output || 0), files: files.length, added: files.reduce((n, f) => n + f.add, 0), removed: files.reduce((n, f) => n + f.del, 0), endedAt: lastRes.at, error: r.error || null };
  }
  const u = chatUsage(st);
  s.tokens = u.input + u.cached + u.output || null;
  if (st.status === 'error') { const n = [...st.items].reverse().find((i) => i.kind === 'notice' && i.level === 'error'); s.error = n ? n.text : null; }
  if (st.model) s.model = ((MODELS[tool] || []).find((m) => m.v === st.model) || { label: st.model }).label;
  if (st.mode) s.mode = st.mode;
  return s;
}
function serverSummary(b) {
  if (!b) return {};
  const t = b.tokens;
  return {
    perms: (b.permissions || []).map((p) => ({ ...p })), activity: b.activity || null, tail: b.tail || [], todos: b.todos || null, lastTurn: b.lastTurn || null,
    tokens: t ? (t.input || 0) + (t.cached || 0) + (t.output || 0) || null : null, error: b.error || null, model: b.model || null, mode: b.mode || null, since: b.turnStartedAt || null,
  };
}
function makeItem(c, p, loc, lv) {
  const key = c.key;
  const e = App.chats.get(key);
  const st = e && e.state && e.state.items.length ? e.state : null;
  // The chat on screen streams its events here, so its own state is fresher than the poll.
  // A chat loaded earlier but not followed any more is stale: keep only its history-derived bits.
  const streaming = !!(st && e.es);
  const hasB = !!(lv && lv.board);
  const B = serverSummary(hasB ? lv.board : null);
  const L = st ? localSummary(st, c.cwd, c.tool) : {};
  const main = streaming ? L : hasB ? B : L, other = main === L ? B : L;
  const val = (k, empty) => (main[k] != null ? main[k] : other[k] != null ? other[k] : empty);
  const sum = { perms: main.perms || [], activity: main.activity || null, tail: main.tail || [], todos: main.todos || null, since: main.since || null,
    lastTurn: val('lastTurn', null), tokens: val('tokens', null), error: val('error', null), model: val('model', null), mode: val('mode', null) };
  if (!streaming && !hasB) { sum.perms = []; sum.activity = null; sum.tail = []; sum.since = null; sum.todos = null; }
  const ui = App.chatStatus(key);
  if (ui === 'needs' && !sum.since && lv) sum.since = lv.lastActive;
  const updated = Math.max(Date.parse(c.updated) || 0, (lv && lv.lastActive) || 0, (sum.lastTurn && sum.lastTurn.endedAt) || 0);
  let lane;
  if (ui === 'needs' || ui === 'error') lane = 'needs';
  else if (ui === 'busy') lane = 'working';
  else if (!c.archived && Date.now() - updated < RECENT_MS && (sum.lastTurn || c.prompts)) lane = 'done';
  else lane = 'idle';
  return {
    key, c, p, loc, lv, tool: c.tool || toolOf(key), title: c.title || (lv && lv.board && lv.board.title) || 'Chat', cwd: c.cwd, branch: c.branch || (loc && loc.branch) || null,
    prs: c.prs || [], archived: !!c.archived, updated, prompts: c.prompts || 0, active: !!c.active, remote: !!c.remote, session: c.session, ui, lane, sum,
  };
}
function boardItems() {
  const byKey = new Map();
  for (const l of App.live) for (const k of l.keys || [l.key]) byKey.set(k, l);
  const used = new Set(), items = [];
  for (const { p, l, c } of allChats()) {
    const lv = byKey.get(c.key) || null;
    if (lv) used.add(lv);
    items.push(makeItem(c, p, l, lv));
  }
  // Live sessions the projects list doesn't show yet (a chat started a moment ago).
  for (const lv of App.live) {
    if (used.has(lv) || !lv.running) continue;
    const p = projectFor(lv.cwd);
    const c = { key: lv.key, tool: lv.tool, title: (lv.board && lv.board.title) || 'New chat', cwd: lv.cwd, branch: null, prompts: 0, updated: lv.lastActive, prs: [], archived: false, active: true };
    items.push(makeItem(c, p, null, lv));
  }
  return items;
}
function lanesOf(items, { filter = '*', text = '', archived = false } = {}) {
  const q = text.trim().toLowerCase();
  const vis = items.filter((it) => (archived || !it.archived || it.lane === 'needs' || it.lane === 'working')
    && (filter === '*' || (it.p && it.p.id === filter))
    && (!q || `${it.title} ${it.p ? it.p.name : ''} ${it.branch || ''} ${it.cwd || ''}`.toLowerCase().includes(q)));
  const firstAt = (it) => (it.sum.perms[0] && it.sum.perms[0].at) || it.sum.since || it.updated;
  const lanes = { needs: [], working: [], done: [], idle: [] };
  for (const it of vis) lanes[it.lane].push(it);
  lanes.needs.sort((a, b) => (a.ui === 'error') - (b.ui === 'error') || firstAt(a) - firstAt(b));
  lanes.working.sort((a, b) => (a.sum.since || a.updated) - (b.sum.since || b.updated));
  lanes.done.sort((a, b) => b.updated - a.updated);
  lanes.idle.sort((a, b) => b.updated - a.updated);
  return { lanes, all: vis };
}
function itemFor(key) { return key ? boardItems().find((x) => x.key === key) || null : null; }

// ------------------------------------------------------------------ activity feed (state changes seen by the poll)
function turnText(t) { return t ? [t.durationMs ? fmtDur(t.durationMs) : null, t.cost != null ? fmtCost(t.cost) : null, t.added || t.removed ? `+${t.added || 0} \u2212${t.removed || 0}` : null].filter(Boolean).join(' \u00b7 ') : ''; }
function updateFeed(items) {
  const now = Date.now(), cur = new Map();
  for (const it of items) cur.set(it.key, { lane: it.lane, ui: it.ui, perm: it.sum.perms[0] ? it.sum.perms[0].id : null });
  const prev = App.prevLanes;
  App.prevLanes = cur;
  if (!prev) return;
  const add = (it, kind, verb, arg) => App.feed.unshift({ at: now, kind, key: it.key, p: it.p, title: it.title, verb, arg: arg ? String(arg).slice(0, 80) : null, fresh: true });
  for (const it of items) {
    const was = prev.get(it.key), now2 = cur.get(it.key);
    if (!was) { if (it.lane === 'working') add(it, 'run', 'started', it.sum.activity && it.sum.activity.target); continue; }
    if (now2.perm && now2.perm !== was.perm) { const p = it.sum.perms[0]; add(it, 'sig', `asked to use ${p.name || 'a tool'}`, p.summary); }
    else if (it.ui === 'needs' && was.ui !== 'needs' && !now2.perm) add(it, 'sig', 'is waiting for approval');
    if (it.ui === 'error' && was.ui !== 'error') add(it, 'bad', 'errored', it.sum.error);
    else if (it.lane === 'working' && was.lane !== 'working' && was.ui !== 'needs') add(it, 'run', 'started working', it.sum.activity && it.sum.activity.target);
    else if ((was.lane === 'working' || was.ui === 'needs') && (it.lane === 'done' || it.lane === 'idle')) add(it, 'ok', 'finished', turnText(it.sum.lastTurn));
  }
  App.feed = App.feed.slice(0, 80);
  setTimeout(() => { for (const e of App.feed) e.fresh = false; }, 1800);
}

// ------------------------------------------------------------------ board view
let boardRaf = 0, lastSig = { lanes: '', chips: '', slist: '', feed: -1 };
function scheduleBoard() { if (!boardRaf) boardRaf = requestAnimationFrame(() => { boardRaf = 0; renderBoard(); }); }

const boardView = {
  get filter() { return App.view.filter; },
  get current() { return App.view.current; },
  get denyOpen() { return App.denyOpen; },
  get denyDraft() { return App.denyDraft; },
  get busy() { return App.busy; },
  get showAll() { return App.view.showAll; },
  get showArchived() { return App.view.showArchived; },
  get filterText() { return App.view.text; },
  firstKey: null,
  onOpen: (key) => openChat(key),
  onFilter: (id) => { App.view.filter = id; store.set('roost.board.filter', id); renderBoard(true); },
  onProjectMenu: (p, anchor) => projectMenu(p, anchor),
  onNewProject: () => newProject(),
  onNewChat: (p, tool) => newDraftChat(p, tool),
  onPreview: (anchor, p) => Viewer.pick(anchor, p || null),
  onEdit: (p) => editProject(p),
  onDecide: (it, perm, decision, reason) => boardDecide(it, perm, decision, reason),
  onDenyToggle: (it, perm) => {
    if (App.denyOpen.get(it.key) === perm.id) App.denyOpen.delete(it.key); else App.denyOpen.set(it.key, perm.id);
    renderBoard(true);
    if (App.denyOpen.has(it.key)) $(`[data-deny="${CSS.escape(it.key)}"]`)?.focus();
  },
  onStop: (it) => stopTurn(it),
  onRetry: (it) => retryChat(it),
  onChatMenu: (it, anchor) => chatMenu(it, anchor),
  onShowAll: (lane) => { App.view.showAll.add(lane); renderBoard(true); },
};

function renderBoard(force) {
  const items = boardItems();
  updateFeed(items);
  const counts = new Map([['*', { n: 0, nn: 0 }]]);
  let needs = 0;
  for (const it of items) {
    if (it.archived) continue;
    const id = it.p ? it.p.id : '?';
    const c = counts.get(id) || { n: 0, nn: 0 };
    c.n++; counts.get('*').n++;
    if (it.lane === 'needs') { c.nn++; needs++; }
    counts.set(id, c);
  }
  updateNeeds(needs);
  if (App.view.filter !== '*' && !App.data.projects.some((p) => p.id === App.view.filter) && App.data.projects.length) { App.view.filter = '*'; store.set('roost.board.filter', '*'); }
  if (App.route === 'board') {
    const m = lanesOf(items, { filter: App.view.filter, text: App.view.text, archived: App.view.showArchived });
    const first = m.lanes.needs.find((x) => x.sum.perms.length && x.ui === 'needs');
    boardView.firstKey = first ? first.key : null;
    const sig = JSON.stringify([m.lanes, App.view.filter, App.view.showArchived, [...App.view.showAll], [...App.denyOpen], [...App.busy], boardView.firstKey, Math.floor(Date.now() / 30000)], (k, v) => (k === 'p' || k === 'loc' || k === 'lv' || k === 'c' ? (v && (v.id || v.key || v.path || 1)) : v));
    if (force || sig !== lastSig.lanes) {
      lastSig.lanes = sig;
      const lanes = $('#lanes');
      const fe = document.activeElement;
      const denyKey = fe && fe.dataset && fe.dataset.deny;
      const sel = denyKey ? [fe.selectionStart, fe.selectionEnd] : null;
      const y = lanes.scrollTop;
      lanes.replaceChildren(...renderLanes(m, boardView));
      lanes.scrollTop = y;
      if (denyKey) { const inp = $(`[data-deny="${CSS.escape(denyKey)}"]`); if (inp) { inp.focus(); try { inp.setSelectionRange(sel[0], sel[1]); } catch {} } }
    }
    const csig = JSON.stringify([App.data.projects.map((p) => [p.id, p.name, p.color, p.pinned, p.rc]), [...counts], App.view.filter]);
    if (force || csig !== lastSig.chips) {
      lastSig.chips = csig;
      const chips = $('#chips'), sx = chips.scrollLeft;
      chips.replaceChildren(...renderChips(App.data.projects, counts, boardView).filter(Boolean));
      chips.scrollLeft = sx;
      if (lastSig.filter !== App.view.filter) { lastSig.filter = App.view.filter; const on = chips.querySelector('[aria-pressed="true"]'); if (on) { const cr = chips.getBoundingClientRect(), r = on.getBoundingClientRect(); if (r.left < cr.left) chips.scrollLeft -= cr.left - r.left + 8; else if (r.right > cr.right) chips.scrollLeft += r.right - cr.right + 8; } }
      const p = App.view.filter !== '*' && App.data.projects.find((x) => x.id === App.view.filter);
      $('#projbar').hidden = !p;
      if (p) $('#projbar').replaceChildren(...renderProjbar(p, boardView).filter(Boolean));
    }
    if (force || App.feed.length !== lastSig.feed || App.feed.some((e) => e.fresh)) {
      lastSig.feed = App.feed.length;
      $('#feed').replaceChildren(...renderFeed(App.feed, boardView));
    }
    $('#archived-count').textContent = App.data.archivedCount ? String(App.data.archivedCount) : '';
  }
  if (App.route === 'chat') {
    const m = lanesOf(items, { text: App.view.slText });
    const sig = JSON.stringify([m.lanes.needs, m.lanes.working, m.lanes.done, m.lanes.idle].map((l) => l.map((it) => [it.key, it.title, it.ui, it.lane, it.p && it.p.color, Math.floor(it.updated / 60000)])).concat([App.view.current, Math.floor(Date.now() / 60000)]));
    if (force || sig !== lastSig.slist) {
      lastSig.slist = sig;
      const sl = $('#slist'), y = sl.scrollTop;
      sl.replaceChildren(...renderSessionList(m, { current: App.view.current, filterText: App.view.slText, onOpen: openChat }));
      sl.scrollTop = y;
    }
  }
}

function updateNeeds(n) {
  const pill = $('#needs-pill');
  pill.classList.toggle('zero', !n);
  $('#needs-txt').textContent = n ? `${n} need${n === 1 ? 's' : ''} you` : 'All clear';
  pill.title = n ? 'Show what needs you' : 'Nothing is waiting on you';
  for (const b of $$('[data-needs-badge]')) { b.hidden = !n; b.textContent = String(n); }
  document.title = (n ? `(${n}) ` : '') + 'roost';
}

// ------------------------------------------------------------------ board actions
async function boardDecide(it, perm, decision, reason) {
  const e = App.chats.get(it.key);
  const key = it.lv ? it.lv.key : e ? liveKey(e) : it.key;
  if (e) { const item = e.state.byId.get('perm:' + perm.id); if (item && reason) item.reasonNote = reason; }
  App.busy.add(it.key); App.denyOpen.delete(it.key); App.denyDraft.delete(it.key);
  renderBoard(true);
  try {
    await api('POST', 'api/live/permission', { key, id: perm.id, decision, message: reason || undefined });
    toast(decision === 'deny' ? `Denied${reason ? ': reason sent' : ''}` : decision === 'always' ? `Always allowed${perm.always && !/^mode:/.test(perm.always) ? ' ' + perm.always : ''}` : `Allowed: ${agentName(it.tool)} carries on`);
  } catch (x) { toast(x.message); }
  setTimeout(() => { App.busy.delete(it.key); renderBoard(true); }, 600);
  pollLiveSoon();
}
async function stopTurn(it) {
  const e = App.chats.get(it.key);
  try { await api('POST', 'api/live/interrupt', { key: it.lv ? it.lv.key : e ? liveKey(e) : it.key }); toast('Stopping\u2026'); } catch (x) { toast(x.message); }
  pollLiveSoon();
}
// Retry = send the last message again (the same path the chat's own Retry uses).
async function retryChat(it) {
  const e = App.chats.get(it.key);
  let last = e && e.state.items.length ? [...e.state.items].reverse().find((i) => i.kind === 'user') : null;
  if (!last) {
    try { const { events } = await api('GET', `api/live/history?key=${encodeURIComponent(it.key)}`); last = [...events].reverse().find((x) => (x.type || x.t) === 'user'); } catch (x) { toast(x.message); return; }
  }
  if (!last) { toast('Nothing to retry'); return; }
  const ids = (last.attachments || []).filter((a) => a.id && !a.missing).map((a) => a.id);
  App.busy.add(it.key); renderBoard(true);
  try { await api('POST', 'api/live/send', { tool: it.tool, key: it.key, text: last.text || '', attachments: ids.length ? ids : undefined }); toast('Retrying the last message'); } catch (x) { toast(x.message); }
  App.busy.delete(it.key);
  pollLiveSoon();
}
async function archiveChat(c) {
  try {
    await api('POST', 'api/chats/archive', { chat: c.key, archived: !c.archived });
    toast(c.archived ? 'Unarchived' : 'Archived. Find it with the Archived toggle.');
  } catch (e) { toast(e.message); }
  refreshProjects();
}
async function stopLive(key) {
  const e = App.chats.get(key);
  try { await api('POST', 'api/live/close', { key: e ? liveKey(e) : key }); toast('Stopped. The chat\u2019s history is kept.'); } catch (x) { toast(x.message); }
  if (e) ingest(e, { t: 'status', status: 'closed' });
  refreshProjects(); pollLiveSoon();
}
function openMoveSheet(c) {
  const ctx = chatContext(c.key);
  openMenu(null, [{ title: 'Move to' }, ...App.data.projects.filter((p) => !p.other).map((p) => ({
    label: p.name, swatch: p.color, check: ctx && ctx.p === p, onClick: () => moveChat(c, p),
  })), ...(c.assigned ? ['sep', { label: 'Back to its folder', icon: 'refresh', onClick: () => moveChat(c, null) }] : [])], 'Move \u201c' + c.title + '\u201d');
}
async function moveChat(c, p) {
  try {
    await api('POST', 'api/chats/assign', { chat: c.key, project: p ? p.id : null });
    toast(p ? `Filed under ${p.name}` : 'Moved back to its folder');
  } catch (e) { toast(e.message); }
  refreshProjects();
}
function renameSheet(it) {
  const input = h('input', { class: 'input', value: it.title, maxlength: '120', autocomplete: 'off', 'aria-label': 'Chat title' });
  const go = () => { const v = input.value.trim(); $('#sheet').close(); if (v && v !== it.title) { renameChat(it.key, v); toast('Renamed'); } };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  openSheet({ title: 'Rename chat', body: h('div', { class: 'form' }, input), foot: [h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'btn', onclick: () => $('#sheet').close() }, 'Cancel'), h('button', { type: 'button', class: 'btn pri', onclick: go }, 'Rename')] });
  input.focus(); input.select();
}
function chatMenu(it, anchor, inChat) {
  const c = it.c, draft = isDraftKey(it.key);
  openMenu(anchor, [
    inChat ? null : { label: 'Open chat', icon: 'message', onClick: () => openChat(it.key) },
    { label: 'Rename\u2026', icon: 'pencil', onClick: () => renameSheet(it) },
    draft ? null : { label: c && c.session ? 'Attach in terminal' : 'Resume in terminal', icon: 'terminal', onClick: () => openInTerminal(it.key) },
    draft || !findChat(it.key) ? null : { label: 'Move to project\u2026', icon: 'move', onClick: () => openMoveSheet(c) },
    it.cwd ? { label: 'Open folder in VS Code', icon: 'code', href: 'code/?folder=' + encodeURIComponent(it.cwd) } : null,
    'sep',
    draft || !findChat(it.key) ? null : { label: it.archived ? 'Unarchive' : 'Archive', icon: 'archive', onClick: () => archiveChat(c) },
    App.chatStatus(it.key) ? { label: 'Stop in roost', icon: 'x', danger: true, onClick: () => stopLive(it.key) } : null,
  ].filter(Boolean), it.title);
}
function projectMenu(p, anchor) {
  openMenu(anchor, [
    { label: 'New Claude chat', icon: 'plus', onClick: () => newDraftChat(p, 'claude') },
    { label: 'New Codex chat', icon: 'plus', onClick: () => newDraftChat(p, 'codex') },
    'sep',
    { label: 'Preview a web server\u2026', icon: 'globe', onClick: () => Viewer.pick(anchor, p) },
    p.paths[0] ? { label: 'Open in VS Code', icon: 'code', href: 'code/?folder=' + encodeURIComponent(p.paths[0]) } : null,
    p.paths[0] ? { label: 'Open in Files', icon: 'folderOpen', href: 'files/files/workspace/' + encodeURI(relPath(p.paths[0])) } : null,
    'sep',
    { label: p.pinned ? 'Unpin' : 'Pin to the front', icon: 'star', onClick: () => pinProject(p) },
    { label: `Remote Control: ${p.rc && p.rc.enabled ? p.rc.mode : 'off'}`, icon: 'cloud', onClick: () => editProject(p) },
    { label: 'Edit project\u2026', icon: 'pencil', onClick: () => editProject(p) },
  ].filter(Boolean), p.name);
}
async function pinProject(p) {
  try { await api('PATCH', `api/projects/${encodeURIComponent(p.id)}`, { pinned: !p.pinned }); toast(p.pinned ? 'Unpinned' : 'Pinned'); } catch (e) { toast(e.message); }
  refreshProjects();
}
function editProject(p) {
  openProjectForm(p, async (v) => {
    if (!v.name) throw new Error('Give the project a name.');
    const saved = await api('PATCH', `api/projects/${encodeURIComponent(p.id)}`, { name: v.name, color: v.color, pinned: v.pinned, paths: v.paths.length ? v.paths : p.paths });
    const was = p.rc && p.rc.enabled ? p.rc.mode : 'off';
    if (v.rc && v.rc !== was) await api('POST', `api/projects/${encodeURIComponent(saved.id)}/remote-control`, { enabled: v.rc !== 'off', mode: v.rc === 'off' ? undefined : v.rc });
    toast('Saved');
    await refreshProjects();
  }, async (pp) => {
    try { await api('DELETE', `api/projects/${encodeURIComponent(pp.id)}`); toast('Grouping removed'); } catch (e) { toast(e.message); }
    await refreshProjects();
  });
}
function newProject() {
  openProjectForm(null, async (v) => {
    if (!v.name) throw new Error('Give the project a name.');
    const body = { name: v.name, color: v.color };
    if (v.source === 'git') {
      if (!/^(https:\/\/|git@|ssh:\/\/)/.test(v.gitUrl)) throw new Error('That doesn\u2019t look like a git URL. Use https://\u2026 or git@\u2026');
      body.gitUrl = v.gitUrl;
      if (v.folder) body.folder = v.folder;
    } else if (v.source === 'paths') {
      if (!v.paths.length) throw new Error('List at least one folder inside /workspace.');
      body.paths = v.paths;
    } else {
      body.folder = v.folder || v.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    }
    const p = await api('POST', 'api/projects', body);
    if (v.pinned) await api('PATCH', `api/projects/${encodeURIComponent(p.id)}`, { pinned: true });
    toast(`Created ${p.name}`);
    await refreshProjects();
  });
}
function newChatMenu(anchor) {
  const ps = App.data.projects.filter((p) => p.locations.length);
  openMenu(anchor, [{ title: 'New Claude chat in' }, ...ps.map((p) => ({ label: p.name, swatch: p.color, onClick: () => newDraftChat(p, 'claude') })),
    'sep', { title: 'New Codex chat in' }, ...ps.map((p) => ({ label: p.name, swatch: p.color, onClick: () => newDraftChat(p, 'codex') }))], 'New chat');
}

function newDraftChat(p, tool, dir, prefill) {
  const loc = (dir && p.locations.find((l) => l.path === dir)) || p.locations[0];
  if (!loc) { toast('This project has no folder yet'); return; }
  const key = `${tool}:new-${Math.random().toString(16).slice(2, 10)}`;
  const chat = { key, tool, title: 'New chat', cwd: loc.path, branch: loc.branch, updated: new Date().toISOString(), prompts: 0, active: false, session: null, remote: false, prs: [], archived: false };
  App.drafts.set(key, { chat, projectId: p.id });
  const e = entryFor(key);
  e.loaded = true;
  e.state.status = 'idle';
  e.state.mode = DEFAULTS[tool].mode;
  e.state.model = DEFAULTS[tool].model;
  loc.chats.unshift(chat);
  p.chatCount++;
  openChat(key);
  if (prefill) chatView.prefill(prefill);
  if (matchMedia('(pointer: fine)').matches) chatView.focusComposer();
}

function openChat(key) {
  const h2 = '#/chat/' + encodeURIComponent(key);
  if (location.hash === h2) onRoute(); else { history.pushState(null, '', h2); onRoute(); }
}

// ------------------------------------------------------------------ chat screen: context rail
let ctxTimer = 0;
function scheduleCtx() { if (!ctxTimer) ctxTimer = setTimeout(() => { ctxTimer = 0; renderCtx(); }, 250); }
function renderCtx() {
  const key = App.view.current, root = $('#ctx');
  const e = key && App.chats.get(key);
  if (App.route !== 'chat' || !e || !App.view.meta) { if (!key) root.replaceChildren(); return; }
  const x = chatContext(key), c = x ? x.c : null;
  const draft = isDraftKey(key);
  const view = {
    onReveal: (uid) => { chatView.reveal(uid); document.body.classList.remove('show-ctx'); },
    onTerminal: () => openInTerminal(key),
    onPreview: (a) => Viewer.pick(a, x ? x.p : null),
    onVnc: () => Viewer.openVnc(),
    canMove: !!c && !draft, onMove: () => openMoveSheet(c),
    canArchive: !!c && !draft, onArchive: () => archiveChat(c),
    canStop: !draft && !!App.chatStatus(key), onStopLive: () => stopLive(key),
  };
  const y = root.scrollTop;
  root.replaceChildren(h('div', { class: 'ctx-close' }, h('button', { type: 'button', class: 'btn sm', onclick: () => document.body.classList.remove('show-ctx') }, icon('chevronLeft', 12), 'Back to the chat')),
    ...renderContext({ st: e.state, meta: App.view.meta, c }, view));
  root.scrollTop = y;
}

// ------------------------------------------------------------------ strip: usage meters, health
async function refreshUsage(force) {
  if (App.usageLoading) return;
  App.usageLoading = true;
  App.usage = { ...(App.usage || { claude: undefined, codex: undefined }), loading: true };
  if (App.route === 'system') renderSys();
  try {
    App.usage = await api('GET', 'api/usage' + (force ? '?refresh=1' : ''));
  } catch (e) {
    const err = { error: `Couldn\u2019t load usage: ${e.message}` };
    App.usage = { claude: App.usage.claude || err, codex: App.usage.codex || err };
  } finally {
    App.usageLoading = false;
    App.usageAt = Date.now();
    if (App.route === 'system') renderSys();
    renderStrip();
  }
}
function renderStrip() {
  const u = App.usage || {};
  const meters = [];
  const short = (l) => String(l).replace(/(\d+) hours?/, '$1h').replace(/(\d+) days?/, '$1d');
  const meter = (label, w, cls) => h('button', { type: 'button', class: 'meter ' + (cls || ''), title: `${label} ${w.label}: ${Math.round(w.percent)}% used${w.resetsAt ? ' \u00b7 resets in ' + fmtUntil(new Date(w.resetsAt) - Date.now()) : ''}`, onclick: () => { location.hash = '#/system'; } }, label, usageBar(w), h('b', null, Math.round(w.percent) + '%'));
  const cw = u.claude && u.claude.windows ? u.claude.windows : [];
  const five = cw.find((w) => w.id === 'five_hour') || cw[0], seven = cw.find((w) => w.id === 'seven_day') || cw[1];
  if (five) meters.push(meter('Claude ' + short(five.label), five));
  if (seven) meters.push(meter(short(seven.label), seven));
  const xw = u.codex && u.codex.windows ? u.codex.windows[0] : null;
  if (xw) meters.push(meter('Codex ' + short(xw.label), xw, 'm3'));
  $('#meters').replaceChildren(...meters);
  const s = App.status;
  if (s) {
    const rc = s.rc.projects || [];
    const up = rc.filter((p) => p.running).length;
    const asking = rc.some((p) => /\(y\/n\)/i.test(p.console || ''));
    const bad = s.services.filter((x) => x.state !== 'RUNNING');
    const go = () => { location.hash = '#/system'; };
    $('#health').replaceChildren(
      h('button', { type: 'button', title: 'Claude Code Remote Control servers', onclick: go }, h('span', { class: 'dot ' + (asking ? 'sig' : !rc.length ? '' : up === rc.length ? 'ok' : up ? 'warn' : 'bad') }), `RC ${up}/${rc.length}`),
      h('button', { type: 'button', title: s.accounts.codex.signedIn ? 'Codex is signed in' : 'Codex is not signed in', onclick: go }, h('span', { class: 'dot ' + (s.accounts.codex.signedIn ? 'ok' : 'warn') }), 'Codex'),
      h('button', { type: 'button', class: 'h-svc', title: bad.length ? bad.map((x) => `${x.name} is ${x.state}`).join('\n') : 'All services running', onclick: go }, h('span', { class: 'dot ' + (bad.length ? 'bad' : 'ok') }), `Services ${s.services.length - bad.length}/${s.services.length}`));
  }
}
function renderSys() {
  if (!App.status) { $('#ov').replaceChildren(h('p', { class: 'muted', style: 'margin:0' }, 'Loading\u2026')); return; }
  const s = App.status;
  $('#sys-sub').replaceChildren(h('span', { class: 'conn' }, h('i'), h('span', null, `${location.host} \u00b7 ${s.name} ${s.versions.roost || ''}`)));
  $('#sys-acts').replaceChildren(h('button', { type: 'button', class: 'btn', onclick: () => sysView.onLog('dash') }, icon('terminal', 13), 'Dashboard log'));
  const ov = $('#ov'), pg = ov.parentElement, y = pg.scrollTop;
  ov.replaceChildren(...renderSystem(s, { ...sysView, usage: App.usage || { claude: undefined, codex: undefined, loading: true } }));
  pg.scrollTop = y;
}
const sysView = {
  get consoles() { return App.consoles; },
  onUsageRefresh: () => refreshUsage(true),
  onConsole: (sess) => { App.consoles.has(sess) ? App.consoles.delete(sess) : App.consoles.add(sess); renderSys(); },
  onAnswer: async (sess) => {
    try { await api('POST', `api/rc/${encodeURIComponent(sess)}/keys`, 'y', true); toast('Sent \u201cy\u201d'); } catch (e) { toast(e.message); }
    setTimeout(refreshStatus, 800);
  },
  onRcRestart: async (sess) => {
    try { await api('POST', `api/rc/${encodeURIComponent(sess)}/restart`); toast('Restarting; back within ~15s'); } catch (e) { toast(e.message); }
    setTimeout(refreshStatus, 1500);
  },
  onRestart: async (name) => {
    try { await api('POST', `api/services/${encodeURIComponent(name)}/restart`); toast(`Restarted ${name}`); } catch (e) { toast(e.message); }
    refreshStatus();
  },
  onLog: async (name) => {
    let text = '';
    try { text = await api('GET', `api/logs/${encodeURIComponent(name)}`); } catch (e) { text = e.message; }
    openSheet({
      title: name + ' log', wide: true,
      body: h('pre', { class: 'log-pre', tabindex: '0' }, text || '(empty)'),
      foot: [h('span', { class: 'spacer' }), copyButton(() => text, 'Copy log', 'Copy log'), h('button', { type: 'button', class: 'btn', onclick: () => $('#sheet').close() }, 'Close')],
    });
    const pre = $('#sheet .log-pre');
    if (pre) pre.scrollTop = pre.scrollHeight;
  },
  onVnc: () => Viewer.openVnc(),
  onPreview: (anchor) => Viewer.pick(anchor, null),
};

// ------------------------------------------------------------------ command palette
const Pal = { items: [], sel: 0 };
function palItems(q) {
  const out = [];
  const items = boardItems();
  const m = lanesOf(items, {});
  const proj = (it) => (it.p ? it.p.name : '');
  for (const it of m.lanes.needs) {
    const perm = it.sum.perms[0];
    if (it.ui === 'error') out.push({ g: 'Needs you', sig: true, icon: 'refresh', label: `Retry: ${it.title}`, hint: proj(it), run: () => retryChat(it) });
    else if (perm) {
      const what = perm.summary || perm.name;
      out.push({ g: 'Needs you', sig: true, icon: 'check', label: `Allow: ${what}`, hint: proj(it), run: () => boardDecide(it, perm, 'allow') });
      out.push({ g: 'Needs you', sig: true, icon: 'x', label: `Deny: ${what}`, hint: proj(it), run: () => { openChat(it.key); setTimeout(() => chatView.openDeny(perm.id), 300); } });
    } else out.push({ g: 'Needs you', sig: true, icon: 'shield', label: `Review: ${it.title}`, hint: proj(it), run: () => openChat(it.key) });
  }
  const state = (it) => (it.ui === 'needs' ? 'needs you' : it.ui === 'error' ? 'error' : it.lane === 'working' ? 'working' : ago(it.updated));
  for (const lane of ['needs', 'working', 'done', 'idle']) for (const it of m.lanes[lane]) {
    out.push({ g: 'Chats', icon: lane === 'working' ? 'pulse' : 'message', label: it.title, hint: `${proj(it)} \u00b7 ${state(it)}`, sw: it.p, tool: it.tool, run: () => openChat(it.key), alt: `${it.cwd || ''} ${it.branch || ''}` });
  }
  if (q) for (const it of items.filter((x) => x.archived)) out.push({ g: 'Archived', icon: 'archive', label: it.title, hint: proj(it), sw: it.p, tool: it.tool, run: () => openChat(it.key) });
  const ps = App.data.projects.filter((p) => p.locations.length);
  for (const p of ps) for (const tool of ['claude', 'codex']) out.push({ g: 'New chat in project', icon: 'plus', label: `New ${agentName(tool)} chat in ${p.name}`, hint: p.paths[0] || '', tool, newIn: p, run: () => newDraftChat(p, tool) });
  out.push(
    { g: 'Open', icon: 'code', label: 'Open VS Code', hint: '/code/', run: () => window.open('code/', '_blank') },
    { g: 'Open', icon: 'folderOpen', label: 'Open Files', hint: '/files/', run: () => window.open('files/', '_blank') },
    { g: 'Open', icon: 'terminal', label: 'Open Terminal', hint: '/term/', run: () => window.open('term/', '_blank') },
    { g: 'Open', icon: 'spark', label: 'Open Claude CLI', hint: 'claude in a terminal', run: () => window.open('term/?arg=claude', '_blank') },
    { g: 'Open', icon: 'monitor', label: 'Open the browser viewer (VNC)', hint: 'viewer', run: () => Viewer.openVnc() },
    { g: 'Open', icon: 'globe', label: 'Preview a web server\u2026', hint: 'viewer', run: () => Viewer.pick(null, null) },
    ...App.data.projects.filter((p) => !p.other && p.paths[0]).map((p) => ({ g: 'Open', icon: 'code', label: `Open ${p.name} in VS Code`, hint: p.paths[0], run: () => window.open('code/?folder=' + encodeURIComponent(p.paths[0]), '_blank') })));
  const theme = store.get('roost.theme', 'system');
  const nextTheme = THEMES[(THEMES.indexOf(theme) + 1) % 3];
  out.push(
    { g: 'Actions', icon: 'board', label: 'Go to Board', hint: 'G B', run: () => { location.hash = '#/board'; } },
    { g: 'Actions', icon: 'message', label: 'Go to the last chat', hint: 'G C', run: () => { location.hash = '#/chat'; } },
    { g: 'Actions', icon: 'pulse', label: 'Go to System', hint: 'G S', run: () => { location.hash = '#/system'; } },
    { g: 'Actions', icon: 'key', label: 'Go to Secrets', hint: '', run: () => { location.hash = '#/secrets'; } },
    { g: 'Actions', icon: 'folder', label: 'New project\u2026', hint: '', run: newProject },
    { g: 'Actions', icon: 'archive', label: App.view.showArchived ? 'Hide archived chats' : 'Show archived chats', hint: '', run: () => { setArchived(!App.view.showArchived); location.hash = '#/board'; } },
    { g: 'Actions', icon: nextTheme === 'dark' ? 'moon' : nextTheme === 'light' ? 'sun' : 'contrast', label: `Theme: ${nextTheme}`, hint: `now ${theme}`, run: cycleTheme },
    { g: 'Actions', icon: 'refresh', label: 'Refresh plan usage', hint: '', run: () => refreshUsage(true) });
  const s = App.status;
  if (s) {
    for (const x of s.services.filter((y) => y.state !== 'RUNNING' && y.name !== 'dash' && y.name !== 'caddy')) out.push({ g: 'Actions', icon: 'refresh', label: `Restart ${x.name}`, hint: x.state, run: () => sysView.onRestart(x.name) });
    for (const p of (s.rc.projects || []).filter((y) => /\(y\/n\)/i.test(y.console || ''))) out.push({ g: 'Needs you', sig: true, icon: 'cloud', label: `Answer \u201cy\u201d: Remote Control in ${p.name || p.dir}`, hint: 'y/n', run: () => sysView.onAnswer(p.session) });
  }
  return out;
}
function fuzzy(label, q) {
  if (!q) return { score: 0, marks: null };
  const L = label.toLowerCase(), words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0; const marks = new Set();
  for (const w of words) {
    const i = L.indexOf(w);
    if (i >= 0) { score += 10 + (i === 0 || /[\s:/._-]/.test(L[i - 1]) ? 5 : 0); for (let k = i; k < i + w.length; k++) marks.add(k); continue; }
    let j = 0; const pos = [];
    for (let k = 0; k < L.length && j < w.length; k++) if (L[k] === w[j]) { pos.push(k); j++; }
    if (j < w.length) return null;
    score += 2; pos.forEach((p) => marks.add(p));
  }
  return { score, marks };
}
function markLabel(label, marks) {
  if (!marks || !marks.size) return [label];
  const out = []; let buf = '', on = false;
  for (let k = 0; k < label.length; k++) {
    const m = marks.has(k);
    if (m !== on) { if (buf) out.push(on ? h('mark', null, buf) : buf); buf = ''; on = m; }
    buf += label[k];
  }
  if (buf) out.push(on ? h('mark', null, buf) : buf);
  return out;
}
function renderPal() {
  const q = $('#pal-in').value.trim();
  let res = palItems(q).map((x) => { const f = fuzzy(x.label, q) || (q && (fuzzy(x.hint || '', q) || (x.alt && fuzzy(x.alt, q))) ? { score: 1, marks: null } : null); return f ? { ...x, ...f } : null; }).filter(Boolean);
  if (!q) {
    let chats = 0, news = 0;
    const pinned = App.data.projects.filter((p) => p.pinned).map((p) => p.id);
    res = res.filter((x) => (x.g !== 'Chats' || chats++ < 7) && (x.g !== 'New chat in project' || ((pinned.length ? pinned.includes(x.newIn.id) : true) && news++ < 4)) && !(x.g === 'Open' && / in VS Code$/.test(x.label)));
  } else res.sort((a, b) => b.score - a.score);
  const groups = [];
  for (const x of res) { let g = groups.find((y) => y.n === x.g); if (!g) groups.push(g = { n: x.g, i: [] }); g.i.push(x); }
  if (q) groups.forEach((g) => { g.i = g.i.slice(0, 6); });
  Pal.items = groups.flatMap((g) => g.i);
  Pal.sel = Math.min(Pal.sel, Math.max(0, Pal.items.length - 1));
  let k = 0;
  const list = $('#pal-l');
  if (!groups.length) {
    list.replaceChildren(h('div', { class: 'pal-empty' }, 'No match. Press ', h('kbd', null, '\u21b5'), ` to start a new Claude chat with \u201c${q}\u201d ready to send.`));
    return;
  }
  list.replaceChildren(...groups.flatMap((g) => [h('div', { class: 'pal-g' }, h('span', { class: 'lab' }, g.n)),
    ...g.i.map((x) => { const n = k++; return h('div', { class: 'pi' + (x.sig ? ' sig' : ''), role: 'option', 'aria-selected': String(n === Pal.sel), 'data-pi': n, onclick: () => runPal(n), onmousemove: () => { if (Pal.sel !== n) { Pal.sel = n; $$('.pi', list).forEach((el) => el.setAttribute('aria-selected', String(+el.dataset.pi === n))); } } },
      icon(x.icon, 14), x.sw ? projSw(x.sw) : null, x.tool && x.g !== 'Chats' && x.g !== 'Archived' ? toolBadge(x.tool) : null,
      h('span', { class: 'lb' }, markLabel(x.label, x.marks)), h('span', { class: 'hi' }, x.hint || ''), x.tool && (x.g === 'Chats' || x.g === 'Archived') ? toolBadge(x.tool) : null); })]));
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}
function runPal(n) {
  const x = Pal.items[n];
  $('#pal').close();
  if (x) x.run();
  else {
    const q = $('#pal-in').value.trim();
    const p = (App.view.filter !== '*' && App.data.projects.find((y) => y.id === App.view.filter)) || App.data.projects.find((y) => y.pinned && y.locations.length) || App.data.projects.find((y) => y.locations.length);
    if (p) newDraftChat(p, 'claude', null, q);
  }
}
function openPal(q = '') {
  const d = $('#pal');
  if (d.open) { d.close(); return; }
  for (const id of ['#sheet', '#menu']) if ($(id).open) $(id).close();
  $('#pal-in').value = q;
  Pal.sel = 0;
  renderPal();
  d.showModal();
  const inp = $('#pal-in');
  inp.focus(); inp.setSelectionRange(q.length, q.length);
}

// ------------------------------------------------------------------ router
// Routes: #/board, #/chat/<key> (#/chat alone = a chat that needs you, else the last one), #/system, #/secrets
function onRoute() {
  const hash = location.hash || '#/board';
  const m = /^#\/chat(?:\/(.+))?$/.exec(hash);
  let route = 'board';
  let key = null;
  if (m) {
    route = 'chat';
    key = m[1] ? decodeURIComponent(m[1]) : null;
    if (!key) {
      const needs = boardItems().find((it) => it.ui === 'needs' && !it.archived);
      key = needs ? needs.key : App.lastChat && (findChat(App.lastChat) || App.chats.has(App.lastChat)) ? App.lastChat : null;
      if (!key) { const first = boardItems().filter((x) => !x.archived).sort((a, b) => b.updated - a.updated)[0]; key = first ? first.key : null; }
    }
    // Any well-formed key opens (a deep link to a chat the list doesn't show yet still loads);
    // a draft only exists in the browser that made it.
    if (key && (!/^(claude|codex):[A-Za-z0-9-]+$/.test(key) || (isDraftKey(key) && !App.chats.has(key)))) { key = null; route = 'board'; history.replaceState(null, '', '#/board'); }
  } else if (/^#\/(system|overview)/.test(hash)) route = 'system';
  else if (hash.startsWith('#/secrets')) route = 'secrets';

  App.route = route;
  document.body.dataset.route = route;
  document.body.classList.remove('show-ctx');
  for (const [r, id] of [['board', '#scr-board'], ['chat', '#scr-chat'], ['system', '#scr-system'], ['secrets', '#scr-secrets']]) $(id).classList.toggle('on', r === route);
  for (const a of $$('[data-nav]')) { if (a.dataset.nav === route) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  if (route === 'chat') {
    if (key && App.view.current !== key) openChatView(key);
    if (!key && App.view.current == null) chatView.show(null);
    if (key && !isDraftKey(key)) { App.lastChat = key; store.set('roost.lastChat', key); }
    scheduleCtx();
  } else if (App.view.current) {
    // Off the chat screen nothing streams: the board's poll covers every session.
    App.view.current = null; App.view.meta = null;
    chatView.show(null); followOnly(null);
    $('#ctx').replaceChildren();
  }
  if (route === 'system') { renderSys(); if (!App.usageAt || Date.now() - App.usageAt > 60000) refreshUsage(); }
  if (route === 'secrets') { Secrets.render(); Secrets.refresh(); }
  renderBoard(true);
  pollLiveSoon();
}

function openChatView(key) {
  App.view.current = key;
  const ctx = chatContext(key);
  const entry = entryFor(key);
  followOnly(entry);
  const lv = liveFor(key);
  const c = ctx ? ctx.c : { tool: toolOf(key), title: (lv && lv.board && lv.board.title) || 'Chat', cwd: lv ? lv.cwd : '', branch: null };
  const p = ctx ? ctx.p : lv ? projectFor(lv.cwd) : null;
  entry.state.meta = { ...entry.state.meta, key, tool: c.tool };
  App.view.currentTitle = c.title;
  const meta = { key, tool: c.tool, title: c.title, cwd: c.cwd, branch: c.branch || (ctx && ctx.l.branch) || null, projectName: p ? p.name : '', projectColor: p ? p.color : null };
  App.view.meta = meta;
  chatView.show(entry.state, meta);
  loadHistory(entry);
  scheduleCtx();
}

// ------------------------------------------------------------------ keyboard
let gPending = 0;
function onKey(e) {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openPal(); return; }
  if ($('#pal').open || $('#sheet').open || $('#menu').open) return;
  const a = document.activeElement;
  const typing = a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
  if (typing || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const k = e.key;
  if (gPending && Date.now() - gPending < 900) {
    gPending = 0;
    const to = { b: '#/board', s: '#/system', c: '#/chat' }[k.toLowerCase()];
    if (to) { e.preventDefault(); location.hash = to; }
    return;
  }
  if (k === 'g') { gPending = Date.now(); return; }
  if (k === '/') { e.preventDefault(); openPal(); return; }
  if (k === 'c') { e.preventDefault(); openPal('new '); return; }
  if (k === 'a' || k === 'A') {
    if (App.route === 'chat') {
      const en = App.chats.get(App.view.current);
      const p = en && pendingPermissions(en.state)[0];
      if (p) { e.preventDefault(); decideCurrent(p.req.id, 'allow'); }
    } else if (App.route === 'board' && boardView.firstKey) {
      const it = itemFor(boardView.firstKey);
      if (it && it.sum.perms[0]) { e.preventDefault(); boardDecide(it, it.sum.perms[0], 'allow'); }
    }
    return;
  }
  if ((k === 'd' || k === 'D') && App.route === 'chat') {
    const en = App.chats.get(App.view.current);
    const p = en && pendingPermissions(en.state)[0];
    if (p) { e.preventDefault(); chatView.openDeny(p.req.id); }
  }
}

// ------------------------------------------------------------------ theme
const THEMES = ['system', 'light', 'dark'];
function applyTheme() {
  const theme = store.get('roost.theme', 'system');
  if (theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  const b = $('#theme-btn');
  b.replaceChildren(icon(theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'contrast', 16));
  b.setAttribute('aria-label', 'Colour theme: ' + theme);
  b.title = `Theme: ${theme} (click to change)`;
}
function cycleTheme() {
  const theme = THEMES[(THEMES.indexOf(store.get('roost.theme', 'system')) + 1) % 3];
  store.set('roost.theme', theme);
  applyTheme();
  toast('Theme: ' + theme);
}
function setArchived(on) {
  App.view.showArchived = on;
  $('#archived-btn').setAttribute('aria-pressed', String(on));
  renderBoard(true);
}

// ------------------------------------------------------------------ shell
function initShell() {
  const nav = (href, route, ic, label, kbd, badge) => h('a', { href, 'data-nav': route, 'aria-label': label }, icon(ic, 17), badge ? h('span', { class: 'badge-n', 'data-needs-badge': '', hidden: true }) : null, h('span', { class: 'tip' }, label, kbd ? h('kbd', null, kbd) : null));
  const mod = isMac ? '\u2318K' : 'Ctrl K';
  $('#rail').append(
    nav('#/board', 'board', 'board', 'Board', 'G B', true),
    nav('#/chat', 'chat', 'message', 'Chat', 'G C'),
    nav('#/system', 'system', 'pulse', 'System', 'G S'),
    nav('#/secrets', 'secrets', 'key', 'Secrets'),
    h('div', { class: 'grow' }),
    h('button', { type: 'button', 'aria-label': 'New chat', onclick: () => openPal('new ') }, icon('plus', 17), h('span', { class: 'tip' }, 'New chat', h('kbd', null, 'C'))),
    h('button', { type: 'button', 'aria-label': 'Command palette', onclick: () => openPal() }, icon('cmd', 16), h('span', { class: 'tip' }, 'Command palette', h('kbd', null, mod))));
  const bn = (href, route, ic, label, badge) => h('a', { href, 'data-nav': route }, icon(ic, 19), label, badge ? h('span', { class: 'badge-n', 'data-needs-badge': '', hidden: true }) : null);
  $('#bnav').append(bn('#/board', 'board', 'board', 'Board', true), bn('#/chat', 'chat', 'message', 'Chat'),
    h('button', { type: 'button', onclick: () => openPal() }, icon('search', 19), 'Jump'),
    bn('#/system', 'system', 'pulse', 'System'), bn('#/secrets', 'secrets', 'key', 'Secrets'));
  $('#mod-k').textContent = mod;
  $('.kbox-ic').append(icon('search', 13));
  $('#kbox').addEventListener('click', () => openPal());
  $('#qlinks').prepend(
    h('a', { class: 'ibtn', href: 'code/', target: '_blank', rel: 'noopener', title: 'VS Code', 'aria-label': 'VS Code' }, icon('code', 16)),
    h('a', { class: 'ibtn', href: 'files/', target: '_blank', rel: 'noopener', title: 'Files', 'aria-label': 'Files' }, icon('folderOpen', 16)),
    h('a', { class: 'ibtn', href: 'term/', target: '_blank', rel: 'noopener', title: 'Terminal', 'aria-label': 'Terminal' }, icon('terminal', 16)));
  $('#sl-board').append(icon('board', 16));
  for (const el of $$('.filter-ic')) el.append(icon('search', 13));
  $('.pal-ic').append(icon('search', 16));
  $('#new-chat').prepend(icon('plus', 13));
  $('#new-chat').addEventListener('click', () => openPal('new '));
  $('#new-chat-menu').append(icon('chevronDown', 12));
  $('#new-chat-menu').addEventListener('click', (e) => newChatMenu(e.currentTarget));
  $('#needs-pill').addEventListener('click', () => {
    const it = boardItems().find((x) => x.lane === 'needs' && !x.archived);
    if (!it) { toast('Nothing needs you'); return; }
    if (App.route === 'board') { const lane = $('[data-lane="needs"]'); if (lane) lane.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    else openChat(it.key);
  });
  $('#theme-btn').addEventListener('click', cycleTheme);
  applyTheme();
  if (store.get('roost.ctx', 'on') === 'off') document.body.dataset.ctx = 'off';

  $('#filter').addEventListener('input', (e) => { App.view.text = e.target.value; renderBoard(true); });
  $('#sl-filter').addEventListener('input', (e) => { App.view.slText = e.target.value; renderBoard(true); });
  $('#archived-btn').addEventListener('click', () => setArchived(!App.view.showArchived));

  // Palette
  $('#pal-in').addEventListener('input', () => { Pal.sel = 0; renderPal(); });
  $('#pal-in').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { Pal.sel = Math.min(Pal.items.length - 1, Pal.sel + 1); renderPal(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { Pal.sel = Math.max(0, Pal.sel - 1); renderPal(); e.preventDefault(); }
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runPal(Pal.sel); }
  });
  $('#pal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  document.addEventListener('keydown', onKey);

  // Keep the chat layer (and its composer) above the on-screen keyboard (iOS).
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => {
      document.documentElement.style.setProperty('--vvh', vv.height + 'px');
      document.documentElement.style.setProperty('--vv-top', vv.offsetTop + 'px');
      document.body.classList.toggle('kbd-open', window.innerHeight - vv.height > 120);
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    fit();
  }
  window.addEventListener('hashchange', onRoute);
  window.addEventListener('popstate', onRoute);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshProjects(); refreshStatus(); pollLiveSoon(); } });

  // Live elapsed timers.
  setInterval(() => {
    const now = Date.now();
    for (const el of $$('[data-since]')) el.textContent = fmtDur(now - +el.dataset.since);
    for (const el of $$('[data-clock]')) el.textContent = fmtClock(now - +el.dataset.clock);
  }, 1000);
}

// The mode and model new chats start with, per tool (null: not picked yet). The server
// keeps the real copy; this one follows your picks so new drafts match without a refetch.
const DEFAULTS = { claude: { mode: null, model: null }, codex: { mode: null, model: null } };
const NO_CARRY_MODES = new Set(['bypassPermissions', 'full-access', 'plan']);

async function loadModels() {
  try {
    const m = await api('GET', 'api/live/models');
    for (const tool of ['claude', 'codex']) if (m[tool] && m[tool].length) MODELS[tool] = m[tool];
    for (const tool of ['claude', 'codex']) {
      const d = (m.defaults && m.defaults[tool]) || {};
      if (DEFAULTS[tool].mode == null && d.mode) DEFAULTS[tool].mode = d.mode;
      if (DEFAULTS[tool].model == null && d.model != null && MODELS[tool].some((x) => x.v === d.model)) DEFAULTS[tool].model = d.model;
    }
  } catch {}
}

// ------------------------------------------------------------------ boot
initShell();
(async () => {
  loadModels(); // never block the first paint on the model list
  await Promise.all([refreshProjects(), refreshStatus(), refreshLive()]);
  const hs = location.hash;
  if (!hs || hs === '#/' || hs === '#/projects') history.replaceState(null, '', '#/board');
  else if (hs === '#/overview') history.replaceState(null, '', '#/system');
  onRoute();
  refreshUsage();
  pollLive();
  setInterval(() => { if (!document.hidden) refreshProjects(); }, 10000);
  setInterval(() => { if (!document.hidden) refreshStatus(); }, 5000);
  setInterval(() => { if (!document.hidden) refreshUsage(); }, 120000);
})();
