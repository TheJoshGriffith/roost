'use strict';
/* =========================================================================
   roost dashboard: the viewer panel.
   Shows the VNC browser and web servers running in the container (through
   the preview ports, see previews.js) next to everything else. Modes:
     right / bottom   docked beside the main view, drag the divider to resize
     float            a window you can drag by its title bar and resize from the corner
     max              fills the window under the app bar (always used on phones)
   Each tab keeps its iframe alive while you switch between tabs.
   Needs ui.js (h, icon, openMenu, openSheet) and, at call time, api() and toast() from app.js.
   ========================================================================= */

Object.assign(ICONS, {
  panelRight: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M15 3v18'],
  panelBottom: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M3 15h18'],
  float: ['M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4', 'M14 12h6a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-6a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z'],
  maximize: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
});

const Viewer = (() => {
  const KEY = 'roost.viewer';
  const VNC_URL = 'vnc/vnc.html?path=vnc/websockify&autoconnect=true&resize=scale&reconnect=true';
  const MODES = [
    { v: 'right', icon: 'panelRight', label: 'Dock right' },
    { v: 'bottom', icon: 'panelBottom', label: 'Dock bottom' },
    { v: 'float', icon: 'float', label: 'Float' },
    { v: 'max', icon: 'maximize', label: 'Fill the window' },
  ];
  const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
  const st = { open: false, mode: 'right', tabs: [], active: null, right: 0.45, bottom: 0.45, float: null, ...saved };
  st.tabs = (st.tabs || []).filter((t) => t && (t.kind === 'vnc' || (t.kind === 'preview' && t.port)));
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} };

  const el = $('#viewer');
  const split = $('#viewer-split');
  const row = $('#shell-row');
  const btn = $('#viewer-btn');
  const phone = matchMedia('(max-width: 639px)');
  const frames = new Map(); // tab id -> iframe
  const mode = () => (phone.matches ? 'max' : st.mode);
  const tabById = (id) => st.tabs.find((t) => t.id === id) || null;
  const activeTab = () => tabById(st.active) || null;
  // Preview listeners speak plain http; the host is whatever this page was opened with.
  const urlOf = (t) => (t.kind === 'vnc' ? VNC_URL : `http://${location.hostname}:${t.slot}/`);
  const shortName = (cwd) => (cwd ? cwd.replace(/\/+$/, '').split('/').pop() : '');
  const relWs = (cwd) => (cwd ? cwd.replace(/^\/workspace\/?/, '') || '/workspace' : '');

  // ---------------------------------------------------------------- render
  function render() {
    const m = mode();
    document.body.dataset.viewer = st.open ? m : 'off';
    el.hidden = !st.open;
    split.hidden = !st.open || (m !== 'right' && m !== 'bottom');
    btn.setAttribute('aria-pressed', String(st.open));
    applyGeometry();
    if (!st.open) return;

    const t = activeTab();
    const tabs = h('div', { class: 'vw-tabs', role: 'tablist', 'aria-label': 'Viewer tabs' },
      st.tabs.map((x) => h('div', { class: 'vw-tab', 'aria-selected': String(x.id === st.active), title: tabTitle(x) },
        h('button', { type: 'button', class: 'vw-tab-btn', role: 'tab', 'aria-selected': String(x.id === st.active), onclick: () => activate(x.id) },
          icon(x.kind === 'vnc' ? 'monitor' : 'globe', 14), h('span', null, x.kind === 'vnc' ? 'Browser' : x.label || `:${x.port}`)),
        h('button', { type: 'button', class: 'vw-tab-x', 'aria-label': 'Close tab', title: 'Close tab', onclick: () => closeTab(x.id) }, icon('x', 13)))),
      h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Open something', title: 'Open the browser or a web server', onclick: (e) => pick(e.currentTarget) }, icon('plus', 16)));
    const modeBtns = phone.matches ? [] : MODES.map((x) => h('button', {
      type: 'button', class: 'icon-btn sm vw-mode', 'aria-pressed': String(st.mode === x.v), 'aria-label': x.label, title: x.label,
      onclick: () => setMode(x.v),
    }, icon(x.icon, 16)));
    const actions = h('div', { class: 'vw-actions' },
      t ? h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Reload', title: 'Reload', onclick: () => reload(t) }, icon('refresh', 15)) : null,
      t ? h('a', { class: 'icon-btn sm', href: urlOf(t), target: '_blank', rel: 'noopener', 'aria-label': 'Open in a new tab', title: 'Open in a new tab' }, icon('external', 15)) : null,
      modeBtns.length ? h('span', { class: 'vw-sep', 'aria-hidden': 'true' }) : null,
      modeBtns,
      h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Hide viewer', title: 'Hide (tabs are kept)', onclick: () => toggle(false) }, icon('x', 17)));
    // The head, body and grip are created once and never moved: moving an iframe
    // in the DOM reloads it, and the app inside would lose its state.
    if (!el.firstChild) el.append(h('div', { class: 'vw-head' }), h('div', { class: 'vw-body' }), h('div', { class: 'vw-grip', 'aria-hidden': 'true' }));
    const body = el.querySelector('.vw-body');
    el.querySelector('.vw-head').replaceChildren(tabs, actions);
    el.querySelector('.vw-grip').hidden = m !== 'float';
    // Keep live iframes; drop the ones whose tab is gone.
    for (const [id, f] of frames) if (!tabById(id)) { f.remove(); frames.delete(id); }
    body.querySelector('.vw-empty')?.remove();
    body.querySelector('.vw-note')?.remove();
    if (t) {
      let f = frames.get(t.id);
      if (!f) {
        f = h('iframe', { class: 'vw-frame', src: urlOf(t), title: tabTitle(t), allow: 'clipboard-read; clipboard-write; fullscreen; screen-wake-lock' });
        frames.set(t.id, f);
        body.append(f);
      }
      if (t.kind === 'preview' && location.protocol === 'https:') {
        body.prepend(h('div', { class: 'vw-note' }, icon('info', 14), h('span', null, 'Previews are plain http on their own port, and browsers don’t show http inside an https page. Use ', icon('external', 12), ' to open it in a tab.')));
      }
    } else {
      body.append(h('div', { class: 'vw-empty pane-empty' }, h('div', null,
        h('div', { class: 'art' }, icon('panelRight', 26)),
        h('h2', null, 'Nothing open'),
        h('p', null, 'Show the browser the agents drive, or a web server running in roost.'),
        h('div', { style: 'display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap' },
          h('button', { type: 'button', class: 'btn small', onclick: openVnc }, icon('monitor', 15), 'Browser'),
          h('button', { type: 'button', class: 'btn small primary', onclick: (e) => pick(e.currentTarget) }, icon('globe', 15), 'Web server…')))));
    }
    for (const [id, f] of frames) f.hidden = id !== st.active;
  }

  function tabTitle(t) {
    if (t.kind === 'vnc') return 'Browser (VNC): the Chromium the agents drive';
    return `${t.cwd ? relWs(t.cwd) + ' · ' : ''}localhost:${t.port}, shown on port ${t.slot}`;
  }

  function applyGeometry() {
    const m = mode();
    el.style.cssText = '';
    if (!st.open) return;
    if (m === 'right') el.style.flexBasis = (st.right * 100).toFixed(2) + '%';
    if (m === 'bottom') el.style.flexBasis = (st.bottom * 100).toFixed(2) + '%';
    if (m === 'float') {
      const f = clampFloat(st.float || defaultFloat());
      st.float = f;
      Object.assign(el.style, { left: f.x + 'px', top: f.y + 'px', width: f.w + 'px', height: f.h + 'px' });
    }
  }
  function defaultFloat() {
    const w = Math.min(760, Math.round(innerWidth * 0.55)), hh = Math.min(520, Math.round(innerHeight * 0.6));
    return { x: innerWidth - w - 24, y: innerHeight - hh - 24, w, h: hh };
  }
  function clampFloat(f) {
    const w = Math.max(320, Math.min(f.w, innerWidth - 16));
    const hh = Math.max(220, Math.min(f.h, innerHeight - 16));
    return { w, h: hh, x: Math.max(8 - w + 120, Math.min(f.x, innerWidth - 120)), y: Math.max(0, Math.min(f.y, innerHeight - 40)) };
  }

  // ---------------------------------------------------------------- actions
  function toggle(open) {
    st.open = open === undefined ? !st.open : !!open;
    save();
    render();
  }
  function setMode(m) {
    st.mode = m;
    save();
    render();
  }
  function activate(id) {
    st.active = id;
    st.open = true;
    save();
    render();
    const t = activeTab();
    if (t && t.kind === 'preview') ensureSlot(t);
  }
  function closeTab(id) {
    const i = st.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    st.tabs.splice(i, 1);
    if (st.active === id) st.active = (st.tabs[i] || st.tabs[i - 1] || {}).id || null;
    save();
    render();
  }
  function reload(t) {
    const f = frames.get(t.id);
    if (!f) return;
    // The VNC page is same-origin; a preview is another origin, so it can only be pointed back at its start.
    if (t.kind === 'vnc') f.contentWindow.location.reload();
    else f.src = urlOf(t);
  }
  function addTab(t) {
    const cur = tabById(t.id);
    if (cur) Object.assign(cur, t); else st.tabs.push(t);
    activate(t.id);
  }
  function openVnc() { addTab({ id: 'vnc', kind: 'vnc' }); }

  // Map a port onto a preview slot (or confirm its slot), then show it.
  async function openPort(port, info = {}) {
    try {
      const r = await api('POST', 'api/previews', { port });
      addTab({ id: 'p' + port, kind: 'preview', port, slot: r.slot, label: info.label || shortName(info.cwd) || `:${port}`, cwd: info.cwd || null });
    } catch (e) { toast(e.message); }
  }
  // Another browser may have moved this port to a different slot since; follow it.
  async function ensureSlot(t) {
    try {
      const r = await api('POST', 'api/previews', { port: t.port });
      if (r.slot !== t.slot) {
        t.slot = r.slot;
        save();
        const f = frames.get(t.id);
        if (f) f.src = urlOf(t);
        render();
      }
    } catch {}
  }

  function askPort() {
    const input = h('input', { class: 'input', type: 'number', min: '1', max: '65535', inputmode: 'numeric', placeholder: '3000', 'aria-label': 'Port' });
    const go = () => {
      const port = Number(input.value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) { input.focus(); return; }
      $('#sheet').close();
      openPort(port);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    openSheet({
      title: 'Show a port',
      body: h('div', { class: 'form' },
        h('p', { class: 'muted', style: 'margin:0' }, 'The port your server listens on inside roost (localhost or 0.0.0.0). It doesn’t have to be running yet; the preview retries until it answers.'),
        input),
      foot: [h('button', { type: 'button', class: 'btn', onclick: () => $('#sheet').close() }, 'Cancel'), h('button', { type: 'button', class: 'btn primary', onclick: go }, 'Show')],
    });
    setTimeout(() => input.focus(), 50);
  }

  // The "what do you want to see" menu. With a project, its own servers come first.
  async function pick(anchor, project) {
    let data = { enabled: false, listening: [] };
    try { data = await api('GET', 'api/previews'); } catch (e) { toast(e.message); }
    const paths = project ? project.paths || [] : [];
    const inProject = (r) => r.cwd && paths.some((p) => r.cwd === p || r.cwd.startsWith(p.replace(/\/+$/, '') + '/'));
    const mine = data.listening.filter(inProject);
    const rows = project && mine.length ? mine : data.listening;
    const item = (r) => ({
      label: `${shortName(r.cwd) || r.comm || 'port'} · :${r.port}`,
      icon: 'globe',
      onClick: () => openPort(r.port, { cwd: r.cwd }),
    });
    const items = [{ label: 'Browser (VNC)', icon: 'monitor', onClick: openVnc }, 'sep'];
    if (!data.enabled) items.push({ title: 'Web previews are off (ROOST_PREVIEW_PORTS)' });
    else {
      items.push({ title: project && mine.length ? `Running in ${project.name}` : 'Running in roost' });
      if (rows.length) items.push(...rows.map(item));
      else items.push({ title: 'No servers listening right now' });
      items.push({ label: 'Another port…', icon: 'plus', onClick: askPort });
    }
    openMenu(anchor, items, 'Show in viewer');
  }

  // ---------------------------------------------------------------- dragging
  // Iframes swallow pointer events, so they're switched off while dragging.
  function drag(e, target, onMove) {
    e.preventDefault();
    target.setPointerCapture(e.pointerId);
    document.body.classList.add('vw-dragging');
    const move = (ev) => onMove(ev);
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      document.body.classList.remove('vw-dragging');
      save();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  split.addEventListener('pointerdown', (e) => {
    drag(e, split, (ev) => {
      const r = row.getBoundingClientRect();
      const frac = mode() === 'right' ? (r.right - ev.clientX) / r.width : (r.bottom - ev.clientY) / r.height;
      st[mode()] = Math.max(0.2, Math.min(0.85, frac));
      applyGeometry();
    });
  });
  split.addEventListener('dblclick', () => { st[mode()] = 0.45; save(); applyGeometry(); });

  el.addEventListener('pointerdown', (e) => {
    if (mode() !== 'float' || e.button !== 0) return;
    const grip = e.target.closest('.vw-grip');
    const head = e.target.closest('.vw-head');
    if (!grip && (!head || e.target.closest('button, a'))) return;
    const start = { x: e.clientX, y: e.clientY, f: { ...st.float } };
    drag(e, grip || head, (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      st.float = clampFloat(grip
        ? { ...start.f, w: start.f.w + dx, h: start.f.h + dy }
        : { ...start.f, x: start.f.x + dx, y: start.f.y + dy });
      applyGeometry();
    });
  });
  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('.vw-head') && !e.target.closest('button, a')) setMode(st.mode === 'max' ? 'right' : 'max');
  });

  addEventListener('resize', () => { if (st.open && mode() === 'float') applyGeometry(); });
  phone.addEventListener('change', render);
  btn.append(icon('panelRight', 19));
  btn.addEventListener('click', () => {
    if (!st.open && !st.tabs.length) { toggle(true); return; }
    toggle();
  });

  render();
  { const t = activeTab(); if (st.open && t && t.kind === 'preview') ensureSlot(t); }

  return { toggle, pick, openVnc, openPort, isOpen: () => st.open };
})();
