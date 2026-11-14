'use strict';
// Indexes Claude Code and Codex chats from their on-disk transcripts.
// Read-only: roost never modifies either tool's files. Parsed results are
// cached per file (mtime + size), so a refresh only re-reads chats that changed.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');
const uploads = require('./uploads');

const HOME = process.env.HOME || '/config/home';
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');
const CODEX_DIR = path.join(HOME, '.codex', 'sessions');
const CODEX_INDEX = path.join(HOME, '.codex', 'session_index.jsonl');

const cache = new Map(); // file -> { mtimeMs, size, chat }
const byKey = new Map(); // "claude:<id>" -> file

const clip = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// Text a human typed, or null for tool results, system reminders, slash-command plumbing etc.
// A first prompt for the chat title, without roost's attachment note.
function promptTitle(t) {
  const { text, attachments } = uploads.split(t);
  return text || (attachments && attachments.length ? attachments.map((a) => a.name).join(', ') : t);
}

function humanText(content) {
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((c) => c && c.type === 'tool_result')) return null;
    const t = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
    text = t || null;
  }
  if (!text) return null;
  const s = text.trim();
  if (!s || s.startsWith('<') || s.startsWith('Caveat:') || s.startsWith('[Request interrupted')) return null;
  // Codex injects AGENTS.md and environment context as user messages.
  if (s.startsWith('# AGENTS.md instructions') || s.includes('<INSTRUCTIONS>') || s.includes('<environment_context>')) return null;
  return s;
}

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line) fn(line);
  }
}

const CLAUDE_INTERESTING = /"type":\s*"(user|assistant|custom-title|ai-title|bridge-session|relocated|pr-link|summary)"/;

async function parseClaude(file, st) {
  const chat = {
    tool: 'claude', id: path.basename(file, '.jsonl'), cwd: null, branch: null, title: null,
    firstPrompt: null, prompts: 0, replies: 0, started: null, updated: new Date(st.mtimeMs).toISOString(),
    remote: false, prs: [], sidechainOnly: true,
  };
  let customTitle = null;
  let aiTitle = null;
  let summary = null;
  await eachLine(file, (line) => {
    if (!CLAUDE_INTERESTING.test(line)) return;
    let d;
    try { d = JSON.parse(line); } catch { return; }
    switch (d.type) {
      case 'custom-title': customTitle = d.customTitle || customTitle; break;
      case 'ai-title': aiTitle = d.aiTitle || aiTitle; break;
      case 'summary': summary = d.summary || summary; break;
      case 'bridge-session': chat.remote = true; break;
      case 'relocated': if (d.relocatedCwd) chat.cwd = d.relocatedCwd; break;
      case 'pr-link': if (d.prUrl && !chat.prs.includes(d.prUrl)) chat.prs.push(d.prUrl); break;
      case 'user':
      case 'assistant': {
        if (!d.isSidechain) chat.sidechainOnly = false;
        if (d.isSidechain) break;
        if (d.cwd && !chat.cwd) chat.cwd = d.cwd;
        if (d.gitBranch) chat.branch = d.gitBranch;
        if (d.timestamp && !chat.started) chat.started = d.timestamp;
        if (d.type === 'assistant') { chat.replies++; break; }
        if (d.isMeta || d.isCompactSummary) break;
        const t = humanText(d.message && d.message.content);
        if (t) {
          chat.prompts++;
          if (!chat.firstPrompt) chat.firstPrompt = clip(promptTitle(t), 200);
        }
        break;
      }
    }
  });
  chat.title = clip(customTitle || aiTitle || summary || chat.firstPrompt || 'Untitled chat', 120);
  chat.named = !!(customTitle || aiTitle || summary);
  return chat;
}

let codexNames = { mtimeMs: 0, map: new Map() };
async function loadCodexNames() {
  try {
    const st = await fsp.stat(CODEX_INDEX);
    if (st.mtimeMs === codexNames.mtimeMs) return codexNames.map;
    const map = new Map();
    await eachLine(CODEX_INDEX, (line) => {
      try { const d = JSON.parse(line); if (d.id && d.thread_name) map.set(d.id, d.thread_name); } catch {}
    });
    codexNames = { mtimeMs: st.mtimeMs, map };
  } catch {}
  return codexNames.map;
}

async function parseCodex(file, st) {
  const chat = {
    tool: 'codex', id: null, cwd: null, branch: null, title: null, firstPrompt: null,
    prompts: 0, replies: 0, started: null, updated: new Date(st.mtimeMs).toISOString(), remote: false, prs: [],
  };
  await eachLine(file, (line) => {
    if (!line.includes('"session_meta"') && !line.includes('"message"') && !line.includes('"turn_context"')) return;
    let d;
    try { d = JSON.parse(line); } catch { return; }
    const p = d.payload || {};
    if (d.type === 'session_meta') {
      chat.id = chat.id || p.id || p.session_id;
      chat.cwd = chat.cwd || p.cwd;
      chat.started = chat.started || p.timestamp || d.timestamp;
      if (p.git && p.git.branch) chat.branch = p.git.branch;
    } else if (d.type === 'turn_context') {
      if (p.cwd) chat.cwd = chat.cwd || p.cwd;
    } else if (d.type === 'response_item' && p.type === 'message') {
      if (p.role === 'assistant') chat.replies++;
      if (p.role !== 'user') return;
      const t = humanText((p.content || []).filter((c) => c.type === 'input_text').map((c) => ({ type: 'text', text: c.text })));
      if (t) {
        chat.prompts++;
        if (!chat.firstPrompt) chat.firstPrompt = clip(promptTitle(t), 200);
      }
    }
  });
  if (!chat.id) {
    const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
    chat.id = m ? m[1] : path.basename(file, '.jsonl');
  }
  return chat;
}

async function listFiles(dir, depth, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) await listFiles(p, depth - 1, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

async function indexFile(file, parser) {
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.chat;
  try {
    const chat = await parser(file, st);
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, chat });
    return chat;
  } catch {
    return null;
  }
}

let scanning = null;
async function scan() {
  if (scanning) return scanning;
  scanning = (async () => {
    const [claudeFiles, codexFiles, names] = await Promise.all([
      listFiles(CLAUDE_DIR, 1), listFiles(CODEX_DIR, 4), loadCodexNames(),
    ]);
    const seen = new Set();
    const chats = [];
    for (const [files, parser] of [[claudeFiles, parseClaude], [codexFiles, parseCodex]]) {
      for (const f of files) {
        seen.add(f);
        const c = await indexFile(f, parser);
        if (!c || c.sidechainOnly || (!c.prompts && !c.replies)) continue;
        const chat = { ...c, key: `${c.tool}:${c.id}` };
        if (c.tool === 'codex') {
          const n = names.get(c.id);
          chat.title = clip(n || c.firstPrompt || 'Untitled chat', 120);
          chat.named = !!n;
        }
        byKey.set(chat.key, f);
        chats.push(chat);
      }
    }
    for (const f of cache.keys()) if (!seen.has(f)) cache.delete(f);
    return chats;
  })();
  try { return await scanning; } finally { scanning = null; }
}

// Full, human-readable transcript of one chat (most recent `limit` entries).
async function transcript(key, limit = 400) {
  const file = byKey.get(key);
  if (!file) return null;
  const tool = key.split(':')[0];
  const items = [];
  const push = (role, text, extra) => {
    if (!text && !extra) return;
    items.push({ role, text: text ? clip2(text, 6000) : '', ...extra });
    if (items.length > limit * 2) items.splice(0, items.length - limit);
  };
  await eachLine(file, (line) => {
    let d;
    try { d = JSON.parse(line); } catch { return; }
    if (tool === 'claude') {
      if ((d.type !== 'user' && d.type !== 'assistant') || d.isSidechain || d.isMeta) return;
      const c = d.message && d.message.content;
      if (d.type === 'user') {
        const t = humanText(c);
        if (t) push('user', t, { ts: d.timestamp });
        return;
      }
      if (!Array.isArray(c)) return;
      const text = c.filter((x) => x.type === 'text').map((x) => x.text).join('\n\n');
      const tools = c.filter((x) => x.type === 'tool_use').map((x) => toolLabel(x.name, x.input));
      push('assistant', text, tools.length ? { tools, ts: d.timestamp } : { ts: d.timestamp });
    } else {
      const p = d.payload || {};
      if (d.type !== 'response_item') return;
      if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        const parts = (p.content || []).map((x) => x.text || '').join('\n');
        if (p.role === 'user') {
          const t = humanText(parts);
          if (t) push('user', t, { ts: d.timestamp });
        } else push('assistant', parts, { ts: d.timestamp });
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        let input = p.arguments || p.input;
        try { input = JSON.parse(input); } catch {}
        push('assistant', '', { tools: [toolLabel(p.name, input)], ts: d.timestamp });
      }
    }
  });
  return items.slice(-limit);
}

function clip2(s, n) { return s.length > n ? s.slice(0, n) + '\n…' : s; }

function toolLabel(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const arg = i.command || i.cmd || i.file_path || i.path || i.pattern || i.url || i.description || i.query || '';
  const a = Array.isArray(arg) ? arg.join(' ') : String(arg);
  return a ? `${name}: ${clip(a, 140)}` : String(name);
}

const fileFor = (key) => byKey.get(key) || null;
function get(key) {
  const f = byKey.get(key);
  const hit = f && cache.get(f);
  return hit ? hit.chat : null;
}

module.exports = { scan, transcript, fileFor, get, humanText };
