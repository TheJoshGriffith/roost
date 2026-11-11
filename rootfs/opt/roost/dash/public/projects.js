'use strict';
// roost dashboard: Projects view (project -> folder/worktree -> chats tree).

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COLORS = ['#e0913f', '#5b9bd5', '#5cc27e', '#c678dd', '#e06c75', '#56b6c2', '#d19a66', '#98a2b3'];
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  let data = null;
  let expanded = new Set(store.get('roost.expanded', []));
  let collapsedLocs = new Set(store.get('roost.collapsedLocs', []));
  let showArchived = false;
  let filter = '';
  let dragging = null;
  let editing = null; // project being edited in the dialog (null = new)

  // ------------------------------------------------------------ api
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: method === 'GET' ? {} : { 'X-Roost': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let j = null;
    try { j = await res.json(); } catch {}
    if (!res.ok) throw new Error((j && j.error) || res.statusText);
    return j;
  }

  function ago(iso) {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  const openTerm = (session) => window.open(`term/?arg=${encodeURIComponent(session)}`, '_blank');
  const relWorkspace = (p) => p.replace(/^\/workspace\/?/, '');

  // ------------------------------------------------------------ render
  function chatMatches(c) {
    if (!showArchived && c.archived) return false;
    if (showArchived && !c.archived) return false;
    if (!filter) return true;
    return (c.title + ' ' + (c.cwd || '') + ' ' + (c.branch || '')).toLowerCase().includes(filter);
  }

  function renderChat(c, projects) {
    const badges = [
      c.active ? '<span class="badge live" title="Written to in the last 90 seconds">live</span>' : '',
      c.session ? '<span class="badge open" title="Open in a roost terminal session">open</span>' : '',
      c.remote ? '<span class="badge rc" title="Has been driven over Remote Control">remote</span>' : '',
      ...c.prs.slice(0, 2).map((u) => `<a class="badge pr" href="${esc(u)}" target="_blank" rel="noopener">PR #${esc(u.split('/').pop())}</a>`),
    ].join('');
    const moveOpts = ['<option value="">Move to…</option>']
      .concat(projects.filter((p) => !p.other).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`))
      .concat(c.assigned ? ['<option value="__auto">↺ Back to its folder</option>'] : [])
      .join('');
    return `<li class="chat" draggable="true" data-key="${esc(c.key)}">
      <span class="tool ${c.tool}" title="${c.tool === 'claude' ? 'Claude Code' : 'Codex'}">${c.tool === 'claude' ? 'C' : 'X'}</span>
      <button class="chat-title" data-act="view" title="${esc(c.title)}">${esc(c.title)}</button>
      ${badges}
      <span class="chat-meta">${c.prompts} prompt${c.prompts === 1 ? '' : 's'} · ${esc(ago(c.updated))}${c.assigned ? ' · filed' : ''}</span>
      <span class="chat-actions">
        <button class="btn small" data-act="open" title="${c.tool === 'claude' ? 'claude --resume' : 'codex resume'} in a terminal">${c.session ? 'Attach' : 'Resume'}</button>
        <select class="btn small move" data-act="move" aria-label="Move chat to project">${moveOpts}</select>
        <button class="btn small ghost" data-act="archive" title="${c.archived ? 'Unarchive' : 'Archive (hide from this view)'}">${c.archived ? 'Unarchive' : 'Archive'}</button>
      </span>
    </li>`;
  }

  function renderProject(p, projects) {
    const locs = p.locations.map((l) => ({ ...l, chats: l.chats.filter(chatMatches) }));
    const shown = locs.reduce((n, l) => n + l.chats.length, 0);
    const nameHit = !filter || p.name.toLowerCase().includes(filter);
    if (filter && !shown && !nameHit) return '';
    if (showArchived && !shown) return '';
    if (p.other && !shown) return '';
    const open = expanded.has(p.id) || !!filter;
    const rc = p.rc.enabled
      ? `<button class="badge rc-toggle ${p.rc.running ? 'on' : 'warn'}" data-act="rc" title="Remote Control server for this project (${esc(p.rc.mode)})">RC ${p.rc.running ? 'on' : 'starting'} · ${esc(p.rc.mode)}</button>`
      : (p.paths.length ? '<button class="badge rc-toggle" data-act="rc" title="Give this project its own Remote Control server (opens Edit)">RC off</button>' : '');
    const firstPath = p.paths[0];
    const tools = p.other ? '' : `
        <button class="btn small" data-act="new-claude" title="Start a new Claude Code chat in ${esc(firstPath || '')}">+ Claude</button>
        <button class="btn small" data-act="new-codex" title="Start a new Codex chat in ${esc(firstPath || '')}">+ Codex</button>
        ${firstPath ? `<a class="btn small" href="code/?folder=${encodeURIComponent(firstPath)}" target="_blank">VS Code</a>
        <a class="btn small" href="files/files/workspace/${esc(relWorkspace(firstPath))}" target="_blank">Files</a>` : ''}
        <button class="btn small ghost" data-act="edit" title="Rename, colour, pin, folders">Edit</button>`;
    const body = !open ? '' : `<ul class="tree">${locs.filter((l) => l.chats.length || !filter).map((l) => {
      const lkey = p.id + '|' + l.path;
      const lopen = !collapsedLocs.has(lkey);
      const icon = l.kind === 'worktree' ? '⑂' : l.kind === 'repo' ? '⎇' : '▢';
      return `<li class="loc" data-loc="${esc(lkey)}">
        <div class="loc-head">
          <button class="twisty small" data-act="toggle-loc" aria-expanded="${lopen}">${l.chats.length ? (lopen ? '▾' : '▸') : '·'}</button>
          <span class="loc-icon" title="${esc(l.kind)}">${icon}</span>
          <span class="loc-label" title="${esc(l.path)}">${esc(l.label)}</span>
          ${l.branch ? `<span class="chip">${esc(l.branch)}</span>` : ''}
          <span class="muted small">${l.chats.length ? `${l.chats.length} chat${l.chats.length === 1 ? '' : 's'}` : 'no chats yet'}</span>
          ${l.kind === 'worktree' || (!p.paths.includes(l.path) && !p.other) ? `<button class="btn small ghost" data-act="new-claude-here" data-dir="${esc(l.path)}" title="New Claude chat in this folder">+ here</button>` : ''}
        </div>
        ${lopen && l.chats.length ? `<ul class="chats">${l.chats.map((c) => renderChat(c, projects)).join('')}</ul>` : ''}
      </li>`;
    }).join('')}</ul>`;
    return `<section class="proj${open ? ' open' : ''}${p.other ? ' other' : ''}" data-id="${esc(p.id)}" style="--proj:${esc(p.color)}">
      <header class="proj-head" data-drop="${esc(p.id)}">
        <button class="twisty" data-act="toggle" aria-expanded="${open}">${open ? '▾' : '▸'}</button>
        <span class="swatch"></span>
        <button class="proj-name" data-act="toggle">${esc(p.name)}</button>
        ${p.pinned ? '<span class="pin" title="Pinned">★</span>' : ''}
        ${p.branch ? `<span class="chip">${esc(p.branch)}</span>` : ''}
        ${p.live ? `<span class="badge live">${p.live} live</span>` : ''}
        ${rc}
        <span class="muted small">${p.chatCount} chat${p.chatCount === 1 ? '' : 's'}${p.updated ? ' · ' + esc(ago(p.updated)) : ''}${p.paths.length > 1 ? ` · ${p.paths.length} folders` : ''}</span>
        <span class="spacer"></span>
        <span class="proj-actions">${tools}</span>
      </header>
      ${body}
    </section>`;
  }

  function render() {
    if (!data) return;
    $('archived-count').textContent = data.archivedCount ? `(${data.archivedCount})` : '';
    const html = data.projects.map((p) => renderProject(p, data.projects)).join('') ||
      `<div class="empty">
        <p><b>No projects yet.</b></p>
        <p class="muted">Clone a repository or create a folder with <b>New project</b>, or put folders in <code>/workspace</code> from the terminal or the Files page. Chats from Claude and Codex appear here automatically.</p>
      </div>`;
    const el = $('proj-tree');
    if (el.dataset.html === html) return;
    el.innerHTML = html;
    el.dataset.html = html;
  }

  let loading = false;
  async function refresh() {
    if (loading || document.hidden || dragging || $('proj-dialog').open || $('chat-dialog').open) return;
    if (document.activeElement && document.activeElement.matches('#proj-tree select')) return;
    loading = true;
    try {
      data = await api('GET', 'api/projects');
      render();
    } catch (e) {
      $('proj-tree').innerHTML = `<p class="error">Couldn't load projects: ${esc(e.message)}</p>`;
    } finally {
      loading = false;
    }
  }

  // ------------------------------------------------------------ chat transcript
  let viewing = null;
  async function viewChat(key) {
    const c = findChat(key);
    viewing = c;
    $('chat-title').textContent = c ? c.title : 'Chat';
    $('chat-meta').textContent = c ? `${c.tool === 'claude' ? 'Claude Code' : 'Codex'} · ${c.cwd || ''}${c.branch ? ' · ' + c.branch : ''} · started ${new Date(c.started || c.updated).toLocaleString()}` : '';
    $('chat-open').textContent = c && c.session ? 'Attach in terminal' : 'Continue in terminal';
    $('chat-body').innerHTML = '<p class="muted">Loading…</p>';
    $('chat-dialog').showModal();
    try {
      const { items } = await api('GET', `api/chats/${key.replace(':', '/')}`);
      $('chat-body').innerHTML = items.map((m) => `<div class="msg ${m.role}">
          ${m.text ? `<div class="bubble">${esc(m.text)}</div>` : ''}
          ${(m.tools || []).map((t) => `<div class="toolcall">${esc(t)}</div>`).join('')}
        </div>`).join('') || '<p class="muted">No messages.</p>';
      $('chat-body').scrollTop = $('chat-body').scrollHeight;
    } catch (e) {
      $('chat-body').innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  function findChat(key) {
    for (const p of (data ? data.projects : [])) for (const l of p.locations) for (const c of l.chats) if (c.key === key) return c;
    return null;
  }

  async function openChat(key) {
    const c = findChat(key);
    if (c && c.active && !c.session && !confirm('This chat looks active somewhere else right now (written to in the last 90 seconds). Resume a second copy anyway?')) return;
    const { session } = await api('POST', `api/chats/${key.replace(':', '/')}/open`);
    openTerm(session);
  }

  // ------------------------------------------------------------ project dialog
  function setSource(v) {
    $('pf-git-wrap').hidden = v !== 'git';
    $('pf-folder-wrap').hidden = v === 'paths';
    $('pf-paths-wrap').hidden = v !== 'paths';
    $('pf-folder').placeholder = v === 'git' ? 'defaults to the repository name' : 'my-project';
  }

  function openProjectDialog(p) {
    editing = p || null;
    const form = $('proj-form');
    form.reset();
    $('pf-error').hidden = true;
    $('proj-dialog-title').textContent = p ? `Edit ${p.name}` : 'New project';
    $('pf-save').textContent = p ? 'Save' : 'Create';
    $('pf-source-wrap').hidden = !!p;
    $('pf-delete').hidden = !p || p.implicit;
    $('pf-name').value = p ? p.name : '';
    $('pf-pinned').checked = !!(p && p.pinned);
    $('pf-rc-wrap').hidden = !p || !p.paths.length;
    $('pf-rc').value = p && p.rc.enabled ? p.rc.mode : 'off';
    $('pf-rc').querySelector('option[value=worktree]').disabled = !(p && p.repo);
    if (p) {
      $('pf-git-wrap').hidden = true;
      $('pf-folder-wrap').hidden = true;
      $('pf-paths-wrap').hidden = false;
      $('pf-paths').value = p.paths.join('\n');
    } else setSource('folder');
    const current = p ? p.color : COLORS[0];
    $('pf-colors').innerHTML = COLORS.map((c) => `<label class="swatch-pick" style="--c:${c}"><input type="radio" name="color" value="${c}" ${c === current ? 'checked' : ''}><span></span></label>`).join('');
    $('proj-dialog').showModal();
    $('pf-name').focus();
  }

  async function saveProject() {
    const f = $('proj-form');
    const color = (f.querySelector('input[name=color]:checked') || {}).value;
    const paths = $('pf-paths').value.split('\n').map((s) => s.trim()).filter(Boolean);
    $('pf-save').disabled = true;
    try {
      if (editing) {
        const saved = await api('PATCH', `api/projects/${encodeURIComponent(editing.id)}`, { name: $('pf-name').value, color, pinned: $('pf-pinned').checked, paths });
        const rc = $('pf-rc').value;
        const was = editing.rc.enabled ? editing.rc.mode : 'off';
        if (rc !== was) await api('POST', `api/projects/${encodeURIComponent(saved.id)}/remote-control`, { enabled: rc !== 'off', mode: rc === 'off' ? undefined : rc });
        if (editing.id !== saved.id && expanded.has(editing.id)) { expanded.add(saved.id); store.set('roost.expanded', [...expanded]); }
      } else {
        const source = (f.querySelector('input[name=source]:checked') || {}).value;
        const body = { name: $('pf-name').value, color };
        if (source === 'git') { body.gitUrl = $('pf-git').value.trim(); body.folder = $('pf-folder').value.trim() || undefined; $('pf-save').textContent = 'Cloning…'; }
        else if (source === 'folder') body.folder = $('pf-folder').value.trim() || $('pf-name').value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
        else body.paths = paths;
        const p = await api('POST', 'api/projects', body);
        if ($('pf-pinned').checked) await api('PATCH', `api/projects/${encodeURIComponent(p.id)}`, { pinned: true });
        expanded.add(p.id);
        store.set('roost.expanded', [...expanded]);
      }
      $('proj-dialog').close();
      await refresh();
    } catch (e) {
      $('pf-error').textContent = e.message;
      $('pf-error').hidden = false;
    } finally {
      $('pf-save').disabled = false;
      $('pf-save').textContent = editing ? 'Save' : 'Create';
    }
  }

  // ------------------------------------------------------------ events
  const projById = (id) => data && data.projects.find((p) => p.id === id);

  $('proj-tree').addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-act]');
    if (!t || t.tagName === 'SELECT') return;
    const sec = t.closest('.proj');
    const p = sec && projById(sec.dataset.id);
    const li = t.closest('.chat');
    try {
      switch (t.dataset.act) {
        case 'toggle':
          if (expanded.has(p.id)) expanded.delete(p.id); else expanded.add(p.id);
          store.set('roost.expanded', [...expanded]);
          return render();
        case 'toggle-loc': {
          const k = t.closest('.loc').dataset.loc;
          if (collapsedLocs.has(k)) collapsedLocs.delete(k); else collapsedLocs.add(k);
          store.set('roost.collapsedLocs', [...collapsedLocs]);
          return render();
        }
        case 'view': return viewChat(li.dataset.key);
        case 'open': return await openChat(li.dataset.key);
        case 'archive': {
          const c = findChat(li.dataset.key);
          await api('POST', 'api/chats/archive', { chat: li.dataset.key, archived: !c.archived });
          break;
        }
        case 'new-claude':
        case 'new-codex':
        case 'new-claude-here': {
          const tool = t.dataset.act === 'new-codex' ? 'codex' : 'claude';
          const { session } = await api('POST', `api/projects/${encodeURIComponent(p.id)}/new-chat`, { tool, dir: t.dataset.dir });
          openTerm(session);
          break;
        }
        case 'edit': return openProjectDialog(p);
        case 'rc': return openProjectDialog(p);
      }
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  });

  $('proj-tree').addEventListener('change', async (ev) => {
    const sel = ev.target.closest('select[data-act=move]');
    if (!sel || !sel.value) return;
    const key = sel.closest('.chat').dataset.key;
    try {
      await api('POST', 'api/chats/assign', { chat: key, project: sel.value === '__auto' ? null : sel.value });
    } catch (e) { alert(e.message); }
    sel.blur();
    await refresh();
  });

  // Drag a chat onto a project header to file it there.
  $('proj-tree').addEventListener('dragstart', (ev) => {
    const li = ev.target.closest('.chat');
    if (!li) return;
    dragging = li.dataset.key;
    ev.dataTransfer.setData('text/plain', dragging);
    ev.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging');
    document.body.classList.add('is-dragging');
  });
  $('proj-tree').addEventListener('dragend', (ev) => {
    dragging = null;
    ev.target.closest('.chat')?.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  });
  $('proj-tree').addEventListener('dragover', (ev) => {
    const sec = ev.target.closest('.proj');
    if (!dragging || !sec || sec.classList.contains('other')) return;
    ev.preventDefault();
    document.querySelectorAll('.drop-target').forEach((x) => x !== sec && x.classList.remove('drop-target'));
    sec.classList.add('drop-target');
  });
  $('proj-tree').addEventListener('drop', async (ev) => {
    const sec = ev.target.closest('.proj');
    if (!dragging || !sec) return;
    ev.preventDefault();
    const key = dragging;
    dragging = null;
    try { await api('POST', 'api/chats/assign', { chat: key, project: sec.dataset.id }); } catch (e) { alert(e.message); }
    await refresh();
  });

  $('new-project').addEventListener('click', () => openProjectDialog(null));
  $('proj-form').addEventListener('change', (ev) => { if (ev.target.name === 'source') setSource(ev.target.value); });
  $('proj-form').addEventListener('submit', (ev) => {
    if (ev.submitter && ev.submitter.value === 'cancel') return;
    ev.preventDefault();
    saveProject();
  });
  $('pf-delete').addEventListener('click', async () => {
    if (!editing || !confirm(`Remove the "${editing.name}" grouping? Its folders and chats are not touched.`)) return;
    try { await api('DELETE', `api/projects/${encodeURIComponent(editing.id)}`); $('proj-dialog').close(); await refresh(); } catch (e) { alert(e.message); }
  });
  $('chat-close').addEventListener('click', () => $('chat-dialog').close());
  $('chat-open').addEventListener('click', async () => {
    if (!viewing) return;
    try { await openChat(viewing.key); } catch (e) { alert(e.message); }
  });
  $('proj-filter').addEventListener('input', (ev) => { filter = ev.target.value.trim().toLowerCase(); render(); });
  $('show-archived').addEventListener('change', (ev) => { showArchived = ev.target.checked; render(); });
  $('expand-all').addEventListener('click', () => { data.projects.forEach((p) => expanded.add(p.id)); store.set('roost.expanded', [...expanded]); render(); });
  $('collapse-all').addEventListener('click', () => { expanded.clear(); store.set('roost.expanded', []); render(); });

  // ------------------------------------------------------------ tabs
  function showView() {
    const v = location.hash === '#overview' ? 'overview' : 'projects';
    document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== `view-${v}`; });
    document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.view === v));
    if (v === 'projects') refresh();
  }
  window.addEventListener('hashchange', showView);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  showView();
  setInterval(() => { if (!$('view-projects').hidden) refresh(); }, 10000);
})();
