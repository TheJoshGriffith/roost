'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dot = (el, cls) => { el.className = 'dot ' + (cls || ''); };

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'X-Roost': '1' }, body: body ?? '' });
  let j = {};
  try { j = await res.json(); } catch {}
  if (!res.ok) throw new Error(j.error || j.output || res.statusText);
  return j;
}

function renderSetup(s) {
  const a = s.accounts;
  const steps = [];
  if (!a.claude.signedIn) {
    steps.push('Sign in to Claude: open the <a href="term/" target="_blank">terminal</a> and run <code>roost-setup claude</code>.');
  }
  const waiting = (s.rc.projects || []).find((p) => /\(y\/n\)/i.test(p.console || ''));
  if (waiting) steps.push(`Remote Control is asking for confirmation in <b>${esc(waiting.dir)}</b>; answer it below.`);
  if (!a.codex.signedIn) steps.push('Optional: sign in to Codex with <code>roost-setup codex</code>.');
  if (!a.github.signedIn) steps.push('Optional: sign in to GitHub with <code>roost-setup gh</code>.');
  if (a.ssh.enabled && a.ssh.authorizedKeys === 0) steps.push('Optional: add an SSH key (<code>roost-setup ssh</code>) to connect from terminals and the desktop app.');
  $('setup').hidden = steps.length === 0;
  $('setup-list').innerHTML = steps.map((x) => `<li>${x}</li>`).join('');
}

function renderClaude(s) {
  const c = s.accounts.claude;
  const projects = s.rc.projects || [];
  const anyRunning = projects.some((p) => p.running);
  dot($('claude-dot'), !c.signedIn ? 'bad' : anyRunning ? 'ok' : 'warn');
  $('claude-account').textContent = c.signedIn
    ? `Signed in${c.account ? ' as ' + c.account : ''}. ${c.browserMcp ? 'Browser MCP connected.' : ''}`
    : 'Not signed in yet.';

  const list = $('rc-list');
  const html = projects.map((p) => {
    const asking = /\(y\/n\)/i.test(p.console || '');
    return `<div class="rc" data-session="${esc(p.session)}">
      <div class="rc-head">
        <span class="dot ${p.running ? 'ok' : 'bad'}"></span>
        <span class="title">${esc(p.name || p.dir)}</span>
        <span class="meta">${esc(p.dir)} · ${esc(p.mode)}</span>
        <span class="spacer"></span>
        ${asking ? `<button class="btn small primary" data-act="yes">Answer “y”</button>` : ''}
        <a class="btn small" href="term/?arg=${encodeURIComponent(p.session)}" target="_blank">Console</a>
        <button class="btn small" data-act="restart">Restart</button>
      </div>
      ${p.console ? `<pre class="console">${esc(p.console)}</pre>` : `<p class="muted small">${p.running ? '' : 'Not running yet. The watchdog starts it within ~15s.'}</p>`}
    </div>`;
  }).join('') || '<p class="muted small">No projects configured in <code>/config/roost/rc-projects.conf</code>.</p>';
  // Only touch the DOM when something changed, so text selection survives refreshes.
  if (list.dataset.html !== html) {
    const consoles = [...list.querySelectorAll('.console')].map((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
    list.innerHTML = html;
    list.dataset.html = html;
    list.querySelectorAll('.console').forEach((el, i) => { if (consoles[i] !== false) el.scrollTop = el.scrollHeight; });
  }
}

function renderRest(s) {
  const a = s.accounts;
  $('name').textContent = s.name;
  document.title = s.name;
  $('ver').textContent = s.versions.roost;

  dot($('codex-dot'), a.codex.signedIn ? 'ok' : 'warn');
  $('codex-state').textContent = a.codex.signedIn ? 'Signed in.' : 'Not signed in: run roost-setup codex.';

  dot($('browser-dot'), s.browser.up ? 'ok' : 'bad');
  $('browser-state').textContent = s.browser.up ? `Running (${s.browser.version || 'Chromium'}).` : 'Not running.';

  $('tmux-sessions').textContent = s.rc.sessions.length ? 'tmux sessions: ' + s.rc.sessions.join(', ') : '';

  const host = location.hostname;
  $('ssh-cmd').textContent = a.ssh.enabled ? `ssh -p ${a.ssh.port} roost@${host}` : 'SSH is disabled (ROOST_SSH=false).';
  $('ssh-state').textContent = a.ssh.enabled
    ? (a.ssh.authorizedKeys ? `${a.ssh.authorizedKeys} authorized key(s).` : 'No authorized keys yet: password login is disabled, so add a key first.')
    : '';

  $('versions').textContent = [s.versions.claude && 'claude ' + s.versions.claude.replace(/\s*\(.*\)/, ''), s.versions.codex, s.versions.codeServer && 'code-server ' + s.versions.codeServer.split(' ')[0]]
    .filter(Boolean).join(' · ');

  const rows = s.services.map((x) => `<tr>
      <td>${esc(x.name)}</td>
      <td><span class="pill ${esc(x.state)}">${esc(x.state.toLowerCase())}</span></td>
      <td class="hide-sm muted small">${esc(x.detail)}</td>
      <td><button class="btn small" data-log="${esc(x.name)}">Log</button>
          ${x.name === 'dash' || x.name === 'caddy' ? '' : `<button class="btn small" data-restart="${esc(x.name)}">Restart</button>`}</td>
    </tr>`).join('');
  const body = $('svc-body');
  if (body.dataset.html !== rows) { body.innerHTML = rows; body.dataset.html = rows; }
}

let failures = 0;
async function refresh() {
  try {
    const res = await fetch('api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.statusText);
    const s = await res.json();
    renderSetup(s);
    renderClaude(s);
    renderRest(s);
    failures = 0;
    $('live').textContent = 'live · ' + new Date().toLocaleTimeString();
    $('live').classList.remove('stale');
  } catch (e) {
    failures++;
    $('live').textContent = 'connection lost, retrying…';
    $('live').classList.add('stale');
  }
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button');
  // Only the Overview tab and its log dialog belong to this handler (Projects has its own).
  if (!t || !t.closest('#view-overview, #log-dialog')) return;
  try {
    if (t.dataset.restart) {
      t.disabled = true;
      await post(`api/services/${t.dataset.restart}/restart`);
    } else if (t.dataset.log) {
      const name = t.dataset.log;
      $('log-title').textContent = name + ' log';
      $('log-body').textContent = (await (await fetch(`api/logs/${name}`)).text()) || '(empty)';
      $('log-dialog').showModal();
      $('log-body').scrollTop = $('log-body').scrollHeight;
    } else if (t.dataset.act) {
      const sess = t.closest('.rc').dataset.session;
      t.disabled = true;
      if (t.dataset.act === 'restart') await post(`api/rc/${sess}/restart`);
      if (t.dataset.act === 'yes') await post(`api/rc/${sess}/keys`, 'y');
    } else if (t.id === 'log-close') {
      $('log-dialog').close();
    }
  } catch (e) {
    alert(e.message);
  } finally {
    t.disabled = false;
    refresh();
  }
});

refresh();
setInterval(refresh, 5000);
