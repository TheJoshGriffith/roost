'use strict';
// Plan usage: how much of each subscription window (5 hours, 7 days, ...) has
// been used, for the Overview page.
//
// Claude: the endpoint behind Claude Code's /usage screen, called with the
//   OAuth token Claude Code stores. Undocumented, so everything is read
//   defensively. The token is only read, never refreshed: refreshing rotates it,
//   which would sign Claude Code out. Claude Code renews it whenever it runs.
// Codex: `account/rateLimits/read` on a short-lived `codex app-server`.
//
// Results are cached for a minute so the Overview can poll freely.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOME = process.env.HOME || '/config/home';
const CODEX_BIN = process.env.ROOST_CODEX_BIN || 'codex';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TTL = 60 * 1000;
const MIN_REFRESH = 10 * 1000;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

function windowLabel(mins) {
  if (!mins) return 'Window';
  if (mins % 1440 === 0) return mins === 1440 ? '1 day' : `${mins / 1440} days`;
  if (mins % 60 === 0) return mins === 60 ? '1 hour' : `${mins / 60} hours`;
  return `${mins} minutes`;
}

// ------------------------------------------------------------------ Claude
async function claude() {
  const cred = readJson(path.join(HOME, '.claude/.credentials.json'));
  const oauth = cred && cred.claudeAiOauth;
  const token = (oauth && oauth.accessToken) || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return null; // not signed in; the Overview says so elsewhere
  const plan = (oauth && oauth.subscriptionType) || null;
  if (oauth && oauth.expiresAt && oauth.expiresAt < Date.now()) {
    return { plan, error: 'Claude’s sign-in token has expired. It renews the next time Claude runs (a chat, the terminal, or Remote Control).' };
  }
  let res;
  try {
    res = await fetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'roost-dashboard' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return { plan, error: `Couldn’t reach Anthropic: ${e.message}` };
  }
  if (res.status === 401) return { plan, error: 'Claude’s sign-in token was refused. It renews the next time Claude runs.' };
  if (res.status === 403) return { plan, error: 'This sign-in can’t read plan usage (a token from claude setup-token only allows inference).' };
  if (!res.ok) return { plan, error: `Anthropic answered ${res.status}.` };
  const j = await res.json().catch(() => null);
  if (!j || typeof j !== 'object') return { plan, error: 'Unexpected answer from Anthropic.' };

  const windows = [];
  const add = (id, label, mins, w) => {
    if (!w || num(w.utilization) == null) return;
    windows.push({ id, label, mins, percent: w.utilization, resetsAt: iso(w.resets_at) });
  };
  add('five_hour', '5 hours', 300, j.five_hour);
  add('seven_day', '7 days', 10080, j.seven_day);
  // Per-model weekly limits, e.g. a separate allowance for one model.
  for (const l of Array.isArray(j.limits) ? j.limits : []) {
    if (!l || l.kind !== 'weekly_scoped' || num(l.percent) == null) continue;
    const name = l.scope && ((l.scope.model && l.scope.model.display_name) || (l.scope.surface && l.scope.surface.display_name));
    windows.push({ id: 'weekly:' + (name || windows.length), label: `7 days · ${name || 'scoped'}`, mins: 10080, percent: l.percent, resetsAt: iso(l.resets_at) });
  }
  // Older shape: named per-model weekly windows.
  if (!windows.some((w) => w.id.startsWith('weekly:'))) {
    add('seven_day_opus', '7 days · Opus', 10080, j.seven_day_opus);
    add('seven_day_sonnet', '7 days · Sonnet', 10080, j.seven_day_sonnet);
  }
  const x = j.extra_usage;
  const extra = x && x.is_enabled && num(x.utilization) != null ? { percent: x.utilization } : null;
  if (!windows.length) return { plan, error: 'Anthropic didn’t report any usage windows for this account.' };
  return { plan, windows, extra };
}

// ------------------------------------------------------------------ Codex
function codexRpc(method, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = spawn(CODEX_BIN, ['app-server'], { cwd: HOME, stdio: ['pipe', 'pipe', 'ignore'] }); } catch (e) { reject(e); return; }
    const send = (m) => { try { proc.stdin.write(JSON.stringify(m) + '\n'); } catch {} };
    let buf = '';
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('codex app-server didn’t answer')), timeoutMs);
    proc.on('error', (e) => finish(e));
    proc.on('exit', () => finish(new Error('codex app-server exited')));
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ method: 'initialized', params: {} }); send({ id: 2, method, params: {} }); }
        else if (m.id === 2) m.error ? finish(new Error(m.error.message || 'request failed')) : finish(null, m.result);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'roost', title: 'roost', version: '1' }, capabilities: null } });
  });
}

async function codex() {
  const auth = readJson(path.join(HOME, '.codex/auth.json'));
  if (!auth) return null;
  if (auth.auth_mode && auth.auth_mode !== 'chatgpt') return { plan: null, error: 'Codex is signed in with an API key, which has no plan windows.' };
  let r;
  try { r = await codexRpc('account/rateLimits/read'); } catch (e) { return { plan: null, error: `Couldn’t ask Codex: ${e.message}` }; }
  const rl = r && r.rateLimits;
  if (!rl) return { plan: null, error: 'Codex didn’t report any limits.' };
  const windows = [];
  for (const [id, w] of [['primary', rl.primary], ['secondary', rl.secondary]]) {
    if (!w || num(w.usedPercent) == null) continue;
    const mins = num(w.windowDurationMins);
    windows.push({ id, label: windowLabel(mins), mins, percent: w.usedPercent, resetsAt: num(w.resetsAt) ? new Date(w.resetsAt * 1000).toISOString() : null });
  }
  windows.sort((a, b) => (a.mins || 0) - (b.mins || 0));
  if (!windows.length) return { plan: rl.planType || null, error: 'Codex didn’t report any usage windows for this account.' };
  return { plan: rl.planType || null, windows, limited: rl.rateLimitReachedType || null };
}

// ------------------------------------------------------------------ cache
const cache = { claude: { at: 0, value: undefined, pending: null }, codex: { at: 0, value: undefined, pending: null } };
const FETCH = { claude, codex };

function get(tool, refresh) {
  const c = cache[tool];
  const age = Date.now() - c.at;
  if (c.value !== undefined && (age < MIN_REFRESH || (!refresh && age < TTL))) return Promise.resolve(c.value);
  if (!c.pending) {
    c.pending = FETCH[tool]()
      .catch((e) => ({ plan: null, error: String((e && e.message) || e) }))
      .then((v) => { c.value = v ? { ...v, at: new Date().toISOString() } : null; c.at = Date.now(); c.pending = null; return c.value; });
  }
  return c.pending;
}

async function all(refresh = false) {
  const [cl, cx] = await Promise.all([get('claude', refresh), get('codex', refresh)]);
  return { claude: cl, codex: cx };
}

module.exports = { all };
