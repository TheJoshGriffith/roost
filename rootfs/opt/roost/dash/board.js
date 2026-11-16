'use strict';
// Mission Control: a small running summary of one live session, so the board can show
// every chat's state from the /api/live list without opening a stream per chat
// (browsers allow only 6 HTTP/1.1 connections per host). It is fed from the session's
// emit path, one event at a time, and never re-reads a transcript.
// Contract: design/revamp/BOARD-API.md.

const path = require('path');
const chats = require('./chats');

const TAIL_LINES = 5;
const TAIL_LINE_CHARS = 200;
const TAIL_KEEP = 4000; // characters of streamed output kept for the tail
const TITLE_CHARS = 120;
const BUSY = new Set(['thinking', 'responding', 'tool', 'waiting']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'Patch']);

const zeroTokens = () => ({ input: 0, cached: 0, output: 0 });
const sumTokens = (t) => (t ? (t.input || 0) + (t.cached || 0) + (t.output || 0) : 0);
const oneLine = (s, n) => {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;

// The last few non-blank lines of some output, as a terminal would show them
// (a carriage return redraws the line, so only what follows the last one counts).
function tailLines(text) {
  if (!text) return [];
  const lines = String(text).replace(ANSI, '').split('\n')
    .map((l) => { const i = l.lastIndexOf('\r', l.length - 2); return (i >= 0 ? l.slice(i + 1) : l).replace(/\r$/, '').trimEnd(); })
    .filter((l) => l.trim());
  // clip() marks cut text with this; it says nothing about what the tool printed last.
  if (lines.length && /^… \(\d+ more characters\)$/.test(lines[lines.length - 1])) lines.pop();
  return lines.slice(-TAIL_LINES).map((l) => (l.length > TAIL_LINE_CHARS ? l.slice(0, TAIL_LINE_CHARS - 1) + '…' : l));
}

// Codex runs commands as `/bin/bash -lc '<command>'`; the board wants the command.
function unwrapShell(cmd) {
  if (Array.isArray(cmd)) cmd = cmd.join(' ');
  cmd = String(cmd || '');
  const m = cmd.match(/^(?:\S*\/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/);
  if (!m) return cmd;
  // Undo the quoting the wrapper needed, so it reads as it was written.
  return m[1] === "'" ? m[2].replace(/'\\''/g, "'") : m[2].replace(/\\([\\"$`])/g, '$1');
}

class Board {
  constructor(session) {
    this.s = session;
    this.firstPrompt = null;
    this.tools = new Map();       // tool id -> { name, input, since } for calls not finished yet
    this.tailText = '';           // output of the running or last tool
    this.tailId = null;           // the call tailText came from
    this.perms = new Map();       // permission id -> board entry
    this.todos = null;
    this.tasks = new Map();       // Claude's task list (TaskCreate/TaskUpdate): id -> { text, status }
    this.lastTurn = null;
    this.tokens = zeroTokens();
    this.turn = { files: new Set(), added: 0, removed: 0 };
    this.error = null;
    this.statusSince = Date.now();
  }

  rel(p) {
    p = String(p || '');
    const cwd = this.s.cwd;
    return cwd && p.startsWith(cwd.replace(/\/$/, '') + '/') ? path.relative(cwd, p) : p;
  }

  // ev is the event as the browser sees it; hint carries what the event leaves out
  // (a tool's full output before clipping, Codex's per-turn token count).
  update(ev, hint = {}) {
    switch (ev.t) {
      case 'status':
        this.statusSince = ev.at;
        if (ev.status === 'error' || ev.status === 'closed' || ev.status === 'starting' || ev.status === 'idle') {
          this.tools.clear();
        }
        break;
      case 'user':
        if (!this.firstPrompt && ev.text) this.firstPrompt = oneLine(ev.text, TITLE_CHARS);
        this.error = null;
        break;
      case 'tool': {
        const call = { id: ev.id, name: ev.name, input: ev.input || {}, since: ev.at };
        this.tools.set(ev.id, call);
        if (ev.name === 'TodoWrite' && ev.input && Array.isArray(ev.input.todos)) this.setTodos(ev.input.todos.map((t) => ({ text: t.activeForm || t.content, status: t.status })));
        break;
      }
      // The tail keeps the previous tool's output until the next one prints something,
      // so a call waiting for approval or still starting doesn't blank it.
      case 'tool-output':
        if (!ev.text) break;
        if (this.tailId !== ev.id) { this.tailId = ev.id; this.tailText = ''; }
        this.tailText = (this.tailText + ev.text).slice(-TAIL_KEEP);
        break;
      case 'tool-result': {
        const call = this.tools.get(ev.id);
        this.tools.delete(ev.id);
        // Codex streamed the output already; its final text is clipped from the front.
        const full = String((hint.full != null ? hint.full : ev.text) || '');
        if (full.trim()) { this.tailId = ev.id; this.tailText = full.slice(-TAIL_KEEP); }
        if (call && EDIT_TOOLS.has(call.name) && ev.ok !== false) this.countEdits(call, ev);
        if (call && /^Task(Create|Update|List)$/.test(call.name) && ev.ok !== false) this.trackTask(call, ev, hint.result);
        break;
      }
      case 'permission': {
        const summary = this.summary(ev.name, ev.input, ev.toolId);
        const description = ev.description || ev.reason || null;
        this.perms.set(ev.id, {
          id: ev.id, name: ev.name,
          title: ev.title || `${this.s.tool === 'codex' ? 'Codex' : 'Claude'} wants to use ${ev.name}`,
          summary,
          // Claude often describes a file edit by its path alone: no need to say it twice.
          description: description && description !== summary && this.rel(description) !== summary ? description : null,
          always: ev.always || null,
          at: ev.at,
        });
        break;
      }
      case 'permission-resolved':
        this.perms.delete(ev.id);
        break;
      case 'result': {
        const tokens = hint.tokens || ev.tokens || null;
        if (tokens) for (const k of ['input', 'cached', 'output']) this.tokens[k] += tokens[k] || 0;
        this.lastTurn = {
          ok: !!ev.ok, durationMs: ev.durationMs == null ? null : ev.durationMs, cost: ev.cost == null ? null : ev.cost,
          tokens: tokens ? sumTokens(tokens) : null,
          files: this.turn.files.size, added: this.turn.added, removed: this.turn.removed,
          endedAt: ev.at, error: ev.error || null,
        };
        this.turn = { files: new Set(), added: 0, removed: 0 };
        this.tools.clear();
        break;
      }
      case 'notice':
        if (ev.level === 'error') this.error = ev.text;
        break;
    }
  }

  // steps: [{ text, status: pending | in_progress | completed }] (Claude TodoWrite, Codex plan)
  setTodos(steps) {
    if (!steps.length) { this.todos = null; return; }
    const cur = steps.find((t) => t.status === 'in_progress');
    this.todos = { done: steps.filter((t) => t.status === 'completed').length, total: steps.length, current: cur ? oneLine(cur.text, TITLE_CHARS) : null };
  }

  // Newer Claude Code keeps its to-do list with TaskCreate/TaskUpdate/TaskList instead
  // of TodoWrite: follow the calls (ids come back in the results) to rebuild it.
  trackTask(call, ev, result) {
    const i = call.input || {};
    const r = result && typeof result === 'object' ? result : {};
    if (call.name === 'TaskCreate') {
      const m = String(ev.text || '').match(/Task #?(\S+?)[: ]/);
      const id = (r.task && r.task.id) || (m && m[1]);
      if (id) this.tasks.set(String(id), { text: i.activeForm || i.subject || (r.task && r.task.subject) || '', subject: i.subject, status: 'pending' });
    } else if (call.name === 'TaskUpdate') {
      const id = String(i.taskId || r.taskId || '');
      const t = this.tasks.get(id) || { text: i.subject || '', status: 'pending' };
      if (r.success === false) return;
      if (i.status === 'deleted') this.tasks.delete(id);
      else {
        if (i.status) t.status = i.status;
        if (i.activeForm || i.subject) t.text = i.activeForm || i.subject;
        this.tasks.set(id, t);
      }
    } else if (Array.isArray(r.tasks)) {
      const old = this.tasks;
      this.tasks = new Map(r.tasks.map((t) => [String(t.id), { text: (old.get(String(t.id)) || {}).text || t.subject, status: t.status }]));
    } else return;
    this.setTodos([...this.tasks.values()]);
  }

  // The one line that matters in a tool call: its command, file, pattern or URL.
  summary(name, input, toolId) {
    const i = input && typeof input === 'object' ? input : {};
    if (name === 'Patch') {
      const call = (toolId && this.tools.get(toolId)) || null;
      const changes = (call && call.input.changes) || i.changes || [];
      if (changes.length) return oneLine(this.rel(changes[0].path) + (changes.length > 1 ? ` (+${changes.length - 1} more)` : ''), 300);
      return i.grantRoot ? oneLine(`write access to ${this.rel(i.grantRoot)}`, 300) : '';
    }
    const v = i.command != null ? unwrapShell(i.command)
      : i.file_path || i.notebook_path || i.path ? this.rel(i.file_path || i.notebook_path || i.path)
      : i.url || i.pattern || i.query || i.description || i.prompt || '';
    return oneLine(v, 300);
  }

  activity() {
    const st = this.s.status;
    if (!BUSY.has(st) || st === 'waiting') return null;
    // Several calls at once: tools run in the order they were asked for, so the oldest
    // unfinished one is the one actually running (the rest wait behind it).
    const c = this.tools.values().next().value;
    if (c) {
      const { verb, target } = describe(c.name, c.input, this);
      return { verb, target, tool: c.name, since: c.since };
    }
    if (st === 'responding') return { verb: 'Responding', target: null, tool: null, since: this.statusSince };
    return { verb: 'Thinking', target: null, tool: null, since: this.statusSince };
  }

  title() {
    const key = this.s.id ? `${this.s.tool}:${this.s.id}` : null;
    const chat = key && chats.get(key);
    const t = chat && chat.title && chat.title !== 'Untitled chat' ? chat.title : null;
    return t || this.firstPrompt || null;
  }

  view() {
    const s = this.s;
    const busy = BUSY.has(s.status);
    return {
      title: this.title(),
      model: s.model || null,
      mode: s.mode || null,
      turnStartedAt: busy && s.turnStarted ? s.turnStarted : null,
      activity: this.activity(),
      tail: tailLines(this.tailText),
      // The session's pending map is the truth; an entry it no longer has was answered.
      permissions: [...this.perms.values()].filter((p) => s.pending.has(p.id)).sort((a, b) => a.at - b.at),
      todos: this.todos,
      lastTurn: this.lastTurn,
      tokens: { ...this.tokens },
      error: s.status === 'error' ? this.error || 'Stopped with an error' : null,
    };
  }

  // Edit/MultiEdit/Write results carry a structured patch (Claude) and Patch results a
  // unified diff per file (Codex); count the lines each adds and removes.
  countEdits(call, ev) {
    const t = this.turn;
    const i = call.input || {};
    if (Array.isArray(ev.diff)) {
      for (const c of ev.diff) {
        if (c.path) t.files.add(c.path);
        const lines = String(c.diff || '').split('\n');
        // A Codex add/delete carries the file's content rather than a diff.
        if (c.kind === 'add') t.added += lines.filter((l, n) => l || n < lines.length - 1).length;
        else if (c.kind === 'delete') t.removed += lines.filter((l, n) => l || n < lines.length - 1).length;
        else for (const l of lines) {
          if (l.startsWith('+') && !l.startsWith('+++')) t.added++;
          else if (l.startsWith('-') && !l.startsWith('---')) t.removed++;
        }
      }
      return;
    }
    if (i.file_path) t.files.add(i.file_path);
    if (Array.isArray(ev.patch) && ev.patch.length) {
      for (const h of ev.patch) for (const l of h.lines || []) {
        if (l.startsWith('+')) t.added++;
        else if (l.startsWith('-')) t.removed++;
      }
    } else if (call.name === 'Write' && typeof i.content === 'string') {
      t.added += i.content ? i.content.replace(/\n$/, '').split('\n').length : 0; // a new file
    }
  }
}

// What a tool call is doing, as a verb and the thing it acts on.
function describe(name, input, board) {
  const i = input && typeof input === 'object' ? input : {};
  const file = (p) => board.rel(p);
  switch (name) {
    case 'Bash': return { verb: 'Running', target: oneLine(unwrapShell(i.command) || i.description || '', 300) || null };
    case 'BashOutput': case 'KillShell': case 'KillBash': return { verb: 'Running', target: name };
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return { verb: 'Editing', target: file(i.file_path || i.notebook_path) || null };
    case 'Patch': return { verb: 'Editing', target: board.summary('Patch', i) || null };
    case 'Write': return { verb: 'Writing', target: file(i.file_path) || null };
    case 'Read': return { verb: 'Reading', target: file(i.file_path) || null };
    case 'Grep': case 'Glob': return { verb: 'Searching', target: oneLine(i.pattern || '', 300) || null };
    case 'WebSearch': return { verb: 'Searching', target: oneLine(i.query || '', 300) || null };
    case 'WebFetch': return { verb: 'Fetching', target: i.url || null };
    case 'Task': case 'Agent': return { verb: 'Delegating', target: oneLine(i.description || i.subagent_type || '', 300) || null };
    default: return { verb: 'Using', target: name };
  }
}

module.exports = { Board };
