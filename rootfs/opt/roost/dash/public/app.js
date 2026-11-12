'use strict';
/* =========================================================================
   roost dashboard: app shell, router and backend wiring.
   ui.js holds the renderers, the chat reducer and the views; this file feeds
   them real data:
     GET  api/status, api/projects            polled
     GET  api/live/history, api/live/stream   chat history + live events (SSE)
     POST api/live/{send,interrupt,permission,settings,close}
     POST api/chats/..., api/projects/..., api/services/..., api/rc/...
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

const mqDesk = matchMedia('(min-width: 1000px)');

const App = {
  data: { projects: [], archivedCount: 0, live: [] },
  status: null,
  chats: new Map(),   // key -> entry {state, es, live, pendingNew, key}
  drafts: new Map(),  // placeholder chats created in this browser (key -> {chat, projectId})
  view: { current: null, filter: '', showArchived: false, expanded: new Set(store.get('roost.expanded', [])), desktop: mqDesk.matches },
  consoles: new Set(),
  lastChat: store.get('roost.lastChat', null),
  route: 'projects',

  // In-roost state of a chat for the tree: needs | busy | error | idle | null.
  chatStatus(key) {
    const e = this.chats.get(key);
    if (e && e.state && e.state.items.length) {
      const s = e.state.status;
      if (s === 'waiting' || pendingPermissions(e.state).length) return 'needs';
      if (BUSY.has(s)) return 'busy';
      if (s === 'error') return 'error';
      if (s === 'offline' || s === 'closed') return null;
      return e.live ? 'idle' : null;
    }
    const l = (this.data.live || []).find((x) => x.keys.includes(key));
    if (!l || !l.running) return null;
    if (l.pending || l.status === 'waiting') return 'needs';
    if (BUSY.has(l.status)) return 'busy';
    if (l.status === 'error') return 'error';
    return 'idle';
  },
};

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
    const known = MODELS[entry.state.meta.tool || toolOf(entry.key)] || [];
    if (!known.some((m) => m.v === ev.model)) delete ev.model;
    rekey(entry, ev.key);
  }
  if (ev.type === 'status') entry.live = ev.status !== 'closed' && ev.status !== 'offline';
  const res = applyEvent(entry.state, ev, at || ev.at || Date.now());
  if (chatView.state === entry.state) chatView.update(res);
  if (res.chrome || ev.type === 'user' || ev.type === 'result') scheduleTree();
}

const toolOf = (key) => String(key).split(':')[0];
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
    App.lastChat = newKey;
    store.set('roost.lastChat', newKey);
    history.replaceState(history.state, '', '#/chat/' + encodeURIComponent(newKey));
  }
  refreshProjects();
}

// Follow a chat's live event stream. `skipBefore` drops replayed events that the
// transcript history already showed.
function connect(entry, streamKey, skipBefore) {
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
      entry.live = !!ev.live;
      if (ev.live && entry.state.status !== ev.status) ingest(entry, { t: 'status', status: ev.status });
      if (ev.model && !entry.state.model) entry.state.model = ev.model;
      if (ev.mode && !entry.state.mode) entry.state.mode = ev.mode;
      return;
    }
    if (ev.seq) entry.seq = Math.max(entry.seq, ev.seq);
    if (skipBefore && ev.at && ev.at < skipBefore && !/^(permission|permission-resolved|status|session)$/.test(ev.t)) return;
    ingest(entry, ev);
  };
}

async function loadHistory(entry) {
  if (entry.loaded || isDraftKey(entry.key)) { entry.loaded = true; return; }
  entry.loaded = true;
  const opened = Date.now();
  try {
    const { events } = await api('GET', `api/live/history?key=${encodeURIComponent(entry.key)}`);
    const t0 = opened - 60000;
    events.forEach((ev, i) => ingest(entry, ev, ev.at || t0 + i));
  } catch (e) {
    ingest(entry, { t: 'notice', level: 'error', text: `Couldn't load this chat's history: ${e.message}` });
  }
  if (entry.state.status === 'offline' || entry.state.status === 'idle') applyEvent(entry.state, { type: 'status', status: 'offline' });
  connect(entry, entry.key, opened);
}

async function sendMessage(text) {
  const key = App.view.current;
  const entry = App.chats.get(key);
  if (!entry) return;
  const st = entry.state;
  const draft = App.drafts.get(key);
  const body = { tool: toolOf(key), text, model: st.model || undefined, mode: st.mode || undefined };
  if (draft && isDraftKey(entry.key)) Object.assign(body, { project: draft.projectId, dir: draft.chat.cwd });
  else body.key = entry.key;
  ingest(entry, { t: 'status', status: 'starting' });
  try {
    const r = await api('POST', 'api/live/send', body);
    connect(entry, r.pendingKey || r.key, 0);
  } catch (e) {
    ingest(entry, { t: 'notice', level: 'error', text: e.message });
    ingest(entry, { t: 'status', status: 'error' });
  }
}

const liveKey = (entry) => entry.streamKey || entry.key;

const chatView = createChatView($('#chat-pane'), {
  onSend: (text, files) => {
    if (files && files.length) toast('Attachments aren’t supported yet; put files in the project with Files.');
    if (text) sendMessage(text);
  },
  onStop: () => { const e = App.chats.get(App.view.current); if (e) api('POST', 'api/live/interrupt', { key: liveKey(e) }).catch((x) => toast(x.message)); },
  onDecide: (id, decision, reason) => {
    const e = App.chats.get(App.view.current);
    if (!e) return;
    const item = e.state.byId.get('perm:' + id);
    if (item && reason) item.reasonNote = reason;
    api('POST', 'api/live/permission', { key: liveKey(e), id, decision, message: reason || undefined })
      .then(() => { if (decision === 'always' && item && item.req.always) toast(`Allowed ${item.req.always}`); })
      .catch((x) => toast(x.message));
  },
  onModel: (v) => { const e = App.chats.get(App.view.current); if (e && e.live) api('POST', 'api/live/settings', { key: liveKey(e), model: v }).catch(() => {}); },
  onMode: (v) => { const e = App.chats.get(App.view.current); if (e && e.live) api('POST', 'api/live/settings', { key: liveKey(e), mode: v }).catch(() => {}); },
  onBack: () => { if (history.state && history.state.fromTree) history.back(); else location.hash = '#/projects'; },
  onClose: () => { location.hash = '#/projects'; },
  onTerminal: () => openInTerminal(App.view.current),
  onRename: (title) => {
    const c = findChat(App.view.current);
    if (c) { c.title = title; renderTree(); }
    if (isDraftKey(App.view.current)) return;
    api('POST', 'api/chats/rename', { chat: App.view.current, title }).catch((x) => toast(x.message));
  },
  onRetry: () => {
    const e = App.chats.get(App.view.current);
    const last = e && [...e.state.items].reverse().find((i) => i.kind === 'user');
    if (last) sendMessage(last.text); else toast('Nothing to retry');
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

// ------------------------------------------------------------------ projects data
function allChats() {
  const out = [];
  for (const p of App.data.projects) for (const l of p.locations) for (const c of l.chats) out.push({ p, l, c });
  return out;
}
function findChat(key) { const x = allChats().find((y) => y.c.key === key); return x ? x.c : null; }
function chatContext(key) { return allChats().find((y) => y.c.key === key) || null; }

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
      // Keep the open chat's header title in step with the tree (e.g. Claude's own title).
      const cur = App.view.current && findChat(App.view.current);
      if (cur && cur.title && chatView.retitle && cur.title !== App.view.currentTitle) { App.view.currentTitle = cur.title; chatView.retitle(cur.title); }
      if (!store.get('roost.expanded', null) && App.view.expanded.size === 0) App.data.projects.slice(0, 3).forEach((p) => App.view.expanded.add(p.id));
      setConn(true);
      renderTree();
      updateNavBadges();
      if (App.route === 'chat' && App.view.current && !findChat(App.view.current) && !App.chats.has(App.view.current)) onRoute();
    } catch (e) {
      setConn(false);
    } finally {
      projectsLoading = null;
    }
  })();
  return projectsLoading;
}

async function refreshStatus() {
  try {
    App.status = await api('GET', 'api/status');
    setConn(true);
    $('#host').textContent = `${App.status.name} · ${App.status.versions.roost}`;
    if (App.route === 'overview') renderOv();
    updateNavBadges();
  } catch {
    setConn(false);
  }
}

function setConn(ok) {
  const c = $('#conn');
  c.classList.toggle('is-stale', !ok);
  c.querySelector('span:nth-child(2)').textContent = ok ? 'Live' : 'Offline';
}

// ------------------------------------------------------------------ tree
let treeRaf = 0;
function scheduleTree() { if (!treeRaf) treeRaf = requestAnimationFrame(() => { treeRaf = 0; renderTree(); updateNavBadges(); }); }

function newDraftChat(p, tool, dir) {
  const loc = (dir && p.locations.find((l) => l.path === dir)) || p.locations[0];
  if (!loc) { toast('This project has no folder yet'); return; }
  const key = `${tool}:new-${Math.random().toString(16).slice(2, 10)}`;
  const chat = { key, tool, title: 'New chat', cwd: loc.path, branch: loc.branch, updated: new Date().toISOString(), prompts: 0, active: false, session: null, remote: false, prs: [], archived: false };
  App.drafts.set(key, { chat, projectId: p.id });
  const e = entryFor(key);
  e.loaded = true;
  e.state.status = 'idle';
  loc.chats.unshift(chat);
  p.chatCount++;
  App.view.expanded.add(p.id);
  store.set('roost.expanded', [...App.view.expanded]);
  treeHandlers.onOpen(key);
  if (matchMedia('(pointer: fine)').matches) chatView.focusComposer();
}

const treeHandlers = {
  onOpen: (key) => { history.pushState({ fromTree: true }, '', '#/chat/' + encodeURIComponent(key)); onRoute(); },
  onToggle: (id) => { const e = App.view.expanded; e.has(id) ? e.delete(id) : e.add(id); store.set('roost.expanded', [...e]); renderTree(); },
  onChatMenu: (c, anchor) => openMenu(anchor, [
    { label: 'Open chat', icon: 'message', onClick: () => treeHandlers.onOpen(c.key) },
    isDraftKey(c.key) ? null : { label: c.session ? 'Attach in terminal' : 'Resume in terminal', icon: 'terminal', onClick: () => openInTerminal(c.key) },
    isDraftKey(c.key) ? null : { label: 'Move to project…', icon: 'move', onClick: () => openMoveSheet(c) },
    'sep',
    isDraftKey(c.key) ? null : { label: c.archived ? 'Unarchive' : 'Archive', icon: 'archive', onClick: () => archiveChat(c) },
    App.chatStatus(c.key) ? { label: 'Stop in roost', icon: 'x', onClick: () => stopLive(c.key) } : null,
  ].filter(Boolean), c.title),
  onProjectMenu: (p, anchor) => openMenu(anchor, [
    { label: 'New Claude chat', icon: 'plus', onClick: () => newDraftChat(p, 'claude') },
    { label: 'New Codex chat', icon: 'plus', onClick: () => newDraftChat(p, 'codex') },
    'sep',
    { label: 'Preview a web server…', icon: 'globe', onClick: () => Viewer.pick(anchor, p) },
    p.paths[0] ? { label: 'Open in VS Code', icon: 'code', href: 'code/?folder=' + encodeURIComponent(p.paths[0]) } : null,
    p.paths[0] ? { label: 'Open in Files', icon: 'folderOpen', href: 'files/files/workspace/' + encodeURI(relPath(p.paths[0])) } : null,
    p.other ? null : { label: 'Edit project', icon: 'pencil', onClick: () => treeHandlers.onEdit(p) },
  ].filter(Boolean), p.name),
  onNewChat: (p, tool) => newDraftChat(p, tool),
  onEdit: (p) => openProjectForm(p, async (v) => {
    if (!v.name) throw new Error('Give the project a name.');
    const saved = await api('PATCH', `api/projects/${encodeURIComponent(p.id)}`, { name: v.name, color: v.color, pinned: v.pinned, paths: v.paths.length ? v.paths : p.paths });
    const was = p.rc && p.rc.enabled ? p.rc.mode : 'off';
    if (v.rc && v.rc !== was) await api('POST', `api/projects/${encodeURIComponent(saved.id)}/remote-control`, { enabled: v.rc !== 'off', mode: v.rc === 'off' ? undefined : v.rc });
    toast('Saved');
    await refreshProjects();
  }, async (pp) => {
    try { await api('DELETE', `api/projects/${encodeURIComponent(pp.id)}`); toast('Grouping removed'); } catch (e) { toast(e.message); }
    await refreshProjects();
  }),
  onExternal: () => {}, // links open in a new tab by themselves
};

async function archiveChat(c) {
  try {
    await api('POST', 'api/chats/archive', { chat: c.key, archived: !c.archived });
    toast(c.archived ? 'Unarchived' : 'Archived. Find it under Archived.');
  } catch (e) { toast(e.message); }
  refreshProjects();
}

async function stopLive(key) {
  const e = App.chats.get(key);
  try { await api('POST', 'api/live/close', { key: e ? liveKey(e) : key }); toast('Stopped. The chat’s history is kept.'); } catch (x) { toast(x.message); }
  if (e) ingest(e, { t: 'status', status: 'closed' });
  refreshProjects();
}

function openMoveSheet(c) {
  const ctx = chatContext(c.key);
  openMenu(null, [{ title: 'Move to' }, ...App.data.projects.filter((p) => !p.other).map((p) => ({
    label: p.name, swatch: p.color, check: ctx && ctx.p === p, onClick: () => moveChat(c, p),
  })), ...(c.assigned ? ['sep', { label: 'Back to its folder', icon: 'refresh', onClick: () => moveChat(c, null) }] : [])], 'Move “' + c.title + '”');
}

async function moveChat(c, p) {
  try {
    await api('POST', 'api/chats/assign', { chat: c.key, project: p ? p.id : null });
    if (p) { App.view.expanded.add(p.id); store.set('roost.expanded', [...App.view.expanded]); }
    toast(p ? `Filed under ${p.name}` : 'Moved back to its folder');
  } catch (e) { toast(e.message); }
  refreshProjects();
}

function renderTree() {
  const tree = $('#tree');
  const fk = document.activeElement && tree.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
  const view = { ...App.view, ...treeHandlers, desktop: mqDesk.matches };
  if (!App.data.projects.length) {
    tree.replaceChildren(h('div', { class: 'card', style: 'padding:18px' },
      h('p', { style: 'margin:0 0 6px;font-weight:600' }, 'No projects yet'),
      h('p', { class: 'muted', style: 'margin:0' }, 'Use New project to clone a repository or create a folder. Chats from Claude and Codex show up here automatically, wherever you start them.')));
  } else {
    tree.replaceChildren(...renderProjectTree(App.data, view));
  }
  $('#archived-count').textContent = App.data.archivedCount ? `(${App.data.archivedCount})` : '';
  if (fk) tree.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus();
}

function updateNavBadges() {
  const keys = new Set([...App.chats.keys(), ...(App.data.live || []).flatMap((l) => l.keys)]);
  let needs = 0;
  for (const k of keys) if (!isDraftKey(k) || App.chats.has(k)) if (App.chatStatus(k) === 'needs') needs++;
  for (const b of $$('[data-needs-badge]')) { b.hidden = !needs; b.textContent = String(needs); }
}

// ------------------------------------------------------------------ overview
function renderOv() {
  if (!App.status) return;
  const view = {
    consoles: App.consoles,
    onConsole: (sess) => { App.consoles.has(sess) ? App.consoles.delete(sess) : App.consoles.add(sess); renderOv(); },
    onAnswer: async (sess) => {
      try { await api('POST', `api/rc/${encodeURIComponent(sess)}/keys`, 'y', true); toast('Sent “y”'); } catch (e) { toast(e.message); }
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
        foot: [h('span', { class: 'spacer', hidden: true }), copyButton(() => text, 'Copy log', 'Copy log'), h('button', { type: 'button', class: 'btn', onclick: () => $('#sheet').close() }, 'Close')],
      });
      const pre = $('#sheet .log-pre');
      if (pre) pre.scrollTop = pre.scrollHeight;
    },
    onExternal: () => {},
  };
  const ov = $('#ov');
  const y = ov.parentElement.scrollTop;
  ov.replaceChildren(...renderOverview(App.status, view));
  ov.parentElement.scrollTop = y;
}

// ------------------------------------------------------------------ router
// Routes: #/projects, #/chat/<key>, #/overview  (#/chat alone = last opened chat)
function onRoute() {
  const hash = location.hash || '#/projects';
  const m = /^#\/chat(?:\/(.+))?$/.exec(hash);
  let route = 'projects';
  let key = null;
  if (m) {
    key = m[1] ? decodeURIComponent(m[1]) : null;
    if (!key) {
      const needs = [...App.chats.keys()].find((k) => App.chatStatus(k) === 'needs');
      key = needs || (App.lastChat && (findChat(App.lastChat) || App.chats.has(App.lastChat)) ? App.lastChat : null);
      if (!key) { const first = allChats()[0]; key = first ? first.c.key : null; }
    }
    if (key && /^(claude|codex):[A-Za-z0-9-]+$/.test(key) && (findChat(key) || App.chats.has(key))) route = 'chat';
    else key = null;
  } else if (hash.startsWith('#/overview')) route = 'overview';
  else if (hash.startsWith('#/secrets')) route = 'secrets';

  App.route = route;
  document.body.dataset.route = route;
  $('#view-projects').hidden = route === 'overview' || route === 'secrets';
  $('#view-overview').hidden = route !== 'overview';
  $('#view-secrets').hidden = route !== 'secrets';
  for (const a of $$('[data-nav]')) {
    const on = a.dataset.nav === route || (a.closest('.tabs') && a.dataset.nav === 'projects' && route === 'chat');
    a.removeAttribute('aria-current');
    if (on) a.setAttribute('aria-current', 'page');
  }
  if (route === 'chat') {
    if (App.view.current !== key) openChatView(key);
    document.body.dataset.chatOpen = 'true';
    if (!isDraftKey(key)) { App.lastChat = key; store.set('roost.lastChat', key); }
  } else {
    document.body.dataset.chatOpen = 'false';
    if (route === 'projects' && mqDesk.matches && App.view.current) { App.view.current = null; chatView.show(null); }
  }
  if (route === 'overview') renderOv();
  if (route === 'secrets') { Secrets.render(); Secrets.refresh(); }
  renderTree();
}

function openChatView(key) {
  App.view.current = key;
  const ctx = chatContext(key);
  const entry = entryFor(key);
  const c = ctx ? ctx.c : { tool: toolOf(key), title: 'Chat', cwd: '', branch: null };
  entry.state.meta = { ...entry.state.meta, key, tool: c.tool };
  App.view.currentTitle = c.title;
  chatView.show(entry.state, {
    key, tool: c.tool, title: c.title, cwd: c.cwd, branch: c.branch,
    projectName: ctx ? ctx.p.name : '', projectColor: ctx ? ctx.p.color : null,
  });
  loadHistory(entry);
}

// ------------------------------------------------------------------ shell
function initShell() {
  $('#new-project').append(icon('plus', 15), 'New project');
  $('#expand-all').append(icon('expand', 17));
  $('#collapse-all').append(icon('collapse', 17));
  const nav = $$('.bottomnav a');
  nav[0].append(icon('folder', 22), 'Projects');
  nav[1].append(icon('message', 22), 'Chat', h('span', { class: 'nav-badge', 'data-needs-badge': '', hidden: true }));
  nav[2].append(icon('grid', 22), 'Overview');
  nav[3].append(icon('key', 22), 'Secrets');

  $('#filter').addEventListener('input', (e) => { App.view.filter = e.target.value.trim().toLowerCase(); renderTree(); });
  $('#archived-btn').addEventListener('click', (e) => { App.view.showArchived = !App.view.showArchived; e.currentTarget.setAttribute('aria-pressed', String(App.view.showArchived)); renderTree(); });
  $('#expand-all').addEventListener('click', () => { App.data.projects.forEach((p) => App.view.expanded.add(p.id)); store.set('roost.expanded', [...App.view.expanded]); renderTree(); });
  $('#collapse-all').addEventListener('click', () => { App.view.expanded.clear(); store.set('roost.expanded', []); renderTree(); });
  $('#new-project').addEventListener('click', () => openProjectForm(null, async (v) => {
    if (!v.name) throw new Error('Give the project a name.');
    const body = { name: v.name, color: v.color };
    if (v.source === 'git') {
      if (!/^(https:\/\/|git@|ssh:\/\/)/.test(v.gitUrl)) throw new Error('That doesn’t look like a git URL. Use https://… or git@…');
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
    App.view.expanded.add(p.id);
    store.set('roost.expanded', [...App.view.expanded]);
    toast(`Created ${p.name}`);
    await refreshProjects();
  }));

  // Keyboard: arrows move between projects and chats in the tree.
  $('#tree').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = $$('.proj-toggle, .chat-open', $('#tree'));
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
  });

  // Desktop enhancement: drag a chat onto a project header to file it there.
  let dragging = null;
  const tree = $('#tree');
  tree.addEventListener('dragstart', (e) => { const li = e.target.closest('.chat-item'); if (!li || isDraftKey(li.dataset.key)) return; dragging = li.dataset.key; e.dataTransfer.setData('text/plain', dragging); e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); document.body.classList.add('is-dragging'); });
  tree.addEventListener('dragend', () => { dragging = null; $$('.dragging, .drop-target').forEach((x) => x.classList.remove('dragging', 'drop-target')); document.body.classList.remove('is-dragging'); });
  tree.addEventListener('dragover', (e) => { const sec = e.target.closest('.proj'); if (!dragging || !sec || sec.classList.contains('other')) return; e.preventDefault(); $$('.drop-target').forEach((x) => x !== sec && x.classList.remove('drop-target')); sec.classList.add('drop-target'); });
  tree.addEventListener('drop', (e) => {
    const sec = e.target.closest('.proj');
    if (!dragging || !sec) return;
    e.preventDefault();
    const c = findChat(dragging);
    const p = App.data.projects.find((x) => x.id === sec.dataset.id);
    if (c && p) moveChat(c, p);
  });

  // Theme: system -> light -> dark
  const themes = ['system', 'light', 'dark'];
  let theme = store.get('roost.theme', 'system');
  const applyTheme = () => {
    if (theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
    const b = $('#theme-btn');
    b.replaceChildren(icon(theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'contrast', 19));
    b.setAttribute('aria-label', 'Colour theme: ' + theme);
    b.title = 'Theme: ' + theme;
  };
  $('#theme-btn').addEventListener('click', () => { theme = themes[(themes.indexOf(theme) + 1) % 3]; store.set('roost.theme', theme); applyTheme(); toast('Theme: ' + theme); });
  applyTheme();

  // Keep the chat layer (and its composer) above the on-screen keyboard.
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
  mqDesk.addEventListener('change', () => { renderTree(); if (mqDesk.matches && App.route === 'projects' && !App.view.current) chatView.show(null); });
  window.addEventListener('hashchange', onRoute);
  window.addEventListener('popstate', onRoute);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshProjects(); refreshStatus(); } });

  // Live elapsed timers and the header clock.
  setInterval(() => {
    const now = Date.now();
    for (const el of $$('[data-since]')) el.textContent = fmtDur(now - +el.dataset.since);
    $('#conn-time').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }, 1000);

  $('#tree-foot').append(
    h('div', { class: 'legend' },
      h('span', null, h('span', { class: 'dot ring' }), 'Open in roost'),
      h('span', null, h('span', { class: 'dot busy' }), 'Working'),
      h('span', null, h('span', { class: 'badge needs' }, 'Needs you')),
      h('span', null, h('span', { class: 'badge live' }, 'live'), 'written in the last 90s')),
    h('p', { style: 'margin:0' }, 'Every folder in /workspace is a project. File a chat under another project from its ⋯ menu (or drag it on a desktop). Grouping only changes this view: chats and files stay where they are.'));
}

async function loadModels() {
  try {
    const m = await api('GET', 'api/live/models');
    for (const tool of ['claude', 'codex']) if (m[tool] && m[tool].length) MODELS[tool] = m[tool];
  } catch {}
}

// ------------------------------------------------------------------ boot
initShell();
(async () => {
  loadModels(); // never block the first paint on the model list
  await Promise.all([refreshProjects(), refreshStatus()]);
  if (!location.hash) history.replaceState(null, '', '#/projects');
  onRoute();
  setInterval(() => { if (!document.hidden) refreshProjects(); }, 10000);
  setInterval(() => { if (!document.hidden) refreshStatus(); }, 5000);
})();
