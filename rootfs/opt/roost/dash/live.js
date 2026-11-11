'use strict';
// Live chats: roost's own chat interface drives Claude Code (through the Agent SDK,
// using the installed `claude` and its login) and Codex (through `codex app-server`).
// Both are translated into one small event model that the browser renders:
//
//   status      { status }                      idle | starting | thinking | responding | tool | waiting | error | closed
//   session     { key, id, model, mode }        a new chat got its real id
//   user        { text }
//   delta       { text }                        streaming assistant text
//   text        { text }                        a finished assistant text block
//   reasoning   { text }                        thinking / reasoning summary (may be empty)
//   tool        { id, name, input }             a tool call started
//   tool-output { id, text }                    streaming tool output (Codex commands)
//   tool-result { id, ok, text, patch, diff, exitCode }
//   permission  { id, name, input, title, description, always }   waiting for approval
//   permission-resolved { id, decision }
//   result      { ok, durationMs, cost, tokens:{input, output, cached}, error }
//   notice      { text, level }
//
// Every event gets a sequence number so a reconnecting browser can catch up.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const chats = require('./chats');

const CLAUDE_BIN = process.env.ROOST_CLAUDE_BIN || '/usr/local/bin/claude';
const CODEX_BIN = process.env.ROOST_CODEX_BIN || 'codex';
const MAX_EVENTS = 3000;
const IDLE_CLOSE_MS = 45 * 60 * 1000;
const TEXT_LIMIT = 20000;

const sessions = new Map(); // key -> LiveSession (a session may be registered under several keys)
const watchers = new Map(); // key -> Set<res> (SSE connections)

const clip = (s, n = TEXT_LIMIT) => {
  s = s == null ? '' : String(s);
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s;
};

function toText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && (c.text || (c.type === 'image' ? '[image]' : ''))) || '').join('\n');
  if (typeof content === 'object') return content.text || JSON.stringify(content);
  return String(content);
}

// ------------------------------------------------------------------ SSE fan-out
function watch(key, res, since) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  if (!watchers.has(key)) watchers.set(key, new Set());
  watchers.get(key).add(res);
  const s = sessions.get(key);
  if (s) {
    for (const ev of s.events) if (ev.seq > since) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    res.write(`data: ${JSON.stringify({ t: 'snapshot', status: s.status, model: s.model, mode: s.mode, live: true, seq: s.seq })}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ t: 'snapshot', status: 'offline', live: false, seq: 0 })}\n\n`);
  }
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  res.on('close', () => {
    clearInterval(ping);
    const set = watchers.get(key);
    if (set) { set.delete(res); if (!set.size) watchers.delete(key); }
  });
}

// ------------------------------------------------------------------ base session
class LiveSession {
  constructor({ tool, key, id, cwd, model, mode }) {
    this.tool = tool;
    this.keys = new Set([key]);
    this.id = id || null;
    this.cwd = cwd;
    this.model = model || '';
    this.mode = mode || (tool === 'claude' ? 'default' : 'ask');
    this.events = [];
    this.seq = 0;
    this.status = 'starting';
    this.pending = new Map();
    this.lastActive = Date.now();
    this.turnStarted = 0;
  }

  get key() { return `${this.tool}:${this.id || [...this.keys][0].split(':')[1]}`; }

  addKey(key) {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    sessions.set(key, this);
  }

  emit(ev) {
    ev.seq = ++this.seq;
    ev.at = Date.now();
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    const sent = new Set();
    for (const k of this.keys) for (const res of watchers.get(k) || []) if (!sent.has(res)) { sent.add(res); res.write(line); }
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit({ t: 'status', status });
  }

  answer(id, decision, message) {
    const p = this.pending.get(id);
    if (!p) throw Object.assign(new Error('that request is no longer pending'), { status: 409 });
    this.pending.delete(id);
    p.resolve(decision, message);
    this.emit({ t: 'permission-resolved', id, decision, message: message || null });
    if (!this.pending.size) this.setStatus('tool');
  }

  touch() { this.lastActive = Date.now(); }
}

// ------------------------------------------------------------------ Claude (Agent SDK)
let sdkPromise = null;
const loadSdk = () => (sdkPromise = sdkPromise || import('@anthropic-ai/claude-agent-sdk'));

class ClaudeSession extends LiveSession {
  async start() {
    const { query } = await loadSdk();
    // Everything belonging to one SDK process lives on `run`, so a restart can't be
    // confused by the previous process winding down.
    const run = { queue: [], wake: null, ended: false, abort: new AbortController() };
    this.run = run;
    async function* input() {
      while (!run.ended) {
        if (run.queue.length) { yield run.queue.shift(); continue; }
        await new Promise((r) => { run.wake = r; });
        run.wake = null;
      }
    }
    const stderr = [];
    const q = query({
      prompt: input(),
      options: {
        cwd: this.cwd,
        resume: this.id || undefined,
        model: this.model || undefined,
        permissionMode: this.mode,
        includePartialMessages: true,
        pathToClaudeCodeExecutable: CLAUDE_BIN,
        // Behave like the CLI: Claude Code's own system prompt, plus user/project settings,
        // CLAUDE.md files and MCP servers (e.g. roost's shared browser).
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        abortController: run.abort,
        stderr: (d) => { stderr.push(String(d)); if (stderr.length > 50) stderr.shift(); },
        canUseTool: (name, toolInput, opts) => this.askPermission(name, toolInput, opts),
      },
    });
    run.q = q;
    this.setStatus('idle');
    (async () => {
      try {
        for await (const m of q) if (this.run === run) this.onMessage(m);
        if (this.run === run) this.setStatus('closed');
      } catch (e) {
        if (this.run === run && !run.ended) {
          const detail = stderr.join('').trim().split('\n').slice(-3).join(' ');
          this.emit({ t: 'notice', level: 'error', text: `Claude stopped: ${e.message}${detail ? ` (${detail})` : ''}` });
          this.setStatus('error');
        }
      } finally {
        run.q = null;
        if (this.run === run) {
          for (const [id, p] of this.pending) { p.resolve('cancel'); this.emit({ t: 'permission-resolved', id, decision: 'cancelled' }); }
          this.pending.clear();
        }
      }
    })();
  }

  get running() { return !!(this.run && this.run.q && !this.run.ended); }

  send(text) {
    this.touch();
    this.turnStarted = this.turnStarted || Date.now();
    this.emit({ t: 'user', text });
    this.setStatus('thinking');
    this.run.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: this.id || '' });
    if (this.run.wake) this.run.wake();
  }

  askPermission(name, toolInput, opts) {
    const id = opts.toolUseID || crypto.randomUUID();
    const always = (opts.suggestions || []).filter((s) => s.type === 'addRules' || s.type === 'setMode');
    return new Promise((resolve) => {
      this.pending.set(id, {
        resolve: (decision, message) => {
          if (decision === 'allow' || decision === 'always') {
            resolve({ behavior: 'allow', updatedInput: toolInput, updatedPermissions: decision === 'always' ? always : undefined });
          } else {
            resolve({ behavior: 'deny', message: message || 'The user declined this action.', interrupt: decision === 'cancel' });
          }
        },
      });
      this.emit({
        t: 'permission', id, toolId: opts.toolUseID || null, name, input: toolInput, title: opts.title || null, description: opts.description || null,
        reason: opts.decisionReason || null, always: always.length ? describeAlways(always) : null,
      });
      this.setStatus('waiting');
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => {
          if (this.pending.delete(id)) this.emit({ t: 'permission-resolved', id, decision: 'cancelled' });
        }, { once: true });
      }
    });
  }

  onMessage(m) {
    this.touch();
    if (m.parent_tool_use_id) return; // subagent internals: the Task tool card summarises them
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          const fresh = !this.id;
          this.id = m.session_id;
          if (m.model) this.model = this.model || m.model;
          this.addKey(`claude:${m.session_id}`);
          if (fresh) this.emit({ t: 'session', key: `claude:${m.session_id}`, id: m.session_id, model: m.model, mode: m.permissionMode });
        } else if (m.subtype === 'compact_boundary') {
          this.emit({ t: 'notice', level: 'info', text: 'Context compacted' });
        } else if (m.subtype === 'status' && m.status === 'compacting') {
          this.emit({ t: 'notice', level: 'info', text: 'Compacting context…' });
        }
        break;
      case 'stream_event': {
        const e = m.event || {};
        if (e.type === 'message_start') this.setStatus('thinking');
        else if (e.type === 'content_block_start' && e.content_block) {
          if (e.content_block.type === 'text') this.setStatus('responding');
          else if (e.content_block.type === 'tool_use') this.setStatus('tool');
        } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
          this.emit({ t: 'delta', text: e.delta.text });
        }
        break;
      }
      case 'assistant':
        for (const b of (m.message && m.message.content) || []) {
          if (b.type === 'text' && b.text) this.emit({ t: 'text', text: b.text });
          else if (b.type === 'thinking') this.emit({ t: 'reasoning', text: b.thinking || '' });
          else if (b.type === 'tool_use') this.emit({ t: 'tool', id: b.id, name: b.name, input: b.input });
        }
        break;
      case 'user':
        for (const b of Array.isArray(m.message && m.message.content) ? m.message.content : []) {
          if (b.type !== 'tool_result') continue;
          this.emit(claudeToolResult(b, m.tool_use_result));
        }
        if (this.status !== 'waiting') this.setStatus('thinking');
        break;
      case 'result':
        this.emit({
          t: 'result', ok: !m.is_error, durationMs: m.duration_ms, cost: m.total_cost_usd,
          tokens: m.usage ? { input: (m.usage.input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0), cached: m.usage.cache_read_input_tokens || 0, output: m.usage.output_tokens || 0 } : null,
          error: m.is_error ? clip(m.result || m.subtype, 2000) : null,
        });
        this.turnStarted = 0;
        this.setStatus('idle');
        break;
    }
  }

  async interrupt() {
    if (this.run && this.run.q) await this.run.q.interrupt().catch(() => {});
  }

  async setMode(mode) {
    this.mode = mode;
    if (this.run && this.run.q) await this.run.q.setPermissionMode(mode);
    this.emit({ t: 'notice', level: 'info', text: `Permission mode: ${mode}` });
  }

  async setModel(model) {
    this.model = model;
    if (this.run && this.run.q) await this.run.q.setModel(model || undefined);
    this.emit({ t: 'notice', level: 'info', text: `Model: ${model || 'default'}` });
  }

  close() {
    const run = this.run;
    if (!run) return;
    run.ended = true;
    if (run.wake) run.wake();
    try { run.abort.abort(); } catch {}
  }
}

// A label for what "Always allow" will do: allow-list rules ("Bash(npm test:*)"),
// or, when Claude suggests a mode switch instead, "mode:<mode>".
function describeAlways(updates) {
  const rules = [];
  let mode = null;
  for (const u of updates) {
    if (u.type === 'setMode') mode = mode || u.mode;
    else for (const r of u.rules || []) rules.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
  }
  return rules.length ? rules.join(', ') : mode ? `mode:${mode}` : null;
}

function claudeToolResult(block, extra) {
  const ev = { t: 'tool-result', id: block.tool_use_id, ok: !block.is_error, text: clip(toText(block.content)) };
  if (extra && typeof extra === 'object') {
    if (Array.isArray(extra.structuredPatch)) ev.patch = extra.structuredPatch;
    if (typeof extra.stdout === 'string' || typeof extra.stderr === 'string') {
      ev.text = clip([extra.stdout, extra.stderr].filter(Boolean).join('\n'));
      if (extra.interrupted) ev.ok = false;
    }
    if (extra.type === 'create' && typeof extra.content === 'string') ev.created = true;
  }
  return ev;
}

// ------------------------------------------------------------------ Codex (app-server)
// Codex's own sandbox (bubblewrap) can't create namespaces inside an unprivileged
// container, so commands run unsandboxed: the container is the boundary and the
// approval policy is what keeps you in the loop.
const CODEX_MODES = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'danger-full-access' },      // asks before anything not known-safe
  auto: { approvalPolicy: 'on-request', sandbox: 'danger-full-access' },    // Codex decides when to ask
  'full-access': { approvalPolicy: 'never', sandbox: 'danger-full-access' }, // never asks
};

class CodexSession extends LiveSession {
  async start() {
    this.rpcId = 0;
    this.calls = new Map();
    this.turnId = null;
    const proc = spawn(CODEX_BIN, ['app-server'], { cwd: this.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.ended = false;
    const stderr = [];
    proc.stderr.on('data', (d) => { stderr.push(String(d)); if (stderr.length > 50) stderr.shift(); });
    proc.on('error', (e) => this.emit({ t: 'notice', level: 'error', text: `Couldn't start Codex: ${e.message}` }));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return; // an older process we replaced
      for (const [, c] of this.calls) c.reject(new Error(`codex exited (${code})`));
      this.calls.clear();
      if (!this.ended) {
        const detail = stderr.join('').trim().split('\n').slice(-3).join(' ');
        this.emit({ t: 'notice', level: 'error', text: `Codex stopped (exit ${code})${detail ? `: ${detail}` : ''}` });
        this.setStatus('error');
      } else this.setStatus('closed');
      this.proc = null;
    });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      if (this.proc !== proc) return;
      let m;
      try { m = JSON.parse(line); } catch { return; }
      this.onRpc(m);
    });
    await this.call('initialize', { clientInfo: { name: 'roost', title: 'roost', version: '1' }, capabilities: null });
    this.notify('initialized', {});
    const opts = { cwd: this.cwd, model: this.model || null, ...CODEX_MODES[this.mode] };
    const r = this.id ? await this.call('thread/resume', { threadId: this.id, ...opts }) : await this.call('thread/start', opts);
    const fresh = !this.id;
    this.id = r.thread.id;
    this.model = this.model || r.model || '';
    this.addKey(`codex:${this.id}`);
    if (fresh) this.emit({ t: 'session', key: `codex:${this.id}`, id: this.id, model: r.model, mode: this.mode });
    this.setStatus('idle');
  }

  get running() { return !!this.proc; }

  call(method, params) {
    const id = ++this.rpcId;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method, params) { this.write({ method, params }); }
  write(m) { if (this.proc) this.proc.stdin.write(JSON.stringify(m) + '\n'); }

  onRpc(m) {
    this.touch();
    if (m.id != null && !m.method) { // response to our call
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      if (m.error) c.reject(new Error(m.error.message || JSON.stringify(m.error)));
      else c.resolve(m.result);
      return;
    }
    if (m.id != null && m.method) return this.onServerRequest(m);
    const p = m.params || {};
    switch (m.method) {
      case 'turn/started':
        this.turnId = p.turn && p.turn.id;
        this.setStatus('thinking');
        break;
      case 'item/agentMessage/delta':
        this.setStatus('responding');
        this.emit({ t: 'delta', text: p.delta || '' });
        break;
      case 'item/commandExecution/outputDelta':
        this.emit({ t: 'tool-output', id: p.itemId, text: p.delta || '' });
        break;
      case 'item/started':
        this.onItem(p.item, false);
        break;
      case 'item/completed':
        this.onItem(p.item, true);
        break;
      case 'thread/tokenUsage/updated':
        this.lastUsage = p.tokenUsage && p.tokenUsage.last;
        break;
      case 'turn/completed': {
        const t = p.turn || {};
        const u = this.lastUsage;
        this.emit({
          t: 'result', ok: t.status === 'completed', durationMs: this.turnStarted ? Date.now() - this.turnStarted : null, cost: null,
          tokens: u ? { input: u.inputTokens || 0, cached: u.cachedInputTokens || 0, output: (u.outputTokens || 0) + (u.reasoningOutputTokens || 0) } : null,
          error: t.status === 'failed' ? clip((t.error && (t.error.message || JSON.stringify(t.error))) || 'turn failed', 2000) : t.status === 'interrupted' ? 'Interrupted' : null,
        });
        this.turnId = null;
        this.turnStarted = 0;
        this.setStatus('idle');
        break;
      }
      case 'error':
        this.emit({ t: 'notice', level: 'error', text: clip((p.error && p.error.message) || p.message || JSON.stringify(p), 2000) });
        break;
      case 'thread/compacted':
        this.emit({ t: 'notice', level: 'info', text: 'Context compacted' });
        break;
    }
  }

  onItem(item, done) {
    if (!item) return;
    switch (item.type) {
      case 'agentMessage':
        if (done && item.text) this.emit({ t: 'text', text: item.text });
        break;
      case 'reasoning':
        if (done) this.emit({ t: 'reasoning', text: (item.summary || []).join('\n') });
        else this.setStatus('thinking');
        break;
      case 'commandExecution':
        if (!done) { this.setStatus('tool'); this.emit({ t: 'tool', id: item.id, name: 'Bash', input: { command: item.command, cwd: item.cwd } }); }
        else this.emit({ t: 'tool-result', id: item.id, ok: item.status === 'completed' && (item.exitCode == null || item.exitCode === 0), exitCode: item.exitCode, text: clip(item.aggregatedOutput || '') });
        break;
      case 'fileChange':
        if (!done) {
          this.setStatus('tool');
          this.emit({ t: 'tool', id: item.id, name: 'Patch', input: { changes: (item.changes || []).map((c) => ({ path: c.path, kind: c.kind && c.kind.type })) } });
        } else {
          this.emit({ t: 'tool-result', id: item.id, ok: item.status === 'completed', text: '', diff: (item.changes || []).map((c) => ({ path: c.path, kind: c.kind && c.kind.type, diff: clip(c.diff) })) });
        }
        break;
      case 'mcpToolCall':
        if (!done) this.emit({ t: 'tool', id: item.id, name: `${item.server}.${item.tool}`, input: item.arguments });
        else this.emit({ t: 'tool-result', id: item.id, ok: item.status === 'completed', text: clip(toText(item.result && item.result.content) || (item.error && item.error.message) || '') });
        break;
      case 'webSearch':
        if (!done) this.emit({ t: 'tool', id: item.id, name: 'WebSearch', input: { query: item.query || '' } });
        else this.emit({ t: 'tool-result', id: item.id, ok: true, text: '' });
        break;
      case 'contextCompaction':
        if (done) this.emit({ t: 'notice', level: 'info', text: 'Context compacted' });
        break;
    }
  }

  onServerRequest(m) {
    const p = m.params || {};
    const reply = (result) => this.write({ id: m.id, result });
    if (m.method === 'item/commandExecution/requestApproval' || m.method === 'item/fileChange/requestApproval') {
      const isCmd = m.method.includes('commandExecution');
      const id = String(p.approvalId || p.itemId || m.id);
      this.pending.set(id, {
        resolve: (decision) => reply({ decision: decision === 'always' ? 'acceptForSession' : decision === 'allow' ? 'accept' : decision === 'cancel' ? 'cancel' : 'decline' }),
      });
      this.emit({
        t: 'permission', id, toolId: p.itemId, name: isCmd ? 'Bash' : 'Patch',
        input: isCmd ? { command: p.command, cwd: p.cwd } : { grantRoot: p.grantRoot },
        title: isCmd ? 'Run a command' : 'Apply file changes', description: p.reason || null, always: 'for the rest of this session',
      });
      this.setStatus('waiting');
      return;
    }
    // Anything else we don't support yet: decline politely so the turn can continue.
    this.write({ id: m.id, error: { code: -32601, message: `roost does not support ${m.method}` } });
  }

  send(text) {
    this.touch();
    this.turnStarted = Date.now();
    this.emit({ t: 'user', text });
    this.setStatus('thinking');
    this.call('turn/start', { threadId: this.id, input: [{ type: 'text', text, text_elements: [] }] }).catch((e) => {
      this.emit({ t: 'notice', level: 'error', text: `Couldn't start the turn: ${e.message}` });
      this.setStatus('error');
    });
  }

  async interrupt() {
    if (this.turnId) await this.call('turn/interrupt', { threadId: this.id, turnId: this.turnId }).catch(() => {});
  }

  async setMode(mode) {
    if (!CODEX_MODES[mode]) throw Object.assign(new Error('unknown Codex mode'), { status: 400 });
    // Approval and sandbox settings are fixed per thread connection; reconnect with the new ones.
    this.mode = mode;
    this.emit({ t: 'notice', level: 'info', text: `Approval mode: ${mode} (applies from your next message)` });
    this.restartOnNextSend = true;
  }

  async setModel(model) {
    this.model = model;
    this.emit({ t: 'notice', level: 'info', text: `Model: ${model || 'default'} (applies from your next message)` });
    this.restartOnNextSend = true;
  }

  close() {
    this.ended = true;
    const proc = this.proc;
    this.proc = null;
    if (proc) proc.kill('SIGTERM');
  }
}

// ------------------------------------------------------------------ history (from transcripts)
async function history(key, limit = 600) {
  const [tool] = key.split(':');
  await chats.scan();
  const file = chats.fileFor(key);
  if (!file) return null;
  const out = [];
  const push = (ev) => { out.push(ev); if (out.length > limit * 2) out.splice(0, out.length - limit); };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (tool === 'claude') {
      if (d.isSidechain || (d.type !== 'user' && d.type !== 'assistant')) continue;
      const c = d.message && d.message.content;
      if (d.type === 'user') {
        if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) {
          for (const b of c) if (b.type === 'tool_result') push(claudeToolResult(b, d.toolUseResult));
        } else if (!d.isMeta && !d.isCompactSummary) {
          const t = chats.humanText(c);
          if (t) push({ t: 'user', text: t, at: Date.parse(d.timestamp) || null });
        }
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text' && b.text) push({ t: 'text', text: b.text, at: Date.parse(d.timestamp) || null });
          else if (b.type === 'tool_use') push({ t: 'tool', id: b.id, name: b.name, input: b.input });
        }
      }
    } else {
      const p = d.payload || {};
      if (d.type !== 'response_item') continue;
      if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        const text = (p.content || []).map((x) => x.text || '').join('\n');
        if (p.role === 'user') { const t = chats.humanText(text); if (t) push({ t: 'user', text: t, at: Date.parse(d.timestamp) || null }); }
        else if (text) push({ t: 'text', text, at: Date.parse(d.timestamp) || null });
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        let input = p.arguments || p.input;
        try { input = JSON.parse(input); } catch {}
        const isShell = /^(shell|exec_command|local_shell)$/.test(p.name);
        if (isShell && input && Array.isArray(input.command)) input = { command: input.command.join(' ') };
        if (p.name === 'apply_patch') push({ t: 'tool', id: p.call_id, name: 'Patch', input: {} });
        else push({ t: 'tool', id: p.call_id, name: isShell ? 'Bash' : p.name, input });
        if (p.name === 'apply_patch') out[out.length - 1].pendingPatch = typeof input === 'string' ? input : (input && input.input) || '';
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const o = typeof p.output === 'string' ? p.output : toText(p.output && (p.output.content || p.output));
        const call = out.find((e) => e.t === 'tool' && e.id === p.call_id);
        const ev = { t: 'tool-result', id: p.call_id, ok: !/exit code: [1-9]|"exit_code":\s*[1-9]/.test(o), text: clip(o) };
        if (call && call.pendingPatch) { ev.diff = [{ path: '', kind: 'patch', diff: clip(call.pendingPatch) }]; delete call.pendingPatch; }
        push(ev);
      }
    }
  }
  return out.slice(-limit);
}

// ------------------------------------------------------------------ manager
async function ensure({ key, tool, cwd, model, mode }) {
  let s = key && sessions.get(key);
  if (s && s.running && !s.restartOnNextSend) return s;
  const id = key && !key.split(':')[1].startsWith('new-') ? key.split(':')[1] : null;
  if (s) { // restart an exited or reconfigured session in place, keeping its event history
    s.close();
    s.restartOnNextSend = false;
    if (model !== undefined) s.model = model;
    if (mode) s.mode = mode;
  } else {
    if (!cwd || !fs.existsSync(cwd)) throw Object.assign(new Error(`folder not found: ${cwd}`), { status: 400 });
    const Cls = tool === 'codex' ? CodexSession : ClaudeSession;
    s = new Cls({ tool, key: key || `${tool}:new-${crypto.randomBytes(4).toString('hex')}`, id, cwd, model, mode });
    for (const k of s.keys) sessions.set(k, s);
  }
  s.setStatus('starting');
  await s.start();
  return s;
}

async function send({ key, tool, cwd, text, model, mode }) {
  if (!text || !String(text).trim()) throw Object.assign(new Error('message is empty'), { status: 400 });
  tool = tool || (key && key.split(':')[0]);
  if (tool !== 'claude' && tool !== 'codex') throw Object.assign(new Error('tool must be claude or codex'), { status: 400 });
  if (!cwd && key) {
    await chats.scan();
    const c = chats.get(key);
    cwd = c && c.cwd;
  }
  if (tool === 'claude' && cwd) await new Promise((r) => spawn('/usr/local/bin/roost-trust', [cwd]).on('exit', r).on('error', r));
  const s = await ensure({ key, tool, cwd, model, mode });
  s.send(String(text));
  return { key: s.id ? `${tool}:${s.id}` : [...s.keys][0], pendingKey: [...s.keys][0] };
}

function get(key) {
  const s = sessions.get(key);
  if (!s) throw Object.assign(new Error('this chat is not running in roost'), { status: 404 });
  return s;
}

function list() {
  const seen = new Set();
  const out = [];
  for (const s of sessions.values()) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push({ key: s.id ? `${s.tool}:${s.id}` : [...s.keys][0], keys: [...s.keys], tool: s.tool, cwd: s.cwd, status: s.status, running: s.running, pending: s.pending.size, lastActive: s.lastActive });
  }
  return out;
}

function close(key) {
  const s = get(key);
  s.close();
  for (const k of s.keys) sessions.delete(k);
}

// Close chats nobody has touched in a while (their history stays in the transcript).
setInterval(() => {
  for (const s of new Set(sessions.values())) {
    if (s.status !== 'waiting' && s.status !== 'thinking' && s.status !== 'responding' && s.status !== 'tool' && Date.now() - s.lastActive > IDLE_CLOSE_MS) {
      s.close();
      for (const k of s.keys) sessions.delete(k);
    }
  }
}, 60 * 1000).unref();

// ------------------------------------------------------------------ models & renaming
// Codex's model list comes from a short-lived app-server; answer from the cache at
// once and refresh it in the background, so the UI never waits on it.
let codexModels = { at: 0, list: null, loading: null };
function refreshCodexModels() {
  if (codexModels.loading) return codexModels.loading;
  codexModels.loading = codexModelList()
    .then((list) => { codexModels.list = list; })
    .catch(() => {})
    .finally(() => { codexModels.at = Date.now(); codexModels.loading = null; });
  return codexModels.loading;
}
async function models() {
  const claude = [{ v: '', label: 'Default model' }, { v: 'opus', label: 'Opus' }, { v: 'sonnet', label: 'Sonnet' }, { v: 'haiku', label: 'Haiku' }];
  if (Date.now() - codexModels.at > (codexModels.list ? 3600 : 120) * 1000) {
    const p = refreshCodexModels();
    if (!codexModels.list) await Promise.race([p, new Promise((r) => setTimeout(r, 1500))]);
  }
  return { claude, codex: [{ v: '', label: 'Default model' }, ...(codexModels.list || [])] };
}
setTimeout(refreshCodexModels, 5000).unref(); // warm the cache after start-up

// Ask a short-lived `codex app-server` which models this account can use.
function codexModelList() {
  return new Promise((resolve, reject) => {
    const proc = spawn(CODEX_BIN, ['app-server'], { cwd: process.env.HOME || '/', stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 15000);
    const send = (m) => proc.stdin.write(JSON.stringify(m) + '\n');
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.id === 1) { send({ method: 'initialized', params: {} }); send({ id: 2, method: 'model/list', params: {} }); }
      if (m.id === 2) {
        clearTimeout(timer);
        proc.kill();
        if (m.error) return reject(new Error(m.error.message));
        resolve(((m.result && m.result.data) || []).filter((x) => !x.hidden).map((x) => ({ v: x.model || x.id, label: x.displayName || x.model || x.id })));
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'roost', title: 'roost', version: '1' }, capabilities: null } });
  });
}

async function rename(key, title) {
  title = String(title || '').trim().slice(0, 120);
  if (!title) throw Object.assign(new Error('title is empty'), { status: 400 });
  const [tool, id] = key.split(':');
  if (tool !== 'claude') throw Object.assign(new Error('Renaming Codex chats isn\'t supported yet'), { status: 400 });
  const { renameSession } = await loadSdk();
  await renameSession(id, title);
}

module.exports = { watch, send, get, list, close, history, models, rename, CODEX_MODES };
