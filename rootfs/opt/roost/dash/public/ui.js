'use strict';
/* =========================================================================
   roost dashboard UI: helpers, renderers, chat reducer and views.
   Ported from design/roost-ui-prototype.html (sections 1-9). app.js wires
   these to the real backend.
   ------------------------------------------------------------------------
   1. helpers (h, icon, formatting)
   2. markdown + syntax highlighting        renderMarkdown, renderCodeBlock, highlight
   3. diffs                                 renderDiff, renderPatch, renderUnifiedDiff
   4. chat state reducer                    createChatState, applyEvent
   5. chat renderers                        renderMessage, renderToolCard, renderPermission
   6. chat view (header, stream, composer)  createChatView
   7. projects view                         renderProjectTree
   8. overview                              renderOverview
   9. sheets + menus                        openSheet, openMenu, project form
   (10. app shell, router and backend: see app.js)
   Nothing here ever assigns model or server text to innerHTML: every string
   reaches the DOM through textContent / createTextNode.
   ========================================================================= */

/* ======================================================= 1. helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  return append(el, kids);
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false || k === '') continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const ICONS = {
  terminal: ['m4 17 6-5-6-5', 'M12 19h8'],
  pencil: ['M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z'],
  filePlus: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M12 18v-6', 'M9 15h6'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M8 13h8', 'M8 17h5'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'm21 21-4.3-4.3'],
  folder: ['M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z'],
  folderOpen: ['m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'],
  list: ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'],
  globe: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20', 'M2 12h20'],
  bot: ['M12 8V4H8', 'M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z', 'M2 14h2', 'M20 14h2', 'M15 13v2', 'M9 13v2'],
  plug: ['M12 22v-5', 'M9 8V2', 'M15 8V2', 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z'],
  shield: ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  chevronRight: ['m9 18 6-6-6-6'],
  chevronDown: ['m6 9 6 6 6-6'],
  chevronLeft: ['m15 18-6-6 6-6'],
  copy: ['M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  arrowUp: ['M12 19V5', 'm5 12 7-7 7 7'],
  arrowDown: ['M12 5v14', 'm19 12-7 7-7-7'],
  arrowLeft: ['M19 12H5', 'm12 19-7-7 7-7'],
  stop: ['M7 7h10v10H7z'],
  paperclip: ['m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48'],
  plus: ['M12 5v14', 'M5 12h14'],
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  spark: ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'm5.6 5.6 2.8 2.8', 'm15.6 15.6 2.8 2.8', 'm5.6 18.4 2.8-2.8', 'm15.6 8.4 2.8-2.8'],
  alert: ['M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
  branch: ['M6 3v12', 'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 9a9 9 0 0 1-9 9'],
  repo: ['M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20'],
  fork: ['M12 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9', 'M12 12v3'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4', 'M12 8h.01'],
  refresh: ['M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5', 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5'],
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41', 'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  contrast: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 18a6 6 0 0 0 0-12v12z'],
  message: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  grid: ['M4 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M15 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M15 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z', 'M4 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  star: ['M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z'],
  pr: ['M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 9v12', 'M13 6h3a2 2 0 0 1 2 2v7'],
  code: ['m16 18 6-6-6-6', 'm8 6-6 6 6 6'],
  monitor: ['M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M8 21h8', 'M12 17v4'],
  key: ['m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4', 'm21 2-9.6 9.6', 'M7.5 22a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z'],
  server: ['M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z', 'M6 6h.01', 'M6 18h.01'],
  archive: ['M3 3h18v5H3z', 'M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8', 'M10 12h4'],
  move: ['M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-1', 'M2 13h10', 'm9 16 3-3-3-3'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  expand: ['m7 15 5 5 5-5', 'm7 9 5-5 5 5'],
  collapse: ['m7 20 5-5 5 5', 'm7 4 5 5 5-5'],
  cloud: ['M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
};
const ICON_FILL = new Set(['stop']);
const ICON_WIDTH = { more: 3 };
function icon(name, size = 16, cls = '') {
  const s = document.createElementNS(SVGNS, 'svg');
  const attrs = { viewBox: '0 0 24 24', width: size, height: size, fill: ICON_FILL.has(name) ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': ICON_WIDTH[name] || 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: ('i ' + cls).trim() };
  for (const k in attrs) s.setAttribute(k, attrs[k]);
  for (const d of ICONS[name] || []) { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}
function spinner(size = 14) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('class', 'i spin'); s.setAttribute('aria-hidden', 'true');
  const c = document.createElementNS(SVGNS, 'circle');
  c.setAttribute('cx', 12); c.setAttribute('cy', 12); c.setAttribute('r', 9); c.setAttribute('fill', 'none');
  c.setAttribute('stroke', 'currentColor'); c.setAttribute('stroke-width', 2.5); c.setAttribute('opacity', '.2');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', 'M21 12a9 9 0 0 0-9-9'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', 2.5); p.setAttribute('stroke-linecap', 'round');
  s.append(c, p);
  return s;
}
const toolBadge = (tool, size = '') => h('span', { class: `tool ${tool === 'codex' ? 'codex' : 'claude'} ${size}`.trim(), title: tool === 'codex' ? 'Codex' : 'Claude Code', 'aria-label': tool === 'codex' ? 'Codex' : 'Claude Code' }, tool === 'codex' ? 'X' : 'C');

function fmtDur(ms) {
  if (ms == null || isNaN(ms)) return '';
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  const t = Math.floor(s);
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60), r = t % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtTokens(n) {
  if (n == null) return '';
  if (n < 1000) return String(n);
  if (n < 100000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1e6) return Math.round(n / 1000) + 'k';
  return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}
const fmtCost = (usd) => usd == null ? '' : '$' + (usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2));
function ago(t) {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - (typeof t === 'number' ? t : Date.parse(t))) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  return new Date(t).toLocaleDateString();
}
const plural = (n, w, p = w + 's') => `${n} ${n === 1 ? w : p}`;
const basename = (p) => String(p || '').replace(/\/+$/, '').split('/').pop();
function relPath(p, cwd) {
  p = String(p || '');
  if (cwd && p.startsWith(cwd.replace(/\/+$/, '') + '/')) return p.slice(cwd.replace(/\/+$/, '').length + 1);
  return p.replace(/^\/workspace\//, '');
}
function hostOf(u) { try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname); } catch { return String(u || ''); } }
const safeColor = (c) => /^#[0-9a-f]{3,8}$/i.test(String(c)) ? c : '#8a919c';
const LANG_BY_EXT = { js: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', jsx: 'js', json: 'json', sh: 'sh', bash: 'sh', zsh: 'sh', py: 'py', yml: 'yaml', yaml: 'yaml', css: 'css', html: 'html', md: 'md', conf: 'sh', toml: 'yaml' };
function langFromPath(p) {
  const b = basename(p).toLowerCase();
  if (b === 'dockerfile' || b.startsWith('dockerfile.')) return 'docker';
  const ext = b.includes('.') ? b.split('.').pop() : '';
  return LANG_BY_EXT[ext] || '';
}
function splitLines(s) {
  if (s == null || s === '') return [];
  const a = String(s).replace(/\r\n?/g, '\n').split('\n');
  if (a.length > 1 && a[a.length - 1] === '') a.pop();
  return a;
}
async function copyText(t) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(t); return true; } } catch {}
  // roost is usually served over plain http on the LAN, where navigator.clipboard is unavailable.
  const ta = h('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;opacity:0' });
  ta.value = t; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}
function copyButton(getText, label = 'Copy', aria = 'Copy') {
  const b = h('button', { type: 'button', class: 'copy-btn', 'aria-label': aria });
  const reset = () => { b.replaceChildren(icon('copy', 14), h('span', null, label)); b.classList.remove('done'); };
  reset();
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await copyText(getText());
    b.replaceChildren(icon(ok ? 'check' : 'x', 14), h('span', null, ok ? 'Copied' : 'Failed'));
    b.classList.toggle('done', ok);
    clearTimeout(b._t); b._t = setTimeout(reset, 1600);
  });
  return b;
}

/* ======================================================= 2. markdown + highlighting */
// A deliberately small markdown renderer. It never builds HTML strings: every piece of
// text becomes a text node, links are restricted to http(s)/mailto/relative URLs.
// Supports headings, paragraphs (single newlines become <br>), lists (nested, ordered,
// task lists), fenced code (unterminated fences render as open code: fine for streaming),
// blockquotes, tables, hr, and inline code/bold/italic/strike/links/autolinks.
const MD_BLOCK_START = /^\s{0,3}(?:#{1,6}\s|>|```|~~~|[-*+]\s|\d{1,9}[.)]\s)/;
const leadIndent = (l) => l.replace(/\t/g, '    ').search(/\S|$/);
function listItem(line) {
  const m = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/.exec(line);
  if (!m) return null;
  return { indent: m[1].replace(/\t/g, '    ').length, ordered: !!m[3], num: m[3] ? +m[3] : 1, text: m[4] };
}
function isHr(line) { return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line); }
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = []; let cur = '', tick = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') tick = !tick;
    if (c === '|' && !tick) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}
function isTableStart(lines, i, end) {
  if (i + 1 >= end || !lines[i].includes('|') || !lines[i + 1].includes('-')) return false;
  const cells = splitRow(lines[i + 1]);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c)) && (lines[i + 1].includes('|') || cells.length > 1);
}
function renderMarkdown(src, opts = {}) {
  const root = h('div', { class: 'md' });
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  mdBlocks(lines, 0, lines.length, root);
  if (opts.streaming) placeCaret(root);
  return root;
}
function mdBlocks(lines, start, end, parent) {
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/.exec(line))) {
      const fence = m[2], indent = m[1].length, buf = [];
      const close = new RegExp('^\\s{0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}\\s*$');
      i++;
      while (i < end && !close.test(lines[i])) { buf.push(lines[i].slice(Math.min(indent, leadIndent(lines[i])))); i++; }
      const closed = i < end;
      if (closed) i++;
      parent.append(renderCodeBlock(buf.join('\n'), m[3], { open: !closed }));
      continue;
    }
    if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      parent.append(h('h' + Math.min(6, m[1].length + 2), null, renderInline(m[2])));
      i++; continue;
    }
    if (isHr(line)) { parent.append(h('hr')); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const buf = [];
      while (i < end && /^\s{0,3}>/.test(lines[i])) { buf.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i++; }
      const bq = h('blockquote');
      mdBlocks(buf, 0, buf.length, bq);
      parent.append(bq);
      continue;
    }
    if (isTableStart(lines, i, end)) { i = mdTable(lines, i, end, parent); continue; }
    if (listItem(line)) { i = mdList(lines, i, end, parent); continue; }
    const buf = [line.trim()];
    i++;
    while (i < end && lines[i].trim() && !MD_BLOCK_START.test(lines[i]) && !isHr(lines[i]) && !isTableStart(lines, i, end)) { buf.push(lines[i].trim()); i++; }
    const p = h('p');
    buf.forEach((l, k) => { if (k) p.append(h('br')); append(p, renderInline(l)); });
    parent.append(p);
  }
}
function mdList(lines, i, end, parent) {
  const first = listItem(lines[i]);
  const indent = first.indent;
  const list = h(first.ordered ? 'ol' : 'ul');
  if (first.ordered && first.num !== 1) list.setAttribute('start', String(first.num));
  while (i < end) {
    const it = listItem(lines[i]);
    if (!it || it.indent !== indent || it.ordered !== first.ordered) break;
    const li = h('li');
    let text = it.text;
    const task = /^\[([ xX])\]\s+/.exec(text);
    if (task) {
      li.className = 'task';
      const done = task[1] !== ' ';
      li.append(h('span', { class: 'task-box' + (done ? ' done' : ''), 'aria-hidden': 'true' }, done ? icon('check', 10) : null));
      li.append(h('span', { class: 'sr-only' }, done ? 'Done: ' : 'To do: '));
      text = text.slice(task[0].length);
    }
    append(li, renderInline(text));
    i++;
    const sub = [];
    let j = i;
    while (j < end) {
      const l = lines[j];
      if (!l.trim()) { sub.push(''); j++; continue; }
      if (leadIndent(l) > indent) { sub.push(l); j++; continue; }
      break;
    }
    while (sub.length && !sub[sub.length - 1].trim()) sub.pop();
    if (sub.length) {
      const min = Math.min(...sub.filter((s) => s.trim()).map(leadIndent));
      const ded = sub.map((s) => s.replace(/\t/g, '    ').slice(Math.min(min, leadIndent(s))));
      mdBlocks(ded, 0, ded.length, li);
    }
    list.append(li);
    i = j;
  }
  parent.append(list);
  return i;
}
function mdTable(lines, i, end, parent) {
  const head = splitRow(lines[i]);
  const aligns = splitRow(lines[i + 1]).map((c) => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null);
  i += 2;
  const rows = [];
  while (i < end && lines[i].trim() && lines[i].includes('|')) { rows.push(splitRow(lines[i])); i++; }
  const cell = (tag, text, k) => h(tag, aligns[k] ? { style: 'text-align:' + aligns[k] } : null, renderInline(text || ''));
  const table = h('table', null,
    h('thead', null, h('tr', null, head.map((c, k) => cell('th', c, k)))),
    h('tbody', null, rows.map((r) => h('tr', null, head.map((_, k) => cell('td', r[k], k))))));
  parent.append(h('div', { class: 'md-table', tabindex: '0' }, table));
  return i;
}
function safeUrl(u) {
  const s = String(u || '').trim();
  if (/^(https?:|mailto:)/i.test(s)) return s;
  if (/^(#|\/(?!\/)|\.\.?\/)/.test(s)) return s;
  return null;
}
function mdLink(url, kids) {
  const href = safeUrl(url);
  return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, kids) : h('span', null, kids);
}
function findClose(s, from, mark) {
  let k = from;
  while ((k = s.indexOf(mark, k)) !== -1) {
    const prev = s[k - 1], next = s[k + mark.length];
    const okPrev = prev && !/\s/.test(prev);
    const okSingle = !(mark.length === 1 && (next === mark || prev === mark));
    const okUnder = !(mark[0] === '_' && next && /\w/.test(next));
    if (okPrev && okSingle && okUnder) return k;
    k += mark.length;
  }
  return -1;
}
function renderInline(s) {
  s = String(s ?? '');
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(document.createTextNode(buf)); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === '`') {
      let j = i; while (s[j] === '`') j++;
      const ticks = s.slice(i, j);
      const endAt = s.indexOf(ticks, j);
      if (endAt > -1) { flush(); out.push(h('code', { class: 'ic' }, s.slice(j, endAt).replace(/^ (.+) $/, '$1'))); i = endAt + ticks.length; continue; }
      buf += ticks; i = j; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      const dbl = s[i + 1] === c;
      if (c === '~' && !dbl) { buf += c; i++; continue; }
      if (c === '_' && i > 0 && /\w/.test(s[i - 1])) { buf += c; i++; continue; }
      const mark = dbl ? c + c : c;
      const after = s[i + mark.length];
      const close = after && !/\s/.test(after) ? findClose(s, i + mark.length, mark) : -1;
      if (close > i + mark.length) {
        flush();
        out.push(h(c === '~' ? 'del' : dbl ? 'strong' : 'em', null, renderInline(s.slice(i + mark.length, close))));
        i = close + mark.length; continue;
      }
      buf += mark; i += mark.length; continue;
    }
    if (c === '[') {
      const m = /^\[((?:[^\][]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(s.slice(i));
      if (m) { flush(); out.push(mdLink(m[2], renderInline(m[1]))); i += m[0].length; continue; }
    }
    if (c === '<') {
      const m = /^<(https?:\/\/[^>\s]+)>/.exec(s.slice(i));
      if (m) { flush(); out.push(mdLink(m[1], [m[1]])); i += m[0].length; continue; }
    }
    if (c === 'h' && (i === 0 || /[\s(]/.test(s[i - 1])) && /^https?:\/\//.test(s.slice(i, i + 8))) {
      const m = /^https?:\/\/[^\s<>]+/.exec(s.slice(i));
      const url = m[0].replace(/[.,;:!?)\]'"]+$/, '');
      flush(); out.push(mdLink(url, [url])); i += url.length; continue;
    }
    buf += c; i++;
  }
  flush();
  return out;
}
// Put the streaming caret at the end of the deepest last block.
function placeCaret(root) {
  const BLOCKS = new Set(['P', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'DIV', 'PRE', 'CODE']);
  let el = root;
  for (;;) {
    const c = el.lastElementChild;
    if (c && BLOCKS.has(c.tagName) && el.lastChild === c && !c.classList.contains('cb-head')) el = c; else break;
  }
  el.append(h('span', { class: 'caret', 'aria-hidden': 'true' }));
}
function renderCodeBlock(code, lang, opts = {}) {
  return h('div', { class: 'cb' + (opts.open ? ' is-open' : '') },
    h('div', { class: 'cb-head' }, h('span', { class: 'cb-lang' }, lang || 'text'), copyButton(() => code, 'Copy', 'Copy code')),
    h('pre', { tabindex: '0' }, h('code', null, highlight(code, lang))));
}

// Tiny regex highlighter: comments, strings, numbers, keywords (+ YAML keys).
const highlight = (() => {
  const kw = (list) => '\\b(?:' + list.split(' ').join('|') + ')\\b';
  const DQ = String.raw`"(?:\\.|[^"\\\n])*"`, SQ = String.raw`'(?:\\.|[^'\\\n])*'`, BT = '`(?:\\\\.|[^`\\\\])*`';
  const NUM = String.raw`\b(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b`;
  const HASH = String.raw`(?:^|(?<=\s))#[^\n]*`;
  const LANGS = {
    js: { com: String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`, str: [DQ, SQ, BT].join('|'), kw: kw('const let var function return if else for while do break continue switch case default new delete typeof instanceof in of class extends super this null undefined true false async await try catch finally throw import export from as yield void') },
    json: { str: DQ, kw: kw('true false null') },
    sh: { com: HASH, str: [DQ, SQ].join('|'), kw: kw('if then else elif fi for in do done case esac while until function return export local sudo cd echo exit set tmux git npm npx node docker') },
    py: { com: HASH, str: [DQ, SQ].join('|'), kw: kw('def return if elif else for while in not and or is None True False import from as class with try except finally raise lambda yield pass break continue async await') },
    yaml: { com: HASH, str: [DQ, SQ].join('|'), key: String.raw`(?<=^[ \t]*(?:- )?)[\w.\-]+(?=:)`, kw: kw('true false null yes no on off') },
    css: { com: String.raw`\/\*[\s\S]*?\*\/`, str: [DQ, SQ].join('|'), key: String.raw`[\w-]+(?=\s*:[^:{}]*;)`, kw: kw('@media @supports !important') },
    docker: { com: String.raw`^\s*#[^\n]*`, str: [DQ, SQ].join('|'), kw: kw('FROM RUN COPY ADD ENV ARG WORKDIR USER EXPOSE ENTRYPOINT CMD LABEL VOLUME HEALTHCHECK SHELL AS') },
  };
  const ALIAS = { javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js', cjs: 'js', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', python: 'py', yml: 'yaml', dockerfile: 'docker', jsonc: 'json', scss: 'css' };
  const cache = {};
  function compile(l) {
    if (cache[l]) return cache[l];
    const d = LANGS[l], parts = [], kinds = [];
    for (const k of ['com', 'str', 'key', 'kw', 'num']) {
      const src = k === 'num' ? NUM : d[k];
      if (!src) continue;
      parts.push('(' + src + ')'); kinds.push(k);
    }
    return (cache[l] = { re: new RegExp(parts.join('|'), 'gm'), kinds });
  }
  return function highlight(code, lang) {
    const frag = document.createDocumentFragment();
    code = String(code ?? '');
    let l = String(lang || '').toLowerCase();
    l = ALIAS[l] || l;
    if (l === 'diff' || l === 'patch') {
      splitLines(code).forEach((line, k) => {
        if (k) frag.append('\n');
        const cls = line.startsWith('+') ? 'tok-add' : line.startsWith('-') ? 'tok-del' : line.startsWith('@@') ? 'tok-hunk' : null;
        frag.append(cls ? h('span', { class: cls }, line) : line);
      });
      return frag;
    }
    if (!LANGS[l] || code.length > 40000) { frag.append(code); return frag; }
    const { re, kinds } = compile(l);
    re.lastIndex = 0;
    let last = 0, m;
    while ((m = re.exec(code))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      if (m.index > last) frag.append(code.slice(last, m.index));
      let gi = 1; while (gi < m.length && m[gi] === undefined) gi++;
      frag.append(h('span', { class: 'tok-' + kinds[gi - 1] }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < code.length) frag.append(code.slice(last));
    return frag;
  };
})();

/* ======================================================= 3. diffs */
// Line diff (LCS over the changed middle), shaped as {t:' '|'-'|'+'|'gap', a, b, text}.
function diffLines(oldStr, newStr) {
  const A = splitLines(oldStr), B = splitLines(newStr);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf), b = B.slice(pre, B.length - suf);
  const mid = [];
  const n = a.length, m = b.length;
  if (n * m > 4e6) {
    a.forEach((t) => mid.push({ t: '-', text: t }));
    b.forEach((t) => mid.push({ t: '+', text: t }));
  } else {
    const W = m + 1, L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { mid.push({ t: ' ', text: a[i] }); i++; j++; }
      else if (j >= m || (i < n && L[(i + 1) * W + j] >= L[i * W + j + 1])) { mid.push({ t: '-', text: a[i] }); i++; }
      else { mid.push({ t: '+', text: b[j] }); j++; }
    }
  }
  return [...A.slice(0, pre).map((t) => ({ t: ' ', text: t })), ...mid, ...A.slice(A.length - suf).map((t) => ({ t: ' ', text: t }))];
}
function numberOps(ops, oldStart = 1, newStart = 1) {
  let a = oldStart, b = newStart;
  for (const o of ops) {
    if (o.t === ' ') { o.a = a++; o.b = b++; }
    else if (o.t === '-') o.a = a++;
    else if (o.t === '+') o.b = b++;
  }
  return ops;
}
// Keep `context` unchanged lines around each change; collapse the rest into gap rows.
function hunkify(ops, context = 3) {
  const n = ops.length, keep = new Array(n).fill(false);
  ops.forEach((o, i) => { if (o.t === '+' || o.t === '-') for (let k = Math.max(0, i - context); k <= Math.min(n - 1, i + context); k++) keep[k] = true; });
  const out = [];
  for (let i = 0; i < n;) {
    if (keep[i]) { out.push(ops[i]); i++; continue; }
    let j = i; while (j < n && !keep[j]) j++;
    out.push({ t: 'gap', text: plural(j - i, 'unchanged line') });
    i = j;
  }
  return out;
}
// Claude's structuredPatch: [{oldStart, oldLines, newStart, newLines, lines: [" ctx", "-old", "+new"]}]
function opsFromPatch(hunks) {
  const ops = [];
  let prevOldEnd = null;
  for (const hk of hunks || []) {
    if (prevOldEnd != null && hk.oldStart > prevOldEnd) ops.push({ t: 'gap', text: plural(hk.oldStart - prevOldEnd, 'unchanged line') });
    let a = hk.oldStart, b = hk.newStart;
    for (const l of hk.lines || []) {
      const c = l[0], text = l.slice(1);
      if (c === '\\') continue;
      if (c === '+') ops.push({ t: '+', b: b++, text });
      else if (c === '-') ops.push({ t: '-', a: a++, text });
      else ops.push({ t: ' ', a: a++, b: b++, text });
    }
    prevOldEnd = hk.oldStart + (hk.oldLines ?? 0);
  }
  return ops;
}
// Unified diff text (Codex) -> structuredPatch-like hunks.
function parseUnifiedDiff(text) {
  const hunks = [];
  let cur = null, remOld = 0, remNew = 0;
  for (const line of splitLines(text)) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = { oldStart: +m[1], oldLines: m[2] == null ? 1 : +m[2], newStart: +m[3], newLines: m[4] == null ? 1 : +m[4], lines: [] };
      remOld = cur.oldLines; remNew = cur.newLines;
      hunks.push(cur); continue;
    }
    if (!cur || (remOld <= 0 && remNew <= 0)) continue;
    const c = line[0];
    if (c === '+') { cur.lines.push(line); remNew--; }
    else if (c === '-') { cur.lines.push(line); remOld--; }
    else if (c === '\\') cur.lines.push(line);
    else { cur.lines.push(' ' + line.slice(1)); remOld--; remNew--; }
  }
  return hunks;
}
const diffStats = (ops) => ops.reduce((s, o) => (o.t === '+' ? s.add++ : o.t === '-' ? s.del++ : 0, s), { add: 0, del: 0 });
const statNode = (s) => h('span', { class: 'stat', 'aria-label': `${s.add} added, ${s.del} removed` }, h('span', { class: 'add' }, '+' + s.add), h('span', { class: 'del' }, '\u2212' + s.del));
function inlineSpans(a, b) {
  const max = Math.min(a.length, b.length);
  let p = 0; while (p < max && a[p] === b[p]) p++;
  let s = 0; while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (p + s === 0) return null;
  const ca = a.length - p - s, cb = b.length - p - s;
  if (ca > a.length * .7 && cb > b.length * .7) return null;
  return [[p, a.length - s], [p, b.length - s]];
}
function renderDiffOps(ops, opts = {}) {
  const stats = diffStats(ops);
  const marks = new Map();
  for (let i = 0; i < ops.length;) {
    if (ops[i].t !== '-') { i++; continue; }
    let j = i; while (j < ops.length && ops[j].t === '-') j++;
    let k = j; while (k < ops.length && ops[k].t === '+') k++;
    const pairs = Math.min(j - i, k - j);
    for (let q = 0; q < pairs; q++) {
      const sp = inlineSpans(ops[i + q].text, ops[j + q].text);
      if (sp) { marks.set(ops[i + q], sp[0]); marks.set(ops[j + q], sp[1]); }
    }
    i = k;
  }
  const limit = opts.maxRows && !opts.showAll ? opts.maxRows : Infinity;
  const rows = [];
  let count = 0;
  for (const o of ops) {
    if (count >= limit) break;
    count++;
    if (o.t === 'gap') { rows.push(h('tr', { class: 'd-gap' }, h('td', { colspan: '4' }, '\u22EF ' + o.text))); continue; }
    const mk = marks.get(o);
    const text = o.text === '' ? '\u200b' : o.text;
    const code = mk ? [o.text.slice(0, mk[0]), h('mark', null, o.text.slice(mk[0], mk[1])), o.text.slice(mk[1])] : [text];
    const cls = o.t === '+' ? 'd-add' : o.t === '-' ? 'd-del' : 'd-ctx';
    rows.push(h('tr', { class: cls },
      h('td', { class: 'ln', 'data-n': o.a ?? '', 'data-m': o.b ?? o.a ?? '' }), h('td', { class: 'ln', 'data-n': o.b ?? '' }),
      h('td', { class: 'sg', 'data-s': o.t === ' ' ? '' : o.t === '-' ? '\u2212' : '+' }),
      h('td', { class: 'cd' }, code)));
  }
  if (count < ops.length) rows.push(h('tr', { class: 'd-more' }, h('td', { colspan: '4' }, h('button', { type: 'button', class: 'show-all', onclick: opts.onShowAll }, `Show ${plural(ops.length - count, 'more line')}`))));
  const el = h('div', { class: 'diff' });
  if (opts.header !== false && opts.path) el.append(h('div', { class: 'diff-head' }, h('span', { class: 'diff-path', title: opts.path }, opts.path), opts.tag ? h('span', { class: 'tc-tag' }, opts.tag) : null, statNode(stats)));
  el.append(h('table', { class: 'diff-table' }, h('tbody', null, rows)));
  return el;
}
const renderDiff = (oldStr, newStr, opts = {}) => renderDiffOps(hunkify(numberOps(diffLines(oldStr, newStr), opts.startLine || 1, opts.startLine || 1), opts.context ?? 3), opts);
const renderPatch = (hunks, opts = {}) => renderDiffOps(opsFromPatch(hunks), opts);
function renderUnifiedDiff(text, opts = {}) {
  const hunks = parseUnifiedDiff(text);
  if (!hunks.length && opts.kind === 'add') return renderDiffOps(numberOps(splitLines(text).map((t) => ({ t: '+', text: t }))), opts);
  return renderPatch(hunks, opts);
}

/* ======================================================= 4. chat state reducer */
// Consumes the server's chat events unchanged:
//   status, session, user, delta, text, reasoning, tool, tool-output, tool-result,
//   permission, permission-resolved, result, notice
// Optional extra field (not required): `parent` on tool / tool-result / delta / text /
// reasoning = the id of a Task tool call, to nest subagent work inside its card.
const BUSY = new Set(['starting', 'thinking', 'responding', 'tool', 'waiting']);
function createChatState(meta) {
  return { meta, items: [], byId: new Map(), status: 'idle', model: null, mode: null, sessionId: null, streaming: new Map(), seq: 0, turnStart: null };
}
function applyEvent(st, ev, now = Date.now()) {
  const changed = new Set();
  const parent = ev.parent || null;
  const add = (item) => { item.uid = item.uid || 'i' + (++st.seq); item.parent = item.parent ?? parent; item.at = now; st.items.push(item); st.byId.set(item.uid, item); changed.add(item.uid); return item; };
  const touch = (item) => item && changed.add(item.uid);
  const closeStreams = () => { for (const it of st.streaming.values()) { it.streaming = false; touch(it); } st.streaming.clear(); };
  let chrome = false;
  switch (ev.type) {
    case 'status':
      if (BUSY.has(ev.status) && !BUSY.has(st.status)) st.turnStart = now;
      st.status = ev.status; chrome = true;
      if (ev.status !== 'responding' && ev.status !== 'tool' && ev.status !== 'thinking') closeStreams();
      break;
    case 'session':
      st.sessionId = ev.id; st.model = ev.model ?? st.model; st.mode = ev.mode ?? st.mode; chrome = true;
      break;
    case 'user': add({ kind: 'user', text: ev.text || '', attachments: ev.attachments }); break;
    case 'delta': {
      let it = st.streaming.get(parent);
      if (!it) { it = add({ kind: 'assistant', text: '', streaming: true }); st.streaming.set(parent, it); }
      it.text += ev.text || '';
      touch(it);
      break;
    }
    case 'text': {
      const it = st.streaming.get(parent);
      if (it) { it.text = ev.text ?? it.text; it.streaming = false; st.streaming.delete(parent); touch(it); }
      else add({ kind: 'assistant', text: ev.text || '', streaming: false });
      break;
    }
    case 'reasoning': add({ kind: 'reasoning', text: ev.text || '' }); break;
    case 'tool':
      add({ kind: 'tool', uid: 'tool:' + ev.id, tool: ev, output: '', result: null, startedAt: now });
      break;
    case 'tool-output': {
      const it = st.byId.get('tool:' + ev.id);
      if (it) { it.output += ev.text || ''; touch(it); }
      break;
    }
    case 'tool-result': {
      const it = st.byId.get('tool:' + ev.id);
      if (it) { it.result = ev; it.endedAt = now; touch(it); }
      break;
    }
    case 'permission': {
      add({ kind: 'permission', uid: 'perm:' + ev.id, req: ev, decision: null });
      for (const it of st.items) if (it.kind === 'tool' && !it.result && permFor(ev, it.tool)) touch(it);
      chrome = true;
      break;
    }
    case 'permission-resolved': {
      const it = st.byId.get('perm:' + ev.id);
      if (it) {
        it.decision = ev.decision; touch(it);
        if (ev.message && !it.reasonNote) it.reasonNote = ev.message;
        for (const t of st.items) if (t.kind === 'tool' && !t.result && permFor(it.req, t.tool)) {
          if (ev.decision === 'deny' || ev.decision === 'cancelled') t.denied = true;
          touch(t);
        }
      }
      chrome = true;
      break;
    }
    case 'result': closeStreams(); add({ kind: 'result', res: ev, turnMs: st.turnStart ? now - st.turnStart : null }); st.turnStart = null; break;
    case 'notice': add({ kind: 'notice', text: ev.text || '', level: ev.level || 'info' }); break;
    default: break;
  }
  return { changed, chrome };
}
const pendingPermissions = (st) => st.items.filter((i) => i.kind === 'permission' && !i.decision);
// The top-level item an item renders inside (a Task card for subagent items).
function slotOf(st, uid) {
  let it = st.byId.get(uid), guard = 0;
  while (it && it.parent && guard++ < 20) {
    const p = st.byId.get('tool:' + it.parent);
    if (!p) break;
    it = p;
  }
  return it ? it.uid : uid;
}

/* ======================================================= 5. chat renderers */
const TOOL_INFO = {
  Bash: { kind: 'bash', icon: 'terminal' }, BashOutput: { kind: 'bash', icon: 'terminal' },
  Edit: { kind: 'edit', icon: 'pencil' }, MultiEdit: { kind: 'edit', icon: 'pencil' },
  Patch: { kind: 'patch', icon: 'pencil' },
  Write: { kind: 'write', icon: 'filePlus' }, NotebookEdit: { kind: 'generic', icon: 'pencil' },
  Read: { kind: 'read', icon: 'file' }, Grep: { kind: 'grep', icon: 'search' },
  Glob: { kind: 'glob', icon: 'folder' }, LS: { kind: 'glob', icon: 'folder' },
  TodoWrite: { kind: 'todo', icon: 'list', label: 'Todos' },
  WebFetch: { kind: 'webfetch', icon: 'globe', label: 'Fetch' }, WebSearch: { kind: 'websearch', icon: 'globe', label: 'Search' },
  Task: { kind: 'task', icon: 'bot', label: 'Agent' },
};
function toolInfo(name) {
  const t = TOOL_INFO[name];
  if (t) return { label: name, ...t };
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name));
  return { kind: 'generic', icon: 'plug', label: m ? m[2].replace(/_/g, ' ') : String(name), server: m ? m[1] : null };
}
function bashCommand(input) {
  let c = input && input.command;
  if (Array.isArray(c)) { c = c.slice(); if (/^(ba|z)?sh$/.test(c[0]) && c[1] === '-lc') c = c.slice(2); c = c.join(' '); }
  return String(c || '');
}
function editOps(tool, result, cwd) {
  const i = tool.input || {};
  if (result && Array.isArray(result.patch) && result.patch.length) return [{ path: relPath(i.file_path, cwd), ops: opsFromPatch(result.patch) }];
  const edits = tool.name === 'MultiEdit' ? (i.edits || []) : [i];
  return edits.map((e) => ({ path: relPath(i.file_path, cwd), ops: hunkify(numberOps(diffLines(e.old_string, e.new_string))), all: e.replace_all }));
}
function patchFiles(tool, result) {
  if (result && Array.isArray(result.diff)) return result.diff.map((d) => {
    const hunks = parseUnifiedDiff(d.diff);
    const ops = hunks.length ? opsFromPatch(hunks) : (d.kind === 'add' ? numberOps(splitLines(d.diff).map((t) => ({ t: '+', text: t }))) : []);
    return { path: d.path, kind: d.kind, ops };
  });
  const ch = tool.input && tool.input.changes;
  if (ch && typeof ch === 'object') return Object.keys(ch).map((p) => ({ path: p, kind: ch[p].kind || ch[p].type, ops: ch[p].unified_diff ? opsFromPatch(parseUnifiedDiff(ch[p].unified_diff)) : [] }));
  return [];
}
function parseReadOutput(text) {
  const rows = [];
  for (const l of splitLines(text)) {
    const m = /^\s*(\d+)[\u2192\t](.*)$/.exec(l);
    if (m) rows.push({ n: +m[1], text: m[2] }); else if (!/^<system-reminder>/.test(l)) rows.push({ n: '', text: l });
  }
  return rows;
}
function parseSearchLinks(text) {
  const m = /Links:\s*(\[[\s\S]*?\])\s*(?:\n|$)/.exec(String(text || ''));
  if (!m) return null;
  try { const a = JSON.parse(m[1]); return Array.isArray(a) ? a.filter((x) => x && x.url) : null; } catch { return null; }
}
const cleanErr = (t) => String(t || '').replace(/<\/?tool_use_error>/g, '').trim();

// One-line summary for the card header: {arg, extra, tag}
function summarizeTool(tool, result, opts = {}) {
  const info = toolInfo(tool.name), i = tool.input || {}, cwd = opts.cwd;
  const lines = (t) => splitLines(t).length;
  switch (info.kind) {
    case 'bash': { const c = bashCommand(i); return { arg: c.split('\n')[0] + (c.includes('\n') ? ' \u2026' : ''), full: c }; }
    case 'edit': { const files = editOps(tool, result, cwd); const s = files.reduce((acc, f) => { const x = diffStats(f.ops); acc.add += x.add; acc.del += x.del; return acc; }, { add: 0, del: 0 }); return { path: relPath(i.file_path, cwd), extra: statNode(s), tag: tool.name === 'MultiEdit' ? plural((i.edits || []).length, 'edit') : null }; }
    case 'patch': { const f = patchFiles(tool, result); const s = f.reduce((acc, x) => { const d = diffStats(x.ops); acc.add += d.add; acc.del += d.del; return acc; }, { add: 0, del: 0 }); return { path: f.length ? f[0].path : null, suffix: f.length > 1 ? ` +${f.length - 1} more` : '', arg: 'apply patch', extra: f.length ? statNode(s) : null }; }
    case 'write': return { path: relPath(i.file_path, cwd), extra: plural(lines(i.content), 'line') };
    case 'read': return { path: relPath(i.file_path, cwd), extra: i.offset ? `L${i.offset}\u2013${i.offset + (i.limit || 0)}` : (result && result.ok !== false ? plural(lines(result.text), 'line') : null) };
    case 'grep': { const n = result && result.ok !== false ? splitLines(result.text).filter((l) => l.trim()).length : null; return { arg: `"${i.pattern || ''}"` + (i.path ? ' in ' + relPath(i.path, cwd) : ''), extra: n != null ? plural(n, i.output_mode === 'content' ? 'match' : 'result', i.output_mode === 'content' ? 'matches' : 'results') : null }; }
    case 'glob': { const n = result && result.ok !== false ? splitLines(result.text).filter((l) => l.trim()).length : null; return { arg: i.pattern || i.path || '', extra: n != null ? plural(n, 'file') : null }; }
    case 'todo': { const t = i.todos || []; const cur = t.find((x) => x.status === 'in_progress'); return { arg: cur ? (cur.activeForm || cur.content) : plural(t.length, 'task'), extra: `${t.filter((x) => x.status === 'completed').length}/${t.length}` }; }
    case 'webfetch': return { arg: hostOf(i.url) };
    case 'websearch': { const l = result && parseSearchLinks(result.text); return { arg: `"${i.query || ''}"`, extra: l ? plural(l.length, 'result') : null }; }
    case 'task': return { arg: i.description || '', tag: i.subagent_type && i.subagent_type !== 'general-purpose' ? i.subagent_type : null, extra: opts.childCount ? plural(opts.childCount, 'step') : null };
    default: { const first = Object.values(i).find((v) => typeof v === 'string'); return { arg: first ? first.split('\n')[0] : '' }; }
  }
}
// File paths keep their file name visible: the directory part is what gets truncated.
function pathArg(p, suffix) {
  const k = p.lastIndexOf('/');
  return h('span', { class: 'tc-arg has-path', title: p }, k > -1 ? h('span', { class: 'p-dir' }, p.slice(0, k + 1)) : null, h('span', { class: 'p-base' }, p.slice(k + 1) + (suffix || '')));
}
function toolState(result, opts) {
  if (opts.denied) return 'denied';
  if (!result) return opts.awaiting ? 'awaiting' : opts.interrupted ? 'interrupted' : 'running';
  return result.ok === false ? 'error' : 'done';
}
const defaultExpanded = (kind, state) => kind === 'todo' || state === 'error' || (kind === 'task' && state === 'running') || (kind === 'bash' && state === 'running');

/**
 * renderToolCard(tool, result, opts) -> HTMLElement
 *   tool   = the 'tool' event        {id, name, input}
 *   result = the 'tool-result' event {id, ok, text, patch?, diff?, exitCode?} or null while running
 *   opts   = {output, expanded, onToggle(id), showAll, onShowAll(id), children:[Node], childCount,
 *             awaiting, interrupted, startedAt, durationMs, cwd}
 */
function renderToolCard(tool, result, opts = {}) {
  const info = toolInfo(tool.name);
  const state = toolState(result, opts);
  const sum = summarizeTool(tool, result, opts);
  const expanded = opts.expanded ?? defaultExpanded(info.kind, state);
  const bodyId = 'tcb-' + String(tool.id).replace(/[^\w-]/g, '');
  let status;
  if (state === 'running') status = h('span', { class: 'tc-status' }, spinner(13), opts.startedAt ? h('span', { 'data-since': opts.startedAt }, fmtDur(Date.now() - opts.startedAt)) : null);
  else if (state === 'awaiting') status = h('span', { class: 'tc-status wait' }, icon('shield', 13), 'Approval');
  else if (state === 'interrupted') status = h('span', { class: 'tc-status' }, 'Stopped');
  else if (state === 'denied') status = h('span', { class: 'tc-status' }, icon('x', 13), 'Not run');
  else if (state === 'error') status = h('span', { class: 'tc-status bad' }, icon('alert', 13), result.exitCode != null ? `exit ${result.exitCode}` : 'Failed');
  else status = h('span', { class: 'tc-status' }, opts.durationMs > 50 ? fmtDur(opts.durationMs) : icon('check', 13));
  const head = h('button', { type: 'button', class: 'tc-head', 'aria-expanded': String(expanded), 'aria-controls': bodyId, onclick: () => opts.onToggle && opts.onToggle(tool.id) },
    h('span', { class: 'tc-icon' }, icon(info.icon, 15)),
    h('span', { class: 'tc-name' }, info.label),
    info.server ? h('span', { class: 'tc-tag' }, info.server) : null,
    sum.tag ? h('span', { class: 'tc-tag' }, sum.tag) : null,
    sum.path != null ? pathArg(sum.path, sum.suffix) : h('span', { class: 'tc-arg', title: sum.full || sum.arg }, sum.arg),
    sum.extra ? h('span', { class: 'tc-extra' }, sum.extra) : null,
    status,
    h('span', { class: 'tc-chev' }, icon('chevronRight', 14)));
  const card = h('div', { class: `tc k-${info.kind} is-${state}${expanded ? ' is-open' : ''}`, 'data-tool': tool.id }, head);
  if (expanded) card.append(h('div', { class: 'tc-body', id: bodyId }, renderToolBody(info, tool, result, state, opts)));
  return card;
}
function renderToolBody(info, tool, result, state, opts) {
  const i = tool.input || {}, out = [];
  const errBox = () => result && result.ok === false && info.kind !== 'bash' ? h('div', { class: 'tc-error' }, icon('alert', 14), h('pre', null, cleanErr(result.text) || 'The tool call failed.')) : null;
  switch (info.kind) {
    case 'bash': {
      if (i.description) out.push(h('p', { class: 'tc-desc' }, i.description));
      if (state === 'denied') { out.push(renderTerminal(bashCommand(i), '', {})); break; }
      out.push(renderTerminal(bashCommand(i), result ? (result.text ?? opts.output) : opts.output, { exitCode: result ? (result.exitCode ?? (result.ok === false ? 1 : 0)) : null, running: !result, durationMs: opts.durationMs, showAll: opts.showAll, onShowAll: () => opts.onShowAll && opts.onShowAll(tool.id) }));
      break;
    }
    case 'edit': {
      out.push(errBox());
      const files = editOps(tool, result, opts.cwd);
      files.forEach((f, k) => out.push(renderDiffOps(f.ops, { path: files.length > 1 ? `${f.path} \u00b7 edit ${k + 1} of ${files.length}` : f.path, header: files.length > 1, tag: f.all ? 'replace all' : null, maxRows: 80, showAll: opts.showAll, onShowAll: () => opts.onShowAll && opts.onShowAll(tool.id) })));
      break;
    }
    case 'patch': {
      out.push(errBox());
      const files = patchFiles(tool, result);
      if (!files.length) out.push(renderCodeBlock(JSON.stringify(i, null, 2), 'json'));
      files.forEach((f) => out.push(renderDiffOps(f.ops, { path: f.path, tag: f.kind && f.kind !== 'update' ? f.kind : null, maxRows: 80, showAll: opts.showAll, onShowAll: () => opts.onShowAll && opts.onShowAll(tool.id) })));
      break;
    }
    case 'write':
      out.push(errBox());
      out.push(renderCodeView(splitLines(i.content), langFromPath(i.file_path), { maxLines: 16, showAll: opts.showAll, onShowAll: () => opts.onShowAll && opts.onShowAll(tool.id) }));
      break;
    case 'read':
      out.push(errBox());
      if (result && result.ok !== false) out.push(renderCodeView(parseReadOutput(result.text), langFromPath(i.file_path), { maxLines: 14, showAll: opts.showAll, onShowAll: () => opts.onShowAll && opts.onShowAll(tool.id) }));
      break;
    case 'grep':
      out.push(errBox());
      if (result && result.ok !== false) out.push(renderGrep(result.text, i, opts));
      break;
    case 'glob':
      out.push(errBox());
      if (result && result.ok !== false) out.push(renderFileList(result.text, opts));
      break;
    case 'todo': out.push(renderTodos(i.todos || [])); break;
    case 'webfetch':
      out.push(h('p', { class: 'tc-desc' }, h('a', { href: safeUrl(i.url) || '#', target: '_blank', rel: 'noopener noreferrer' }, i.url)));
      if (i.prompt) out.push(h('p', { class: 'tc-desc' }, 'Asked: ' + i.prompt));
      out.push(errBox());
      if (result && result.ok !== false) out.push(renderMarkdown(result.text));
      break;
    case 'websearch': {
      out.push(errBox());
      if (result && result.ok !== false) {
        const links = parseSearchLinks(result.text);
        if (links) out.push(h('ul', { class: 'links' }, links.slice(0, 10).map((l) => h('li', null, h('a', { href: safeUrl(l.url) || '#', target: '_blank', rel: 'noopener noreferrer' }, l.title || l.url), h('span', { class: 'host' }, hostOf(l.url))))));
        else out.push(renderMarkdown(result.text));
      }
      break;
    }
    case 'task':
      if (i.prompt) out.push(h('div', null, h('p', { class: 'tc-label' }, 'Prompt'), h('p', { class: 'task-prompt' }, i.prompt)));
      if (opts.children && opts.children.length) out.push(h('div', { class: 'task-children' }, opts.children));
      out.push(errBox());
      if (result && result.ok !== false && result.text) out.push(h('div', null, h('p', { class: 'tc-label' }, 'Result'), renderMarkdown(result.text)));
      break;
    default:
      out.push(h('div', null, h('p', { class: 'tc-label' }, 'Input'), renderCodeBlock(JSON.stringify(i, null, 2), 'json')));
      out.push(errBox());
      if (result && result.ok !== false && result.text) {
        const t = String(result.text).trim();
        out.push(h('div', null, h('p', { class: 'tc-label' }, 'Output'), /^[[{]/.test(t) ? renderCodeBlock(t, 'json') : h('pre', { class: 'plain-out' }, t)));
      }
  }
  return out;
}
function renderTerminal(command, output, opts = {}) {
  const lines = splitLines(output || '');
  const TAIL = 14;
  const cut = !opts.showAll && lines.length > TAIL + 4 ? lines.length - TAIL : 0;
  const el = h('div', { class: 'term' }, h('div', { class: 'term-cmd' }, h('span', { class: 'term-ps' }, '$'), h('span', null, command)));
  if (cut) el.append(h('button', { type: 'button', class: 'term-more', onclick: opts.onShowAll }, `Show ${plural(cut, 'earlier line')}`));
  el.append(h('pre', { class: 'term-out', tabindex: lines.length ? '0' : null }, lines.slice(cut).join('\n')));
  const foot = h('div', { class: 'term-foot' });
  if (opts.running) append(foot, [spinner(12), 'Running\u2026']);
  else if (opts.exitCode != null) append(foot, [h('span', { class: opts.exitCode === 0 ? 'ok' : 'bad' }, `exit ${opts.exitCode}`), opts.durationMs > 50 ? '\u00b7 ' + fmtDur(opts.durationMs) : null]);
  foot.append(h('span', { class: 'spacer' }), copyButton(() => (output || ''), 'Copy output', 'Copy command output'));
  el.append(foot);
  return el;
}
function renderCodeView(rows, lang, opts = {}) {
  rows = rows.map((r, k) => typeof r === 'string' ? { n: (opts.start || 1) + k, text: r } : r);
  const limit = opts.maxLines && !opts.showAll && rows.length > opts.maxLines + 4 ? opts.maxLines : rows.length;
  const shown = rows.slice(0, limit);
  const el = h('div', { class: 'cv' }, h('div', { class: 'cv-scroll', tabindex: '0' },
    h('pre', { class: 'cv-gutter', 'aria-hidden': 'true' }, shown.map((r) => r.n).join('\n')),
    h('pre', { class: 'cv-code' }, h('code', null, highlight(shown.map((r) => r.text).join('\n'), lang)))));
  if (limit < rows.length) el.append(h('button', { type: 'button', class: 'show-all', onclick: opts.onShowAll }, `Show all ${rows.length} lines`));
  return el;
}
function markMatches(text, rx) {
  if (!rx) return [text];
  const out = []; let last = 0, m, guard = 0;
  rx.lastIndex = 0;
  while ((m = rx.exec(text)) && guard++ < 50) {
    if (!m[0]) { rx.lastIndex++; continue; }
    out.push(text.slice(last, m.index), h('mark', null, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}
function renderGrep(text, input, opts) {
  let rx = null;
  try { rx = new RegExp(input.pattern, input['-i'] ? 'gi' : 'g'); } catch {}
  const lines = splitLines(text).filter((l) => l.trim());
  const limit = opts.showAll ? lines.length : 30;
  const ul = h('ul', { class: 'gl' });
  let lastFile = null;
  for (const line of lines.slice(0, limit)) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (m) {
      if (m[1] !== lastFile) { ul.append(h('li', { class: 'gl-file' }, relPath(m[1], opts.cwd))); lastFile = m[1]; }
      ul.append(h('li', { class: 'gl-line' }, h('span', { class: 'gl-ln' }, m[2]), h('span', { class: 'gl-text' }, markMatches(m[3], rx))));
    } else ul.append(h('li', { class: 'gl-file' }, relPath(line, opts.cwd)));
  }
  const wrap = h('div', null, ul);
  if (lines.length > limit) wrap.append(h('button', { type: 'button', class: 'show-all', onclick: () => opts.onShowAll && opts.onShowAll() }, `Show all ${lines.length}`));
  return wrap;
}
function renderFileList(text, opts) {
  const files = splitLines(text).filter((l) => l.trim());
  const limit = opts.showAll ? files.length : 20;
  const ul = h('ul', { class: 'fl' }, files.slice(0, limit).map((f) => {
    const r = relPath(f, opts.cwd), k = r.lastIndexOf('/');
    return h('li', null, k > -1 ? h('span', { class: 'dir' }, r.slice(0, k + 1)) : null, k > -1 ? r.slice(k + 1) : r);
  }));
  return files.length > limit ? h('div', null, ul, h('button', { type: 'button', class: 'show-all', onclick: () => opts.onShowAll && opts.onShowAll() }, `Show all ${files.length} files`)) : ul;
}
function renderTodos(todos) {
  const words = { completed: 'done', in_progress: 'in progress', pending: 'pending' };
  return h('ul', { class: 'todos' }, todos.map((t) => h('li', { class: 'todo st-' + t.status },
    h('span', { class: 'todo-mark', 'aria-hidden': 'true' }, t.status === 'completed' ? icon('check', 10) : null),
    h('span', { class: 'todo-text' }, t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content),
    h('span', { class: 'sr-only' }, ` (${words[t.status] || t.status})`))));
}

// Permission titles when the server doesn't send one.
function permTitle(req, agent) {
  if (req.title) return req.title;
  const k = toolInfo(req.name).kind, i = req.input || {};
  if (k === 'bash') return `${agent} wants to run a command`;
  if (k === 'edit' || k === 'patch') return `${agent} wants to edit ${basename(i.file_path) || 'files'}`;
  if (k === 'write') return `${agent} wants to create ${basename(i.file_path)}`;
  if (k === 'webfetch') return `${agent} wants to fetch ${hostOf(i.url).split('/')[0]}`;
  return `${agent} wants to use ${toolInfo(req.name).label}`;
}
function permWhat(req, cwd) {
  const k = toolInfo(req.name).kind, i = req.input || {};
  if (k === 'bash') return bashCommand(i);
  if (i.file_path) return relPath(i.file_path, cwd);
  if (i.url) return i.url;
  return toolInfo(req.name).label;
}
/**
 * renderPermission(item, opts) -> HTMLElement
 *   item = {req: <'permission' event>, decision: null | 'allow' | 'always' | 'deny' | 'cancelled', reasonNote?}
 *   opts = {agent, cwd, projectName, denyOpen, onDenyOpen(id, open), onDecide(id, decision, reason?)}
 */
function renderPermission(item, opts = {}) {
  const req = item.req, agent = opts.agent || 'Claude';
  const i = req.input || {}, k = toolInfo(req.name).kind;
  if (item.decision) {
    const deny = item.decision === 'deny' || item.decision === 'cancelled';
    const label = { allow: 'Allowed', always: 'Always allowed', deny: 'Denied', cancelled: 'Cancelled' }[item.decision] || item.decision;
    return h('div', { class: 'perm-done ' + (deny ? 'denied' : 'allowed') },
      h('div', { class: 'pd-line' }, icon(deny ? 'x' : 'check', 15), h('b', null, label),
        item.decision === 'always' && req.always ? h('span', { class: 'pd-rule' }, req.always) : h('span', { class: 'pd-what', title: permWhat(req, opts.cwd) }, permWhat(req, opts.cwd))),
      item.reasonNote ? h('p', { class: 'pd-reason' }, item.reasonNote) : null);
  }
  let body = null;
  if (k === 'bash') body = h('div', { class: 'term' }, h('div', { class: 'term-cmd' }, h('span', { class: 'term-ps' }, '$'), h('span', null, bashCommand(i))));
  else if (k === 'edit') body = editOps({ name: req.name, input: i }, null, opts.cwd).map((f) => renderDiffOps(f.ops, { path: f.path, maxRows: 40 }));
  else if (k === 'write') body = h('div', null, h('p', { class: 'tc-desc' }, relPath(i.file_path, opts.cwd) + ' \u00b7 ' + plural(splitLines(i.content).length, 'line')), renderCodeView(splitLines(i.content), langFromPath(i.file_path), { maxLines: 12 }));
  else if (k === 'webfetch') body = h('div', { class: 'cmd-row' }, h('code', null, i.url));
  else body = renderCodeBlock(JSON.stringify(i, null, 2), 'json');
  const titleId = 'pt-' + String(req.id).replace(/[^\w-]/g, '');
  const card = h('div', { class: 'perm', role: 'group', 'aria-labelledby': titleId, 'data-perm': req.id },
    h('div', { class: 'perm-head' }, h('span', { class: 'perm-icon' }, icon('shield', 17)),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'perm-title', id: titleId }, permTitle(req, agent)),
        h('div', { class: 'perm-sub' }, req.description || [toolInfo(req.name).label, opts.cwd ? ' \u00b7 ' + opts.cwd : ''].join('')))),
    body,
    req.reason ? h('p', { class: 'perm-why' }, req.reason) : null);
  if (opts.denyOpen) {
    const input = h('input', { class: 'input', id: titleId + '-r', placeholder: `Tell ${agent} what to do instead (optional)`, autocomplete: 'off', enterkeyhint: 'send' });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); opts.onDenyOpen(req.id, false); } });
    card.append(h('form', { class: 'perm-deny', onsubmit: (e) => { e.preventDefault(); opts.onDecide(req.id, 'deny', input.value.trim()); } },
      h('label', { class: 'sr-only', for: titleId + '-r' }, 'Reason for denying'), input,
      h('div', { class: 'perm-deny-actions' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => opts.onDenyOpen(req.id, false) }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn danger-solid' }, 'Deny'))));
  } else {
    card.append(h('div', { class: 'perm-actions' },
      h('button', { type: 'button', class: 'btn primary allow', 'data-allow': '', onclick: () => opts.onDecide(req.id, 'allow') }, icon('check', 16), 'Allow'),
      req.always ? h('button', { type: 'button', class: 'btn', onclick: () => opts.onDecide(req.id, 'always') }, 'Always allow') : null,
      h('button', { type: 'button', class: 'btn danger', onclick: () => opts.onDenyOpen(req.id, true) }, 'Deny')));
    const MODE_NAMES = { acceptEdits: 'auto-accept edits', bypassPermissions: 'bypass permissions', plan: 'plan mode', auto: 'auto mode', default: 'ask before edits' };
    if (req.always && String(req.always).startsWith('mode:')) {
      const m = String(req.always).slice(5);
      card.append(h('p', { class: 'perm-hint' }, '\u201cAlways allow\u201d switches this chat to ', h('b', null, MODE_NAMES[m] || m), '.'));
    } else if (req.always && /session/.test(req.always)) {
      card.append(h('p', { class: 'perm-hint' }, '\u201cAlways allow\u201d allows this ', req.always, '.'));
    } else if (req.always) {
      card.append(h('p', { class: 'perm-hint' }, '\u201cAlways allow\u201d adds ', h('code', null, req.always), ` to ${opts.projectName ? opts.projectName + '\u2019s' : 'this project\u2019s'} allow list.`));
    }
  }
  return card;
}

/**
 * renderMessage(item, ctx) -> HTMLElement | null      (one top-level stream item)
 *   item = an entry of state.items (see applyEvent)
 *   ctx  = {state, agent, cwd, projectName, isExpanded(id, def), onToggle(id), showAll(id),
 *           onShowAll(id), denyOpen(id), onDenyOpen(id, open), onDecide(id, d, reason), onRetry()}
 */
// An attachment on a sent message: a thumbnail for pictures, a chip for other files.
function renderAttachment(a) {
  const title = `${a.name}${a.size ? ' \u00b7 ' + fmtBytes(a.size) : ''}${a.missing ? ' (no longer stored)' : ''}`;
  if (a.image && a.url) return h('a', { class: 'att-img', href: a.url, target: '_blank', rel: 'noopener', title }, h('img', { src: a.url, alt: a.name, loading: 'lazy' }));
  const kids = [icon('file', 13), h('span', null, a.name)];
  return a.url ? h('a', { class: 'att', href: a.url, title, download: a.name }, kids) : h('span', { class: 'att' + (a.missing ? ' is-missing' : ''), title }, kids);
}
function fmtBytes(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`; }

function renderMessage(item, ctx) {
  let el = null;
  switch (item.kind) {
    case 'user':
      el = h('div', { class: 'ev ev-user' }, h('div', { class: 'bubble' }, item.text),
        item.attachments && item.attachments.length ? h('div', { class: 'att-row' }, item.attachments.map(renderAttachment)) : null);
      break;
    case 'assistant':
      el = h('div', { class: 'ev ev-assistant', 'aria-busy': item.streaming ? 'true' : null }, renderMarkdown(item.text, { streaming: item.streaming }));
      break;
    case 'reasoning': {
      const open = ctx.isExpanded(item.uid, false);
      el = h('div', { class: 'ev ev-reasoning' + (open ? ' is-open' : '') },
        h('button', { type: 'button', class: 'think-toggle', 'aria-expanded': String(open), onclick: () => ctx.onToggle(item.uid) }, icon('spark', 14), 'Thinking', icon('chevronRight', 12, 'chev')),
        open ? h('div', { class: 'think-body' }, renderMarkdown(item.text)) : null);
      break;
    }
    case 'tool': {
      const st = ctx.state, t = item.tool;
      const kids = st.items.filter((x) => x.parent === t.id);
      const pend = pendingPermissions(st).some((p) => permFor(p.req, t));
      const info = toolInfo(t.name);
      const state = toolState(item.result, { awaiting: pend, denied: item.denied });
      el = h('div', { class: 'ev ev-tool' }, renderToolCard(t, item.result, {
        output: item.output, cwd: ctx.cwd, awaiting: pend && !item.result, interrupted: item.interrupted, denied: item.denied,
        startedAt: item.startedAt, durationMs: item.result ? (item.result.durationMs ?? (item.endedAt - item.startedAt)) : null,
        expanded: ctx.isExpanded(t.id, defaultExpanded(info.kind, state)), onToggle: ctx.onToggle,
        showAll: ctx.showAll(t.id), onShowAll: ctx.onShowAll,
        children: kids.map((k) => renderMessage(k, ctx)).filter(Boolean), childCount: kids.filter((k) => k.kind === 'tool').length,
      }));
      break;
    }
    case 'permission':
      el = h('div', { class: 'ev ev-perm' }, renderPermission(item, { agent: ctx.agent, cwd: ctx.cwd, projectName: ctx.projectName, denyOpen: ctx.denyOpen(item.req.id), onDenyOpen: ctx.onDenyOpen, onDecide: ctx.onDecide }));
      break;
    case 'result': {
      const r = item.res, tk = r.tokens || {};
      const total = (tk.input || 0) + (tk.cached || 0) + (tk.output || 0);
      const parts = [fmtDur(r.durationMs ?? item.turnMs), total ? `${fmtTokens(total)} tokens` : null, r.cost != null ? fmtCost(r.cost) : null].filter(Boolean);
      el = h('div', { class: 'ev ev-result', title: total ? `input ${fmtTokens(tk.input || 0)} \u00b7 cached ${fmtTokens(tk.cached || 0)} \u00b7 output ${fmtTokens(tk.output || 0)}` : null },
        r.ok === false ? h('span', { class: 'rf-err' }, r.error || 'Turn failed') : null,
        h('span', null, parts.join(' \u00b7 ')));
      break;
    }
    case 'notice':
      if (item.level === 'error') {
        el = h('div', { class: 'ev ev-error', role: 'alert' }, icon('alert', 17), h('div', { class: 'err-main' }, h('div', { class: 'err-title' }, 'Something went wrong'), h('div', { class: 'err-text' }, item.text)),
          ctx.onRetry && ctx.state.status === 'error' && item === lastOf(ctx.state.items.filter((x) => x.kind === 'notice' && x.level === 'error'))
            ? h('button', { type: 'button', class: 'btn small', onclick: (e) => { e.currentTarget.remove(); ctx.onRetry(); } }, icon('refresh', 14), 'Retry') : null);
      } else {
        el = h('div', { class: 'ev ev-notice' }, h('span', { class: 'notice-in' }, icon('info', 13), item.text));
      }
      break;
    default: return null;
  }
  el.dataset.uid = item.uid;
  return el;
}
const lastOf = (a) => a[a.length - 1];

/* ======================================================= 6. chat view */
// Model pickers. '' = the tool's own default. app.js replaces the Codex list with
// the models Codex itself reports.
const MODELS = {
  claude: [{ v: '', label: 'Default model' }, { v: 'opus', label: 'Opus' }, { v: 'sonnet', label: 'Sonnet' }, { v: 'haiku', label: 'Haiku' }],
  codex: [{ v: '', label: 'Default model' }],
};
// Features the backend doesn't support yet stay out of the UI.
const FEATURES = { attachments: true };
// A permission request names the exact tool call it's for (toolId); older events
// without one fall back to matching by tool name.
const permFor = (req, tool) => (req.toolId ? req.toolId === tool.id : req.name === tool.name);
const MODES = {
  claude: [
    { v: 'default', label: 'Ask before edits' }, { v: 'acceptEdits', label: 'Auto-accept edits' }, { v: 'plan', label: 'Plan' },
    { v: 'auto', label: 'Auto' }, { v: 'bypassPermissions', label: '\u26A0 Bypass permissions', short: 'Bypass permissions', danger: true },
  ],
  codex: [
    { v: 'ask', label: 'Ask' }, { v: 'auto', label: 'Auto' }, { v: 'full-access', label: '\u26A0 Full access', short: 'Full access', danger: true },
  ],
};
const MODE_WARN = {
  bypassPermissions: 'Bypass permissions: every tool runs without asking, including shell commands and deletes.',
  'full-access': 'Full access: Codex never asks, and can run any command and reach the network.',
};
const SUGGEST = [
  { t: 'Explain this project', d: 'The layout, how it starts, where to look first', p: 'Give me a tour of this project: the main folders, how it starts, and where I should look first.' },
  { t: 'Review my changes', d: 'Read the uncommitted diff and flag problems', p: 'Review the uncommitted changes (git diff) and point out bugs, risky bits and anything I forgot.' },
  { t: 'Run the tests', d: 'Run the suite and fix whatever fails', p: 'Run the tests and fix anything that fails.' },
  { t: 'Fix a bug', d: 'Describe what\u2019s wrong; it digs in', p: 'Something is broken: ' },
];
function statusMeta(st) {
  const s = st.status;
  if (s === 'waiting' || pendingPermissions(st).length) return { cls: 's-needs', label: 'Needs approval' };
  if (s === 'tool') { const t = [...st.items].reverse().find((i) => i.kind === 'tool' && !i.result); return { cls: 's-busy', label: t ? 'Running ' + toolInfo(t.tool.name).label : 'Running tool' }; }
  return ({
    idle: { cls: 's-idle', label: 'Idle' }, starting: { cls: 's-busy', label: 'Starting' }, thinking: { cls: 's-busy', label: 'Thinking' },
    responding: { cls: 's-busy', label: 'Responding' }, error: { cls: 's-bad', label: 'Error' }, closed: { cls: 's-off', label: 'Closed' }, offline: { cls: 's-off', label: 'Not running' },
  })[s] || { cls: 's-idle', label: s };
}

/**
 * createChatView(pane, handlers) -> {show(state, meta), update(result), focusComposer()}
 *   handlers: onSend(text, files), onStop(), onDecide(id, decision, reason), onModel(v), onMode(v),
 *             onBack(), onClose(), onTerminal(), onRename(title), onRetry()
 */
function createChatView(pane, handlers) {
  const ui = { toggled: new Set(), showAll: new Set(), denyOpen: new Set() };
  let st = null, meta = null, R = null, queued = new Set(), raf = 0, files = [];
  const drafts = new Map();

  function ctx() {
    return {
      state: st, agent: meta.tool === 'codex' ? 'Codex' : 'Claude', cwd: meta.cwd, projectName: meta.projectName,
      isExpanded: (id, def) => ui.toggled.has(id) ? !def : def,
      onToggle: (id) => { ui.toggled.has(id) ? ui.toggled.delete(id) : ui.toggled.add(id); renderNow(slotFor(id)); },
      showAll: (id) => ui.showAll.has(id),
      onShowAll: (id) => { ui.showAll.add(id); renderNow(slotFor(id)); },
      denyOpen: (id) => ui.denyOpen.has(id),
      onDenyOpen: (id, open) => {
        open ? ui.denyOpen.add(id) : ui.denyOpen.delete(id);
        const uid = 'perm:' + id; renderNow(uid);
        const card = R.inner.querySelector(`[data-uid="${CSS.escape(uid)}"]`);
        if (card) (open ? card.querySelector('input') : card.querySelector('.btn.danger'))?.focus();
      },
      onDecide: (id, decision, reason) => { ui.denyOpen.delete(id); handlers.onDecide(id, decision, reason); },
      onRetry: handlers.onRetry,
    };
  }
  // Ids handed to onToggle are either item uids (reasoning) or tool ids.
  function slotFor(id) { const uid = st.byId.has(id) ? id : 'tool:' + id; return slotOf(st, uid); }

  function nearBottom() { const s = R.stream; return s.scrollHeight - s.scrollTop - s.clientHeight < 80; }
  function toBottom() { R.stream.scrollTop = R.stream.scrollHeight; }
  function renderItemInto(uid, c) {
    const item = st.byId.get(uid);
    const old = R.inner.querySelector(`:scope > [data-uid="${CSS.escape(uid)}"]`);
    const node = item && !item.parent ? renderMessage(item, c) : null;
    if (old && node) old.replaceWith(node);
    else if (old) old.remove();
    else if (node) {
      R.inner.querySelector(':scope > .empty-chat')?.remove();
      node.classList.add('is-enter');
      const live = R.inner.querySelector(':scope > .live-ind');
      live ? live.before(node) : R.inner.append(node);
    }
  }
  function renderNow(uid) { if (R) renderItemInto(uid, ctx()); }
  function flush() {
    raf = 0;
    if (!R) return;
    const stick = nearBottom();
    const c = ctx();
    for (const uid of queued) renderItemInto(uid, c);
    queued.clear();
    renderLive();
    if (stick) toBottom();
    R.jump.hidden = nearBottom();
  }
  function renderLive() {
    R.inner.querySelector(':scope > .live-ind')?.remove();
    if (st.status === 'thinking' || st.status === 'starting') {
      R.inner.append(h('div', { class: 'live-ind', 'aria-live': 'off' }, icon('spark', 15, 'spark'), h('span', { class: 'shimmer' }, st.status === 'starting' ? 'Starting session' : 'Thinking'),
        st.turnStart ? h('span', { 'data-since': st.turnStart }, fmtDur(Date.now() - st.turnStart)) : null, h('span', { class: 'esc-hint' }, '\u00b7 Esc to interrupt')));
    }
  }
  function renderAll() {
    const c = ctx();
    R.inner.replaceChildren();
    const top = st.items.filter((i) => !i.parent);
    if (!top.length) R.inner.append(renderEmpty());
    for (const it of top) { const n = renderMessage(it, c); if (n) R.inner.append(n); }
    renderLive();
  }
  function renderEmpty() {
    const agent = meta.tool === 'codex' ? 'Codex' : 'Claude';
    return h('div', { class: 'empty-chat' }, toolBadge(meta.tool, 'xl'),
      h('h3', null, `New ${agent} chat`), h('p', { class: 'ec-sub' }, 'in ', h('b', null, meta.projectName || '')),
      h('div', { class: 'ec-meta' }, icon('folder', 13), h('span', { class: 'path' }, meta.cwd), meta.branch ? h('span', { class: 'chip-branch' }, icon('branch', 11), meta.branch) : null),
      h('div', { class: 'suggest' }, SUGGEST.map((s) => h('button', { type: 'button', class: 'sg-card', onclick: () => { R.ta.value = s.p; autosize(); R.ta.focus(); R.ta.setSelectionRange(s.p.length, s.p.length); syncComposer(); } }, h('span', { class: 'sg-t' }, s.t), h('span', { class: 'sg-d' }, s.d)))));
  }

  function header() {
    const titleSlot = h('h2', { class: 'ch-title' });
    const renderTitle = () => titleSlot.replaceChildren(h('button', { type: 'button', class: 'title-btn', title: 'Rename', onclick: editTitle }, h('span', null, meta.title), icon('pencil', 13)));
    function editTitle() {
      const input = h('input', { class: 'title-input', value: meta.title, 'aria-label': 'Chat title', maxlength: '120', enterkeyhint: 'done' });
      let done = false;
      const finish = (save) => { if (done) return; done = true; const v = input.value.trim(); if (save && v && v !== meta.title) { meta.title = v; handlers.onRename(v); } renderTitle(); titleSlot.querySelector('button').focus(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
      input.addEventListener('blur', () => finish(true));
      titleSlot.replaceChildren(input); input.focus(); input.select();
    }
    renderTitle();
    const pill = h('span', { class: 'status', role: 'status' });
    const metaRow = h('div', { class: 'ch-meta' }, pill, h('span', { class: 'swatch', style: `--proj:${safeColor(meta.projectColor)}` }), h('span', { class: 'proj-label' }, meta.projectName), h('span', { class: 'path', title: meta.cwd }, meta.cwd), meta.branch ? h('span', { class: 'chip-branch' }, icon('branch', 11), meta.branch) : null);
    const el = h('header', { class: 'ch' },
      h('button', { type: 'button', class: 'icon-btn back', 'aria-label': 'Back to projects', onclick: handlers.onBack }, icon('arrowLeft', 20)),
      h('div', { class: 'ch-main' }, toolBadge(meta.tool, 'lg'), h('div', { class: 'ch-text' }, titleSlot, metaRow)),
      h('div', { class: 'ch-actions' },
        h('button', { type: 'button', class: 'btn ghost small', title: meta.tool === 'codex' ? 'codex resume in a terminal' : 'claude --resume in a terminal', onclick: handlers.onTerminal }, icon('terminal', 16), h('span', { class: 'term-label' }, 'Open in terminal'), h('span', { class: 'sr-only' }, ' Open in terminal')),
        h('button', { type: 'button', class: 'icon-btn sm close', 'aria-label': 'Close chat', onclick: handlers.onClose }, icon('x', 18))));
    return { el, pill, renderTitle };
  }

  function pick(label, options, value, onChange, isMode) {
    const sel = h('select', { 'aria-label': label }, options.map((o) => h('option', { value: o.v, selected: o.v === value }, o.label)));
    const wrap = h('label', { class: 'pick' }, isMode ? h('span', { class: 'mdot', 'aria-hidden': 'true' }) : null, sel, icon('chevronDown', 13, 'chev'));
    const sync = () => {
      const o = options.find((x) => x.v === sel.value) || options[0];
      wrap.classList.toggle('is-danger', !!o.danger);
      if (isMode) wrap.dataset.mode = o.v;
    };
    sel.addEventListener('change', () => { sync(); onChange(sel.value); });
    sync();
    return { el: wrap, sel, sync };
  }

  function composer() {
    const agent = meta.tool === 'codex' ? 'Codex' : 'Claude';
    const ta = h('textarea', { class: 'ta', rows: '1', 'aria-label': `Message ${agent}`, enterkeyhint: 'send', autocapitalize: 'sentences' });
    ta.value = drafts.get(meta.key) || '';
    const fileIn = h('input', { type: 'file', multiple: true, hidden: true });
    const chips = h('div', { class: 'attach-list' });
    files = [];
    const previews = new Map(); // File -> object URL for its thumbnail
    const thumb = (f) => { if (!previews.has(f)) previews.set(f, URL.createObjectURL(f)); return previews.get(f); };
    const renderChips = () => {
      for (const [f, u] of previews) if (!files.includes(f)) { URL.revokeObjectURL(u); previews.delete(f); }
      chips.replaceChildren(...files.map((f, k) => h('span', { class: 'att' + (/^image\//.test(f.type) ? ' has-thumb' : ''), title: `${f.name} \u00b7 ${fmtBytes(f.size)}` },
        /^image\//.test(f.type) ? h('img', { src: thumb(f), alt: '' }) : icon('file', 13), h('span', null, f.name),
        h('button', { type: 'button', 'aria-label': 'Remove ' + f.name, onclick: () => { files.splice(k, 1); renderChips(); syncComposer(); } }, icon('x', 13)))));
    };
    const addFiles = (list) => {
      const add = [...list].filter((f) => f && f.size > 0);
      if (!add.length) return;
      // Pasted screenshots all arrive as "image.png"; give them distinct names.
      files.push(...add.map((f, i) => (f.name && f.name !== 'image.png') ? f : new File([f], `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}${add.length > 1 ? '-' + (i + 1) : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
      renderChips(); syncComposer();
    };
    fileIn.addEventListener('change', () => { addFiles(fileIn.files); fileIn.value = ''; });
    const model = pick('Model', MODELS[meta.tool], st.model || MODELS[meta.tool][0].v, (v) => { st.model = v; handlers.onModel(v); });
    const mode = pick('Permission mode', MODES[meta.tool], st.mode || MODES[meta.tool][0].v, (v) => { st.mode = v; handlers.onMode(v); syncComposer(); }, true);
    const send = h('button', { type: 'submit', class: 'send' });
    const hint = h('span', { class: 'kbd-hint' });
    const banner = h('div', { class: 'approval-banner', hidden: true }, icon('shield', 15), h('span', null, `${agent} is waiting for your approval`), h('button', { type: 'button', class: 'link-btn', onclick: focusPermission }, 'Review'));
    const warn = h('p', { class: 'mode-warn', hidden: true }, icon('alert', 14), h('span'));
    const form = h('form', { class: 'composer' }, chips, ta,
      h('div', { class: 'composer-bar' },
        FEATURES.attachments ? h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Attach files or pictures', title: 'Attach files or pictures (or paste / drop them here)', onclick: () => fileIn.click() }, icon('paperclip', 18)) : null, fileIn,
        model.el, mode.el, h('span', { class: 'spacer' }), hint, send));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (BUSY.has(st.status)) { handlers.onStop(); return; }
      const text = ta.value.trim();
      if (!text && !files.length) return;
      const sent = files;
      const r = handlers.onSend(text, sent);
      ta.value = ''; drafts.set(meta.key, ''); files = []; renderChips(); autosize(); syncComposer();
      // If the upload fails, put the message and its files back.
      if (r && r.then) r.then((ok) => { if (ok === false && !ta.value && !files.length) { ta.value = text; files = sent; renderChips(); autosize(); syncComposer(); } });
    });
    if (FEATURES.attachments) {
      ta.addEventListener('paste', (e) => {
        const list = [...(e.clipboardData && e.clipboardData.files || [])];
        if (list.length) { e.preventDefault(); addFiles(list); }
      });
      form.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); form.classList.add('is-drop'); } });
      form.addEventListener('dragleave', (e) => { if (!form.contains(e.relatedTarget)) form.classList.remove('is-drop'); });
      form.addEventListener('drop', (e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); form.classList.remove('is-drop'); addFiles(e.dataTransfer.files); ta.focus(); });
    }
    const coarse = matchMedia('(pointer: coarse)').matches;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) {
        e.preventDefault();
        if (BUSY.has(st.status)) { toast(`${agent} is still working. Press Esc or Stop to interrupt.`); return; }
        form.requestSubmit();
      } else if (e.key === 'Escape' && BUSY.has(st.status)) { e.preventDefault(); handlers.onStop(); }
    });
    ta.addEventListener('input', () => { drafts.set(meta.key, ta.value); autosize(); syncComposer(); });
    return { el: h('div', { class: 'composer-wrap' }, banner, form, warn), ta, send, hint, banner, warn, form, model, mode };
  }
  function autosize() { if (!R) return; const ta = R.ta; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, Math.max(120, window.innerHeight * .3)) + 'px'; }
  function focusPermission() {
    const card = R.inner.querySelector('.perm');
    if (!card) return;
    card.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    card.querySelector('[data-allow]')?.focus({ preventScroll: true });
  }
  function syncComposer() {
    if (!R) return;
    const busy = BUSY.has(st.status);
    const agent = meta.tool === 'codex' ? 'Codex' : 'Claude';
    const offline = st.status === 'offline' || st.status === 'closed';
    R.ta.placeholder = offline ? `Message ${agent} to resume this chat\u2026` : busy ? `${agent} is working\u2026` : `Message ${agent}\u2026`;
    R.send.classList.toggle('is-stop', busy);
    R.send.replaceChildren(icon(busy ? 'stop' : 'arrowUp', busy ? 14 : 19));
    R.send.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    R.send.title = busy ? 'Stop (Esc)' : 'Send (Enter)';
    R.send.disabled = !busy && !R.ta.value.trim() && !files.length;
    R.hint.replaceChildren(...(busy ? [h('kbd', null, 'Esc'), ' to stop'] : [h('kbd', null, '\u21b5'), ' send \u00b7 ', h('kbd', null, '\u21e7\u21b5'), ' newline']));
    R.banner.hidden = !pendingPermissions(st).length;
    const m = MODES[meta.tool].find((x) => x.v === (st.mode || MODES[meta.tool][0].v));
    R.warn.hidden = !(m && m.danger);
    R.warn.querySelector('span').textContent = MODE_WARN[m && m.v] || '';
    R.form.classList.toggle('is-danger', !!(m && m.danger));
    if (R.model.sel.value !== st.model && st.model) { R.model.sel.value = st.model; R.model.sync(); }
    if (R.mode.sel.value !== st.mode && st.mode) { R.mode.sel.value = st.mode; R.mode.sync(); }
  }
  function syncChrome() {
    if (!R) return;
    const m = statusMeta(st);
    R.pill.className = 'status ' + m.cls; R.pill.textContent = m.label;
    syncComposer();
  }

  return {
    get state() { return st; },
    show(state, m) {
      st = state; meta = m; queued.clear();
      ui.toggled.clear(); ui.showAll.clear(); ui.denyOpen.clear();
      if (!st) { R = null; pane.replaceChildren(h('div', { class: 'pane-empty' }, h('div', null, h('div', { class: 'art' }, icon('message', 26)), h('h2', null, 'No chat open'), h('p', null, 'Pick a chat in the tree, or start one with + Claude or + Codex on a project.')))); return; }
      const hd = header(), cp = composer();
      const inner = h('div', { class: 'stream-inner', role: 'log', 'aria-label': 'Conversation', 'aria-live': 'polite' });
      const stream = h('div', { class: 'stream' }, inner);
      const jump = h('button', { type: 'button', class: 'jump', hidden: true, onclick: () => R.stream.scrollTo({ top: R.stream.scrollHeight, behavior: 'smooth' }) }, icon('arrowDown', 14), 'Latest');
      stream.addEventListener('scroll', () => { jump.hidden = nearBottom(); }, { passive: true });
      pane.replaceChildren(hd.el, h('div', { class: 'stream-wrap' }, stream, jump), cp.el);
      R = { pill: hd.pill, renderTitle: hd.renderTitle, inner, stream, jump, ...cp };
      renderAll(); syncChrome(); autosize();
      requestAnimationFrame(() => { toBottom(); jump.hidden = true; });
    },
    // Call with the return value of applyEvent() for the chat being shown.
    update(res) {
      if (!R) return;
      for (const uid of res.changed) queued.add(slotOf(st, uid));
      if (!raf) raf = requestAnimationFrame(flush);
      if (res.chrome) syncChrome();
    },
    retitle(t) { if (R && meta) { meta.title = t; R.renderTitle(); } },
    focusComposer() { R && R.ta.focus(); },
  };
}

/* ======================================================= 7. projects view */
// Consumes the existing GET api/projects shape (see projects.js), plus an optional
// per-chat `ui` status for sessions running in roost's own chat UI.
const UI_STATE = (c) => App.chatStatus(c.key);
function chatIndicator(c) {
  const s = UI_STATE(c);
  if (!s) return null;
  if (s === 'needs') return h('span', { class: 'badge needs' }, 'Needs you');
  if (s === 'busy') return h('span', { class: 'dot busy', title: 'Working in roost', role: 'img', 'aria-label': 'Working' });
  if (s === 'error') return h('span', { class: 'dot bad', title: 'Error', role: 'img', 'aria-label': 'Error' });
  return h('span', { class: 'dot ring', title: 'Open in roost', role: 'img', 'aria-label': 'Open in roost' });
}
function renderChatRow(c, view) {
  const sel = view.current === c.key;
  const badges = [
    c.active ? h('span', { class: 'badge live', title: 'Written to in the last 90 seconds' }, 'live') : null,
    c.session ? h('span', { class: 'badge', title: 'Open in a roost terminal session' }, icon('terminal', 11), 'terminal') : null,
    c.remote ? h('span', { class: 'badge remote', title: 'Has been driven over Remote Control' }, icon('cloud', 11), 'remote') : null,
    ...(c.prs || []).slice(0, 2).map((u) => h('a', { class: 'badge pr', href: safeUrl(u) || '#', target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, icon('pr', 11), '#' + basename(u))),
  ].filter(Boolean);
  const li = h('li', { class: 'chat-item' + (sel ? ' is-selected' : ''), 'data-key': c.key, draggable: view.desktop ? 'true' : null },
    h('button', { type: 'button', class: 'chat-open', 'data-fk': 'c:' + c.key, 'aria-current': sel ? 'true' : null, onclick: () => view.onOpen(c.key) },
      toolBadge(c.tool, 'sm'),
      h('span', { class: 'chat-text' },
        h('span', { class: 'chat-title', title: c.title }, c.title),
        h('span', { class: 'chat-meta' }, `${plural(c.prompts, 'prompt')}`, h('span', { class: 'sep' }, '\u00b7'), ago(c.updated), c.assigned ? [h('span', { class: 'sep' }, '\u00b7'), 'filed'] : null, badges)),
      h('span', { class: 'chat-state' }, chatIndicator(c))),
    h('button', { type: 'button', class: 'icon-btn sm chat-more', 'aria-label': 'Actions for ' + c.title, 'aria-haspopup': 'dialog', onclick: (e) => view.onChatMenu(c, e.currentTarget) }, icon('more', 18)));
  return li;
}
function renderProject(p, view) {
  const f = view.filter;
  const match = (c) => (view.showArchived ? c.archived : !c.archived) && (!f || (c.title + ' ' + (c.cwd || '') + ' ' + (c.branch || '')).toLowerCase().includes(f));
  const locs = p.locations.map((l) => ({ ...l, chats: l.chats.filter(match) }));
  const shown = locs.reduce((n, l) => n + l.chats.length, 0);
  const nameHit = !f || p.name.toLowerCase().includes(f);
  if (f && !shown && !nameHit) return null;
  if (view.showArchived && !shown) return null;
  if (p.other && !shown) return null;
  const open = view.expanded.has(p.id) || !!f;
  const all = p.locations.flatMap((l) => l.chats).filter((c) => !c.archived);
  const needs = all.filter((c) => UI_STATE(c) === 'needs').length;
  const live = all.filter((c) => c.active).length;
  const firstPath = p.paths[0];
  const rc = p.rc && p.rc.enabled
    ? h('button', { type: 'button', class: 'badge ' + (p.rc.running ? 'remote' : 'warn'), title: `Remote Control server for this project (${p.rc.mode})`, onclick: () => view.onEdit(p) }, icon('cloud', 11), `RC ${p.rc.running ? 'on' : 'starting'}`)
    : null;
  const sec = h('section', { class: 'proj' + (open ? ' is-open' : '') + (p.other ? ' other' : ''), 'data-id': p.id, 'aria-label': p.name, style: `--proj:${safeColor(p.color)}` },
    h('div', { class: 'proj-head', 'data-drop': p.id },
      h('button', { type: 'button', class: 'proj-toggle', 'aria-expanded': String(open), 'data-fk': 'p:' + p.id, onclick: () => view.onToggle(p.id) },
        icon('chevronRight', 16, 'chev'), h('span', { class: 'proj-name' }, p.name),
        p.pinned ? h('span', { class: 'proj-pin', title: 'Pinned' }, icon('star', 13)) : null),
      h('span', { class: 'proj-badges' }, needs ? h('span', { class: 'badge needs' }, `${needs} needs you`) : live ? h('span', { class: 'badge live' }, `${live} live`) : null, rc),
      p.other ? null : h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Actions for ' + p.name, 'aria-haspopup': 'dialog', onclick: (e) => view.onProjectMenu(p, e.currentTarget) }, icon('more', 18))),
    h('div', { class: 'proj-sub' }, p.branch ? h('span', { class: 'chip-branch' }, icon('branch', 11), p.branch) : null,
      `${plural(p.chatCount, 'chat')}${p.updated ? ' \u00b7 ' + ago(p.updated) : ''}${p.paths.length > 1 ? ` \u00b7 ${p.paths.length} folders` : ''}`));
  if (open) {
    sec.append(h('ul', { class: 'locs' }, locs.filter((l) => l.chats.length || !f).map((l) => h('li', { class: 'loc' },
      h('div', { class: 'loc-head', title: l.path }, icon(l.kind === 'worktree' ? 'fork' : l.kind === 'repo' ? 'repo' : 'folder', 14), h('span', { class: 'loc-label' }, l.label), l.branch ? h('span', { class: 'chip-branch' }, icon('branch', 11), l.branch) : null, h('span', { class: 'loc-count' }, l.chats.length ? '' : '')),
      l.chats.length ? h('ul', { class: 'chats' }, l.chats.map((c) => renderChatRow(c, view))) : h('p', { class: 'loc-empty' }, 'No chats yet')))));
    if (!p.other) sec.append(h('div', { class: 'proj-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => view.onNewChat(p, 'claude') }, icon('plus', 14), toolBadge('claude'), 'Claude'),
      h('button', { type: 'button', class: 'btn', onclick: () => view.onNewChat(p, 'codex') }, icon('plus', 14), toolBadge('codex'), 'Codex'),
      firstPath ? h('a', { class: 'btn ghost', href: 'code/?folder=' + encodeURIComponent(firstPath), target: '_blank', onclick: view.onExternal }, icon('code', 15), 'VS Code') : null,
      firstPath ? h('a', { class: 'btn ghost', href: 'files/files/workspace/' + encodeURI(relPath(firstPath)), target: '_blank', onclick: view.onExternal }, icon('folderOpen', 15), 'Files') : null,
      h('button', { type: 'button', class: 'btn ghost', onclick: () => view.onEdit(p) }, icon('pencil', 14), 'Edit')));
  }
  return sec;
}
function renderProjectTree(data, view) {
  const nodes = data.projects.map((p) => renderProject(p, view)).filter(Boolean);
  if (!nodes.length) {
    if (view.filter || view.showArchived) return [h('div', { class: 'tree-empty' }, view.showArchived ? 'No archived chats.' : ['Nothing matches \u201c', view.filter, '\u201d.'])];
    return [h('div', { class: 'tree-empty' }, h('p', { style: 'margin:0 0 6px' }, h('b', null, 'No projects yet.')), h('p', { style: 'margin:0' }, 'Clone a repository or create a folder with New project, or put folders in /workspace from the terminal or the Files page. Chats from Claude and Codex appear here automatically.'))];
  }
  return nodes;
}

/* ======================================================= 8. overview */
// Consumes the existing GET api/status shape (see app.js).
function setupSteps(s) {
  const a = s.accounts, steps = [];
  if (!a.claude.signedIn) steps.push({ text: ['Sign in to Claude: run ', h('code', null, 'roost-setup claude'), ' in a terminal.'], action: { label: 'Terminal', href: 'term/' } });
  const waiting = (s.rc.projects || []).find((p) => /\(y\/n\)/i.test(p.console || ''));
  if (waiting) steps.push({ text: ['Remote Control in ', h('b', null, waiting.name || waiting.dir), ' is asking a question.'], answer: waiting.session });
  if (!a.codex.signedIn) steps.push({ text: ['Sign in to Codex with ', h('code', null, 'roost-setup codex'), '.'], optional: true });
  if (!a.github.signedIn) steps.push({ text: ['Connect GitHub (and GitLab) so agents can use ', h('code', null, 'gh'), ' / ', h('code', null, 'glab'), ' and clone private repos.'], optional: true, action: { label: 'Secrets', href: '#/secrets', internal: true } });
  if (a.ssh.enabled && a.ssh.authorizedKeys === 0) steps.push({ text: ['Add an SSH key (', h('code', null, 'roost-setup ssh'), ') to connect from terminals and the desktop app.'], optional: true });
  return steps;
}
function renderOverview(s, view) {
  const a = s.accounts, steps = setupSteps(s);
  const projects = s.rc.projects || [];
  const anyRunning = projects.some((p) => p.running);
  const sec = (title, aside, ...kids) => h('section', null, h('div', { class: 'sec-h' }, h('h2', null, title), aside ? h('span', { class: 'aside' }, aside) : null), ...kids);

  const attention = steps.length
    ? h('div', { class: 'card attn' }, h('ol', { class: 'attn-list' }, steps.map((st, k) => h('li', { class: 'attn-item' }, h('span', { class: 'n' }, String(k + 1)),
      h('span', { class: 'txt' }, st.text, st.optional ? h('span', { class: 'opt' }, 'optional') : null),
      st.answer ? h('button', { type: 'button', class: 'btn primary small', onclick: () => view.onAnswer(st.answer) }, 'Answer \u201cy\u201d') : st.action ? h('a', { class: 'btn small', href: st.action.href, target: st.action.internal ? null : '_blank', onclick: st.action.internal ? null : view.onExternal }, st.action.label) : null))))
    : h('div', { class: 'card attn-done' }, icon('check', 18), 'All set up.');

  const usageCard = view.usage ? renderUsage(view.usage, s, view) : null;

  const rcRow = (p) => {
    const asking = /\(y\/n\)/i.test(p.console || '');
    const open = view.consoles.has(p.session);
    return h('li', { class: 'rc-row' },
      h('div', { class: 'rc-head' }, h('span', { class: 'dot ' + (p.running ? 'ok' : 'bad') }),
        h('div', { class: 'grow' }, h('div', { class: 'rc-title' }, p.name || p.dir), h('div', { class: 'rc-meta' }, `${p.dir} \u00b7 ${p.mode}`)),
        h('a', { class: 'btn ghost small', href: 'term/?arg=' + encodeURIComponent(p.session), target: '_blank', onclick: view.onExternal }, 'Console'),
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => view.onRcRestart(p.session) }, 'Restart')),
      asking ? h('div', { class: 'rc-asking' }, h('span', { class: 'q' }, 'Waiting for an answer to a y/n question.'), h('button', { type: 'button', class: 'btn primary small', onclick: () => view.onAnswer(p.session) }, 'Answer \u201cy\u201d')) : null,
      p.console ? h('div', { class: 'console-wrap' },
        h('button', { type: 'button', class: 'console-toggle', 'aria-expanded': String(open), onclick: () => view.onConsole(p.session) }, icon('chevronRight', 14, 'chev'), open ? 'Hide console' : 'Show console'),
        open ? h('pre', { class: 'console', tabindex: '0' }, p.console) : null)
        : h('p', { class: 'small-print', style: 'margin:0 16px 12px' }, p.running ? '' : 'Not running yet. The watchdog starts it within ~15s.'));
  };
  const claude = h('div', { class: 'card' },
    h('div', { class: 'card-h' }, toolBadge('claude', 'lg'), h('div', { class: 'grow' }, h('h3', null, 'Claude Code'), h('div', { class: 'sub' }, a.claude.signedIn ? `Remote Control \u00b7 ${a.claude.account || 'signed in'}` : 'Not signed in yet')),
      h('span', { class: 'dot ' + (!a.claude.signedIn ? 'bad' : anyRunning ? 'ok' : 'warn') })),
    h('ul', { class: 'rc-list' }, projects.map(rcRow)),
    h('div', { class: 'card-pad', style: 'border-top:1px solid var(--line)' },
      h('a', { class: 'btn primary', href: 'https://claude.ai/code', target: '_blank', rel: 'noopener', style: 'width:100%', onclick: view.onExternal }, 'Open claude.ai/code', icon('external', 15)),
      h('p', { class: 'small-print' }, 'Sessions appear in claude.ai/code, the Claude mobile app and the desktop app\u2019s Code tab. They keep running when every client is closed.')));
  const codex = h('div', { class: 'card' },
    h('div', { class: 'card-h' }, toolBadge('codex', 'lg'), h('div', { class: 'grow' }, h('h3', null, 'Codex'), h('div', { class: 'sub' }, a.codex.signedIn ? 'Signed in' : 'Not signed in: run roost-setup codex')), h('span', { class: 'dot ' + (a.codex.signedIn ? 'ok' : 'warn') })),
    h('div', { class: 'card-pad', style: 'border-top:1px solid var(--line);display:flex;gap:8px;flex-wrap:wrap' },
      h('a', { class: 'btn', href: 'term/?arg=codex', target: '_blank', onclick: view.onExternal }, icon('terminal', 15), 'Codex terminal'),
      h('a', { class: 'btn ghost', href: 'code/', target: '_blank', onclick: view.onExternal }, icon('code', 15), 'In VS Code')));

  const lnk = (ic, t, d, href, state) => h('li', null, h('a', { class: 'lnk', href, target: '_blank', onclick: view.onExternal },
    h('span', { class: 'lnk-ic' }, icon(ic, 17)), h('span', { class: 'grow' }, h('div', { class: 'lnk-t' }, t), h('div', { class: 'lnk-d' }, d)), state || null, icon('external', 15, 'ext')));
  const tools = h('div', { class: 'card' }, h('ul', { class: 'lnk-list' },
    lnk('code', 'VS Code', 'Edit, review diffs and view media in /workspace', 'code/'),
    lnk('folderOpen', 'Files', 'Upload, download, preview and share files', 'files/'),
    lnk('terminal', 'Terminal', s.rc.sessions.length ? `tmux: ${s.rc.sessions.slice(0, 3).join(', ')}${s.rc.sessions.length > 3 ? '\u2026' : ''}` : 'Persistent tmux shell', 'term/'),
    lnk('spark', 'Claude CLI', 'claude in a persistent terminal', 'term/?arg=claude'),
    lnk('monitor', 'Browser (VNC)', 'The Chromium agents drive; jump in for logins', 'vnc/vnc.html?path=vnc/websockify&autoconnect=true&resize=scale&reconnect=true',
      h('span', { class: 'lnk-state' }, h('span', { class: 'dot ' + (s.browser.up ? 'ok' : 'bad') }), s.browser.up ? 'running' : 'down'))));

  const host = location.hostname || 'roost.local';
  const sshCmd = a.ssh.enabled ? `ssh -p ${a.ssh.port} roost@${host}` : 'SSH is disabled (ROOST_SSH=false).';
  const connect = h('div', { class: 'card card-pad' },
    h('div', { style: 'display:flex;align-items:center;gap:10px' }, h('span', { class: 'lnk-ic' }, icon('key', 17)), h('div', null, h('div', { class: 'lnk-t' }, 'SSH'), h('div', { class: 'lnk-d' }, a.ssh.enabled ? (a.ssh.authorizedKeys ? plural(a.ssh.authorizedKeys, 'authorized key') : 'No keys yet: password login is off, add a key first') : 'Disabled'))),
    h('div', { class: 'cmd-row' }, h('code', null, sshCmd), a.ssh.enabled ? copyButton(() => sshCmd, 'Copy', 'Copy SSH command') : null),
    h('p', { class: 'small-print' }, 'Then ', h('code', null, 'tmux attach -t rc-workspace'), ' for the Remote Control console, or just run ', h('code', null, 'claude'), ' / ', h('code', null, 'codex'), '.'));

  const versions = [s.versions.claude && 'claude ' + s.versions.claude.replace(/\s*\(.*\)/, ''), s.versions.codex, s.versions.codeServer && 'code-server ' + s.versions.codeServer.split(' ')[0]].filter(Boolean).join(' \u00b7 ');
  const services = h('div', { class: 'card' }, h('ul', { class: 'svc-list' }, s.services.map((x) => h('li', { class: 'svc' },
    h('div', { class: 'grow' }, h('div', { class: 'svc-name' }, x.name, h('span', { class: 'pill ' + x.state }, x.state.toLowerCase())), h('div', { class: 'svc-detail', title: x.detail }, x.detail)),
    h('div', { class: 'svc-actions' },
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => view.onLog(x.name) }, 'Log'),
      x.name === 'dash' || x.name === 'caddy' ? null : h('button', { type: 'button', class: 'btn ghost small', disabled: x.state === 'STARTING', onclick: () => view.onRestart(x.name) }, 'Restart'))))));

  const bad = s.services.filter((x) => x.state !== 'RUNNING').length;
  return [
    steps.length ? sec('Needs attention', plural(steps.length, 'item'), attention) : null,
    usageCard ? sec('Plan usage', view.usage.loading ? 'checking\u2026' : h('button', { type: 'button', class: 'link-btn us-refresh', onclick: view.onUsageRefresh }, 'Refresh'), usageCard) : null,
    h('div', { class: 'ov-cols' },
      h('div', { class: 'ov-col' }, sec('Agents', null, h('div', { style: 'display:grid;gap:12px' }, claude, codex))),
      h('div', { class: 'ov-col' }, sec('Open', null, tools), sec('Connect from elsewhere', null, connect))),
    sec('Services', bad ? `${bad} not running` : 'all running', services, h('p', { class: 'versions', style: 'margin:8px 4px 0' }, versions)),
    steps.length ? null : sec('Setup', null, attention),
  ].filter(Boolean);
}

/* ======================================================= 8b. plan usage */
// "3h 52m", "2d 7h", "14m": time until a window resets.
function fmtUntil(ms) {
  if (ms == null || isNaN(ms)) return '';
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const hh = Math.floor(m / 60);
  if (hh < 24) return `${hh}h ${m % 60}m`;
  return `${Math.floor(hh / 24)}d ${hh % 24}h`;
}
const PLAN_NAMES = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', plus: 'Plus', prolite: 'Pro Lite', business: 'Business', edu: 'Edu' };
const planName = (p) => (p ? PLAN_NAMES[p] || p.charAt(0).toUpperCase() + p.slice(1) : null);

// One bar per window: how much is used, with a tick for how much of the window has gone by.
// Left of the tick is under pace; past it, you'll run out before the window resets.
function usageWindow(w) {
  const pct = Math.max(0, Math.min(100, w.percent));
  const reset = w.resetsAt ? new Date(w.resetsAt) : null;
  const left = reset ? reset - Date.now() : null;
  const elapsed = reset && w.mins ? Math.max(0, Math.min(100, 100 - (left / (w.mins * 60000)) * 100)) : null;
  const level = pct >= 90 ? 'bad' : pct >= 75 || (elapsed != null && pct > elapsed + 15 && pct >= 40) ? 'warn' : 'ok';
  const resetText = reset ? (left <= 0 ? 'Resetting now' : `Resets in ${fmtUntil(left)}`) : '';
  return h('li', { class: 'us-row' },
    h('div', { class: 'us-top' }, h('span', { class: 'us-label' }, w.label), h('span', { class: 'us-pct ' + level }, `${Math.round(pct)}%`, h('span', { class: 'muted' }, ' used'))),
    h('div', { class: 'us-bar ' + level, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': `${w.label}: ${Math.round(pct)}% used` },
      h('span', { class: 'us-fill', style: `width:${pct}%` }),
      elapsed != null ? h('span', { class: 'us-pace', style: `left:${elapsed}%`, title: `${Math.round(elapsed)}% of this window has gone by` }) : null),
    h('div', { class: 'us-meta' },
      h('span', { title: reset ? reset.toLocaleString() : '' }, resetText),
      elapsed != null ? h('span', null, `${Math.round(elapsed)}% of the window gone`) : null));
}

function renderUsage(u, s, view) {
  const a = s.accounts;
  const block = (tool, name, data, signedIn) => {
    const head = h('div', { class: 'card-h' }, toolBadge(tool, 'lg'),
      h('div', { class: 'grow' }, h('h3', null, name), h('div', { class: 'sub' }, data && data.plan ? `${planName(data.plan)} plan` : signedIn ? 'Subscription' : 'Not signed in')));
    let body;
    if (!signedIn && !data) body = h('p', { class: 'small-print us-msg' }, `Sign in to ${name} to see its plan usage.`);
    else if (data === undefined) body = h('p', { class: 'small-print us-msg' }, spinner(13), ' Checking\u2026');
    else if (!data) body = h('p', { class: 'small-print us-msg' }, 'No subscription sign-in found.');
    else if (data.error) body = h('p', { class: 'small-print us-msg' }, icon('info', 14), ' ', data.error);
    else body = h('ul', { class: 'us-list' }, data.windows.map(usageWindow),
      data.extra ? h('li', { class: 'us-row us-extra' }, `Extra usage: ${Math.round(data.extra.percent)}% of the monthly limit`) : null);
    return h('div', { class: 'card us-card' }, head, body);
  };
  return h('div', null,
    h('div', { class: 'us-grid' },
      block('claude', 'Claude', u.claude, a.claude.signedIn),
      block('codex', 'Codex', u.codex, a.codex.signedIn)),
    h('p', { class: 'small-print', style: 'margin:8px 4px 0' }, 'The tick on each bar shows how much of the window has gone by. A bar past its tick is using the allowance faster than the window passes. Usage counts everything on the account, not just roost.'));
}

/* ======================================================= 9. sheets + menus */
// One <dialog> for sheets: a bottom sheet under 640px, a centred dialog above.
function openSheet({ title, body, foot, wide, onClose }) {
  const d = $('#sheet');
  d.className = 'sheet' + (wide ? ' wide' : '');
  d.replaceChildren(h('div', { class: 'grab', 'aria-hidden': 'true' }),
    h('div', { class: 'sheet-head' }, h('h2', { id: 'sheet-title' }, title), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => d.close() }, icon('x', 20))),
    h('div', { class: 'sheet-body' }, body), foot ? h('div', { class: 'sheet-foot' }, foot) : null);
  d.onclose = () => { onClose && onClose(); };
  d.showModal();
  return d;
}
// Menu: anchored popover on desktop, bottom sheet on phones. items: [{label, icon, onClick, danger, href, check, swatch} | 'sep' | {title}]
function openMenu(anchor, items, title) {
  const d = $('#menu');
  const close = () => d.close();
  d.replaceChildren(h('div', { class: 'grab', 'aria-hidden': 'true' }),
    h('div', { class: 'sheet-head' }, h('h2', null, title || 'Actions'), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('x', 20))),
    h('ul', { class: 'menu-list', role: 'menu' }, items.map((it) => {
      if (it === 'sep') return h('li', { class: 'menu-sep', role: 'separator' });
      if (it.title) return h('li', { class: 'menu-title' }, it.title);
      const kids = [it.swatch ? h('span', { class: 'swatch', style: `--c:${safeColor(it.swatch)}` }) : icon(it.icon || 'chevronRight', 18), h('span', null, it.label), it.check ? icon('check', 16, 'check') : null];
      const attrs = { class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem' };
      return h('li', { role: 'none' }, it.href
        ? h('a', { ...attrs, href: it.href, target: '_blank', onclick: (e) => { close(); it.onClick && it.onClick(e); } }, kids)
        : h('button', { ...attrs, type: 'button', onclick: () => { close(); it.onClick && it.onClick(); } }, kids));
    })));
  d.style.top = d.style.left = '';
  d.showModal();
  if (matchMedia('(min-width: 640px)').matches && anchor) {
    const r = anchor.getBoundingClientRect(), mw = d.offsetWidth, mh = d.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw));
    const top = r.bottom + 4 + mh > window.innerHeight - 8 ? Math.max(8, r.top - mh - 4) : r.bottom + 4;
    d.style.left = left + 'px'; d.style.top = top + 'px';
  } else { d.style.top = ''; d.style.left = ''; }
  d.querySelector('.menu-item')?.focus();
}
for (const id of ['#sheet', '#menu']) {
  const d = $(id);
  // Close on backdrop click (the dialog element itself is the backdrop hit target).
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
}
const PROJECT_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#06b6d4', '#ec4899', '#ef4444', '#eab308', '#64748b'];
// New project / Edit project form. onSave(values) may throw an Error to show inline.
function openProjectForm(p, onSave, onRemove) {
  const isNew = !p;
  const name = h('input', { class: 'input', id: 'pf-name', value: p ? p.name : '', autocomplete: 'off', required: true, placeholder: 'my-project' });
  const seg = (nameAttr, opts, value, cls = '') => h('div', { class: 'seg ' + cls, role: 'radiogroup' }, opts.map((o) => h('label', { class: 'seg-opt' },
    h('input', { type: 'radio', name: nameAttr, value: o.v, checked: o.v === value, disabled: o.disabled }),
    h('span', { class: 'seg-ic' }, icon(o.icon, 17)), h('span', null, h('div', { class: 'seg-t' }, o.t), h('div', { class: 'seg-d' }, o.d)))));
  const source = seg('source', [
    { v: 'folder', t: 'Empty folder', d: 'A new folder in /workspace', icon: 'folder' },
    { v: 'git', t: 'Clone a repo', d: 'From a git URL', icon: 'branch' },
    { v: 'paths', t: 'Group folders', d: 'Existing folders together', icon: 'grid' },
  ], 'folder');
  const gitUrl = h('input', { class: 'input', id: 'pf-git', placeholder: 'https://github.com/you/repo.git', autocomplete: 'off', inputmode: 'url', autocapitalize: 'off', spellcheck: 'false' });
  const folder = h('input', { class: 'input', id: 'pf-folder', placeholder: 'my-project', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const paths = h('textarea', { class: 'input', id: 'pf-paths', rows: '3', placeholder: '/workspace/api\n/workspace/web', autocapitalize: 'off', spellcheck: 'false' });
  paths.value = p ? p.paths.join('\n') : '';
  const color = p ? p.color : PROJECT_COLORS[0];
  const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour' }, PROJECT_COLORS.map((c, k) => h('label', { class: 'swatch-pick', style: `--c:${c}`, title: c },
    h('input', { type: 'radio', name: 'color', value: c, checked: c === color, 'aria-label': 'Colour ' + (k + 1) }), h('span'))));
  const pin = h('input', { type: 'checkbox', class: 'switch', id: 'pf-pin', checked: !!(p && p.pinned) });
  const rcMode = p && p.rc && p.rc.enabled ? p.rc.mode : 'off';
  const rc = p && p.paths.length ? seg('rc', [
    { v: 'off', t: 'Off', d: 'Use the main /workspace server', icon: 'x' },
    { v: 'same-dir', t: 'Same folder', d: 'Sessions share the project folder', icon: 'folder' },
    { v: 'worktree', t: 'Worktree each', d: p.repo ? 'Every session gets its own git worktree' : 'Needs a git repository', icon: 'fork', disabled: !p.repo },
    { v: 'session', t: 'Single session', d: 'Serve one session only', icon: 'message' },
  ], rcMode, 'rc') : null;
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const fld = (label, input, help, id) => h('div', { class: 'field', id }, h('label', { class: 'lbl', for: input.id || null }, label), input, help ? h('p', { class: 'help' }, help) : null);
  const fGit = fld('Repository URL', gitUrl, null, 'pf-git-wrap');
  const fFolder = fld('Folder name in /workspace', folder, null, 'pf-folder-wrap');
  const fPaths = fld('Folders', paths, 'One per line, inside /workspace.', 'pf-paths-wrap');
  const setSource = (v) => { fGit.hidden = v !== 'git'; fFolder.hidden = v === 'paths'; fPaths.hidden = v !== 'paths'; folder.placeholder = v === 'git' ? 'defaults to the repository name' : 'my-project'; };
  if (isNew) { source.addEventListener('change', (e) => setSource(e.target.value)); setSource('folder'); }
  const form = h('form', { id: 'proj-form', style: 'display:grid;gap:18px', novalidate: true },
    fld('Name', name),
    isNew ? h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Start from'), source) : null,
    isNew ? [fGit, fFolder, fPaths] : fld('Folders', paths, 'One per line, inside /workspace.'),
    h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Colour'), swatches),
    rc ? h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Remote Control server'), rc, h('p', { class: 'help' }, 'A per-project server shows this project\u2019s sessions in claude.ai/code separately.')) : null,
    h('label', { class: 'switch-row', for: 'pf-pin' }, h('span', { class: 'grow' }, h('div', { class: 't' }, 'Pin to top'), h('div', { class: 'd' }, 'Keep this project above the rest')), pin),
    err);
  const save = h('button', { type: 'submit', class: 'btn primary', form: 'proj-form' }, isNew ? 'Create project' : 'Save');
  const foot = [
    p && !p.implicit ? h('button', { type: 'button', class: 'btn ghost danger', onclick: () => { if (confirm(`Remove the \u201c${p.name}\u201d grouping? Its folders and chats are not touched.`)) { onRemove(p); $('#sheet').close(); } } }, icon('trash', 15), 'Remove grouping') : null,
    h('span', { class: 'spacer', hidden: true }),
    h('button', { type: 'button', class: 'btn', onclick: () => $('#sheet').close() }, 'Cancel'), save,
  ];
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const v = {
      name: name.value.trim(), color: (form.querySelector('input[name=color]:checked') || {}).value, pinned: pin.checked,
      paths: paths.value.split('\n').map((x) => x.trim()).filter(Boolean),
      source: isNew ? (form.querySelector('input[name=source]:checked') || {}).value : null,
      gitUrl: gitUrl.value.trim(), folder: folder.value.trim(), rc: rc ? (form.querySelector('input[name=rc]:checked') || {}).value : null,
    };
    save.disabled = true;
    if (v.source === 'git') save.textContent = 'Cloning\u2026';
    try { await onSave(v); $('#sheet').close(); }
    catch (x) { err.textContent = x.message; err.hidden = false; }
    finally { save.disabled = false; save.textContent = isNew ? 'Create project' : 'Save'; }
  });
  openSheet({ title: isNew ? 'New project' : `Edit ${p.name}`, body: form, foot });
  if (matchMedia('(pointer: fine)').matches) name.focus();
}

