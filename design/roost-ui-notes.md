# roost UI redesign: handover notes

Prototype: `design/roost-ui-prototype.html`. It's one self-contained file with no network requests. The mock data and the mock backend live at the bottom of the script. Open it straight from disk, or serve the folder with a static server. Routes: `#/projects`, `#/chat/<key>` (`#/chat` alone opens the last chat), `#/overview`. The theme button in the app bar cycles system → light → dark.

Script sections, in order (each starts with a `/* ===== N. */` banner):
1. helpers
2. markdown + highlight
3. diffs
4. **chat reducer**
5. **chat renderers**
6. **chat view**
7. projects tree
8. overview
9. sheets/menus/project form
10. app shell + router
11. mock data + mock backend

Sections 1 to 9 are written to be lifted. Sections 10 and 11 are prototype glue.

## Design tokens

All colours are CSS custom properties on `:root`. Dark mode is defined twice, under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and under `:root[data-theme="dark"]`. The palette is cool neutral greys plus one indigo-blue accent. There is no brown or amber anywhere except the semantic `--warn`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` / `--panel` / `--panel-2` / `--panel-3` | `#f5f6f8` / `#fff` / `#f0f2f5` / `#e5e8ed` | `#0d0e10` / `#15171a` / `#1c1f23` / `#262a2f` | page, cards, hover/fills, pressed |
| `--text` / `--text-2` / `--muted` / `--faint` | `#14171c` / `#3b414b` / `#5e6570` / `#8a919c` | `#e7e9ec` / `#c3c7cd` / `#8f959e` / `#5f656e` | `--faint` is only for decoration (line numbers, chevrons) |
| `--line` / `--line-2` | `#e2e5ea` / `#d0d5dc` | `#262a30` / `#343a41` | borders |
| `--accent` / `--accent-ink` / `--accent-text` / `--accent-soft` | `#3b5bdb` / `#3451c6` / `#fff` / `#eef1fd` | `#7c93ff` / `#98aaff` / `#0b1020` / `#1b2135` | primary buttons, focus, selection, "needs you" |
| `--ok(-ink)`, `--warn(-ink)`, `--bad(-ink)` | | | semantic. Use `-ink` for text, the base colour for dots and fills |
| `--console-*`, `--code-bg`, `--diff-*`, `--syn-*` | | | terminal blocks, code, diffs, syntax |
| `--claude` `#d97757`, `--codex` `#1c1c1e` | | | tool badges, which are the same in both themes |
| `--tap` 44px, `--gutter` 16px (24px at 640px and up), `--radius` 12px | | | |

Contrast was checked: text, muted and semantic `-ink` tokens are at least 4.5:1 on their surfaces in both themes. White on `--accent` is 5.7:1 and `--accent-text` on dark `--accent` is 6.7:1.

## Layout and breakpoints (mobile first)

The base CSS targets a ~375px phone. Two `min-width` queries enhance it.

- **Base (phone):**
  - Compact app bar (logo, name, live dot, theme), with a **bottom nav** below: Projects / Chat / Overview. The Chat tab shows a badge with the number of chats waiting for approval.
  - Every view scrolls inside itself (`.view-scroll`). The body never scrolls.
  - The chat is a full-screen layer (`.chat-pane`, `position: fixed`) that slides in, with a back button.
  - The composer sits at the bottom with `env(safe-area-inset-bottom)` padding.
  - Touch targets are 44px. Nothing depends on hover: chat rows always show a ⋯ button, and project actions are a visible strip.
- **640px and up (tablet):**
  - The bottom nav hides and the top tabs appear.
  - Sheets become centred dialogs, and menus become popovers anchored to their button.
  - The Overview gets two columns.
  - The diff view shows both old and new line-number columns.
- **1000px and up (desktop):**
  - The tree becomes a sidebar (`clamp(330px, 30vw, 400px)`) with the chat pane beside it. The back button hides and a close (×) button appears.
  - Drag a chat onto a project to file it there (an enhancement; the ⋯ → "Move to project…" sheet works everywhere).
- **On-screen keyboard:**
  - The meta viewport has `interactive-widget=resizes-content`, which handles Chrome on Android.
  - For iOS, `initShell()` listens to `visualViewport` and sets `--vvh` / `--vv-top`. The chat layer uses those, so the composer stays above the keyboard. Keep that listener when porting.
  - Inputs use 16px text so iOS doesn't zoom on focus.
  - On coarse pointers Enter inserts a newline and the send button sends. On fine pointers Enter sends, Shift+Enter adds a newline, and Esc stops a running turn.
- `prefers-reduced-motion` turns off all animation.

## Chat: events consumed (exactly your shapes)

The renderer consumes your server events as they are. Each event is assumed to carry `type` as its discriminator.

```
status              {type, status: idle|starting|thinking|responding|tool|waiting|error|closed|offline}
session             {type, key, id, model, mode}
user                {type, text}                      (+ optional attachments: [{name,size,type}])
delta               {type, text}                      appended to the open assistant block
text                {type, text}                      finishes that block (replaces the accumulated text)
reasoning           {type, text}
tool                {type, id, name, input}
tool-output         {type, id, text}                  appended to that tool's live output
tool-result         {type, id, ok, text, patch?, diff?, exitCode?}
permission          {type, id, name, input, title, description, reason, always}
permission-resolved {type, id, decision: allow|always|deny|cancelled}
result              {type, ok, durationMs, cost, tokens: {input, cached, output}, error}
notice              {type, text, level: info|error}
```

**Optional extras the renderer understands. Nothing breaks without them:**
- `parent` (a Task tool id) on `tool`, `tool-result`, `delta`, `text` and `reasoning`. With it, subagent work nests inside its Task card. That's the SDK's `parent_tool_use_id`.
- `durationMs` on `tool-result`. Without it, the duration is measured from arrival times, and anything under 50ms is shown as a check mark instead.

**How the reducer handles each case:**
- **Permissions and tool calls:** a permission isn't tied to a tool id in your shape. So while a permission is pending, any unfinished tool call with the same `name` shows "Approval" instead of a spinner. On `deny` or `cancelled`, those calls are marked "Not run" rather than "Failed".
- **Deny reason:** the reason a user types is kept client-side on the item (`item.reasonNote`) and sent with the decision. `permission-resolved` doesn't echo it back.
- **Token count:** the result line shows `input + cached + output` as "N tokens". The tooltip gives the breakdown.
- **Cost:** `cost: null` (Codex) is simply omitted.

### Wiring

```js
const state = createChatState({ key });            // one per chat
// for each server event:
const res = applyEvent(state, ev);                 // pure-ish reducer, returns {changed:Set<uid>, chrome:bool}
if (view.state === state) view.update(res);        // rAF-batched DOM patching
```

`createChatView(paneEl, handlers)` returns `{ show(state, meta), update(res), retitle(title), focusComposer() }`.
- `meta` is `{key, tool: 'claude'|'codex', title, cwd, branch, projectName, projectColor}`.
- `handlers` are `onSend(text, files)`, `onStop()`, `onDecide(permId, decision, reason?)`, `onModel(v)`, `onMode(v)`, `onBack()`, `onClose()`, `onTerminal()`, `onRename(title)` and `onRetry()`.
- In the prototype, `ingest(key, ev)` (section 10) is the single entry point. Point your SSE or WebSocket handler at it.

Mode values sent by the pickers:
- Claude: `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`.
- Codex: `ask`, `auto`, `full-access`.

`bypassPermissions` and `full-access` are styled as dangerous: a red chip, a red composer border and a warning line. The model lists are placeholders (`MODELS`); feed them from the server.

## Render functions (lift as-is)

All of them return DOM nodes built with `h(tag, attrs, ...kids)`. **No model or server text ever goes through `innerHTML`**; every string becomes a text node.

| Function | Input | Notes |
|---|---|---|
| `renderMessage(item, ctx)` | a reducer item (`kind`: user, assistant, reasoning, tool, permission, result, notice) | `ctx` = `{state, agent, cwd, projectName, isExpanded(id, def), onToggle(id), showAll(id), onShowAll(id), denyOpen(id), onDenyOpen(id, open), onDecide(id, d, reason), onRetry}` |
| `renderToolCard(tool, result, opts)` | `tool` event, `tool-result` event or null | `opts`: `{output, expanded, onToggle, showAll, onShowAll, children, childCount, awaiting, denied, interrupted, startedAt, durationMs, cwd}`. One-line header (icon, name, key argument, stats, status, chevron) that expands to a body. |
| `renderPermission(item, opts)` | `{req: permission event, decision, reasonNote}` | pending card (Allow / Always allow / Deny → reason field) or resolved strip |
| `renderMarkdown(text, {streaming})` | string | see below |
| `renderCodeBlock(code, lang)` | | header with language and Copy |
| `renderDiff(oldStr, newStr, opts)` | two strings | LCS line diff, 3 lines of context, gap rows, word-level marks |
| `renderPatch(hunks, opts)` | Claude `structuredPatch` | real line numbers |
| `renderUnifiedDiff(text, opts)` | Codex `diff[].diff` string | parsed into the same hunks |
| `renderTerminal(cmd, output, opts)` | | Bash and Codex commands. Shows the tail (14 lines) with "Show N earlier lines", plus exit status and copy. |
| `renderCodeView(rows, lang, opts)` | | numbered file view for Read and Write |
| `renderProjectTree(data, view)` | `GET api/projects` shape, unchanged | `view` = `{current, filter, showArchived, expanded:Set, desktop, onOpen, onToggle, onChatMenu, onProjectMenu, onNewChat, onEdit, onExternal}` |
| `renderOverview(status, view)` | `GET api/status` shape, unchanged | `view` = `{consoles:Set, onConsole, onAnswer, onRcRestart, onRestart, onLog, onExternal}` |
| `openSheet({title, body, foot, wide})`, `openMenu(anchor, items, title)`, `openProjectForm(project|null, onSave, onRemove)` | | one `<dialog>` each: a bottom sheet on phones, a centred dialog or anchored popover above 640px |

How each tool is rendered (`TOOL_INFO`):

| Tool | Rendering |
|---|---|
| `Bash` (Claude) / `Bash` (Codex; a command array with `bash -lc` is unwrapped) | terminal block |
| `Edit` / `MultiEdit` | diff. Uses `result.patch` when present; otherwise diffs `old_string` → `new_string` (also used in permission cards). |
| `Patch` (Codex) | diff from `result.diff[]` |
| `Write` | file preview |
| `Read` | numbered view (parses `N→line`) |
| `Grep` | grouped by file, matches highlighted |
| `Glob` | file list |
| `TodoWrite` | checklist, expanded by default |
| `WebFetch` | URL, prompt and the result as markdown |
| `WebSearch` | parses Claude's `Links: [...]` JSON into a link list |
| `Task` | prompt, nested children, result |
| `mcp__server__tool` and anything unknown | tool name, server tag, then the JSON input and output |

Errors (`ok: false`) get a red border and expand automatically.

### Markdown renderer

It's small and safe. Block parsing covers:
- fenced code (an unclosed fence renders as code, which suits streaming)
- headings (`#` renders as `h3`, so the panel title keeps `h2`)
- lists, including nested, ordered and task lists, with continuation lines
- blockquotes, tables with alignment, `hr`
- paragraphs, where single newlines become `<br>`

Inline parsing covers code spans, bold, italic, strikethrough, `[links](url)`, `<autolinks>` and bare URLs.
- Links only pass `http(s):`, `mailto:` and relative or `#` URLs. Everything else renders as plain text.
- While streaming, the whole message is re-parsed on each animation frame. That's fine at chat sizes; if very long messages get slow, re-render only the last block.

The syntax highlighter is regex-based (js/json/sh/py/yaml/css/dockerfile/diff) and also builds text nodes only.

## Class names (main components)

- **Shell:** `.appbar .brand .logo .tabs .tab .conn .bottomnav .nav-badge .views .view .view-scroll .toast`
- **Tree:**
  - containers: `.toolbar .search .toggle-chip .tree .proj(.is-open .other .drop-target) .proj-head .proj-toggle .proj-badges .proj-sub .proj-actions`
  - locations and chats: `.locs .loc .loc-head .loc-label .chats .chat-item(.is-selected) .chat-open .chat-title .chat-meta .chat-state .chat-more .tree-foot .legend`
- **Badges:** `.badge(.live .remote .pr .needs .warn .bad) .chip-branch .dot(.ok .warn .bad .ring .busy) .tool(.claude .codex .sm .lg .xl)`
  - Roost-UI session state shows in the row: `.dot.ring` = open in roost, `.dot.busy` = working, `.badge.needs` = waiting for approval, `.dot.bad` = error.
  - The existing `live` / `terminal` / `remote` / `PR` badges sit on the meta line.
- **Chat:**
  - header and stream: `.chat-pane .ch .title-btn .status(.s-idle .s-busy .s-needs .s-bad .s-off) .stream .stream-inner .ev(.ev-user .ev-assistant .ev-reasoning .ev-tool .ev-perm .ev-result .ev-notice .ev-error) .bubble .caret .live-ind .jump .empty-chat .sg-card`
  - tool cards: `.tc(.is-running .is-done .is-error .is-awaiting .is-denied .is-open) .tc-head .tc-arg .tc-body .term .diff .diff-table .cv .gl .fl .todos .links .task-children`
  - permission: `.perm .perm-actions .perm-deny .perm-done(.allowed .denied)`
  - composer: `.composer-wrap .composer(.is-danger) .ta .pick(.is-danger, [data-mode]) .send(.is-stop) .approval-banner .mode-warn`
- **Overview:** `.ov .ov-cols .sec-h .card .attn .attn-item .rc-row .rc-asking .console .lnk-list .lnk .cmd-row .svc .pill.<STATE>`
- **Sheets:** `.sheet(.wide .menu) .sheet-head .sheet-body .sheet-foot .field .seg .seg-opt .swatches .swatch-pick .switch-row .switch .menu-list .menu-item`

## Porting notes

- **Mock-only code:** the mock backend (`Mock`), `HISTORY` and `App.status`/`App.data` are mock-only. On page load the prototype replays each chat's history through `applyEvent`, the same path a real reload would take, so the reducer is exercised end to end.
- **Projects data:** the tree consumes the current `api/projects` shape. The only addition is the in-roost session status, which comes from the chat state (`App.chatStatus(key)`). From the server, a per-chat `uiStatus` would do the same job.
- **Overview data:** it consumes the current `api/status` shape. `setupSteps()` is the same logic as `renderSetup()` in `app.js`.
- **New project form:** keeps the same fields and rules as the current dialog: name; start from folder, git or existing paths; colour; pin. Edit adds Remote Control mode (worktree is disabled when not a repo) and "Remove grouping" (hidden for implicit projects).
- **Clipboard:** copy falls back to `execCommand('copy')`, because roost is usually served over plain http on the LAN, where `navigator.clipboard` isn't available.
- **Script tags in data:** if you inline the script, escape `</script>` inside string data as `<\/script>`. The mock data needed this.
- **Logo:** the logo mark is an inline SVG using `--accent`. `public/icon.svg` was not changed; the favicon in the prototype is a static blue variant.

## Rough edges

- **Tool duration with approval:** a tool's duration includes the time it waited for approval. It's measured from the `tool` event, because nothing links a permission to a tool id.
- **Long user messages:** they aren't clamped. Consider a "Show more" past around 12 lines.
- **Retry:** only shows on the latest error notice while `status` is `error`.
- **Row actions:** archive, move and resume in a terminal are in the ⋯ menu. Chats in the "Not in a project" bucket can't be moved into it, only out of it, which matches today's rules.
- **New chats:** the empty "New chat" exists only in the client until the first send. The server should create the chat on the first message.
