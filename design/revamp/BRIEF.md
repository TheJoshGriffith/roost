# roost UI revamp: shared brief for mockups

roost is a self-hosted web dashboard (runs in a Docker container on a home server) for running and supervising
AI coding agents (Claude Code and Codex) against projects in /workspace. The owner uses it from a desktop browser
(often a wide monitor) and sometimes a phone. Current UI: design/roost-ui-prototype.html and design/roost-ui-notes.md
(read both for the full feature set and realistic content). The owner's verdict on the current UI: too large and
chonky, "kinda IDE style but not quite right", and important content does not fill the page (the chat is a narrow
column in a sea of whitespace; a 400px card-based project tree eats the left side). They want something DIFFERENT
and better, not a reskin. Everything is in scope, including flows and information architecture.

## Everything the product does (every mockup must have a home for all of it)
- Projects: named groups of folders/repos in /workspace, each with a colour, pin, git branch, PR links (#145),
  and its chats. "Not in a project" bucket. Archived chats. New project (from folder, git clone, existing paths).
  Edit project, Remote Control mode per project. Filter/search.
- Chats (sessions) with Claude or Codex: title (renamable), project, cwd, branch, prompt count, age, live/terminal/remote
  badges, PRs. States: idle, starting, thinking, responding, running a tool, WAITING FOR APPROVAL (needs the user), error,
  offline/closed. Start new chat (Claude or Codex) in a project. Archive, move to project, resume in terminal.
- Chat transcript: user messages (with attachments), assistant markdown (code blocks, tables, lists), reasoning (collapsible),
  tool calls (Bash with terminal output, Edit/Write with diffs, Read with code view, Grep/Glob results, TodoWrite checklist,
  WebFetch/WebSearch, Task = subagent with nested children, MCP tools), permission requests (Allow / Always allow / Deny with reason),
  per-turn result line (duration, tokens, cost), notices (context compacted), errors with retry.
- Composer: multiline, attach files/pictures (paste/drop), model picker, permission mode picker
  (Claude: default, acceptEdits, plan, auto, bypassPermissions | Codex: ask, auto, full-access; bypass/full-access are dangerous = red),
  send, stop, send-while-working (message joins the running turn), Esc to stop.
- Overview: plan usage (Claude 5-hour and 7-day windows, per-model; Codex 7-day) with pace ticks; agents status
  (Claude Code Remote Control server per folder with console/restart; Codex signed in); quick links to VS Code, Files,
  Terminal, Claude CLI, Browser (VNC); SSH connect info; things needing attention (setup steps).
- Secrets: env-var secrets (write-only values), SSH keys with host lists and Test, GitHub/GitLab connect.
- Viewer: shared Chromium (VNC) and web previews of dev servers, docked right/bottom, floating or maximised.
- Global: live connection indicator, light/dark/system theme, "N chats need you" badge.

## Requirements for each mockup
- ONE self-contained HTML file (inline CSS + JS, no network requests, no external fonts/CDNs; system font stacks only;
  inline SVG icons). Put it at design/revamp/<your-file>.html.
- Clickable: navigating between the main screens works (open a chat, switch views, open command palette / menus
  where relevant, approve a permission, toggle theme if you have both). Mock data only, hard-coded, but REALISTIC and dense:
  use projects like TibiaTools (a game-bot tool, branch fix/limitedkite-nearest-box, PRs #145 #67), Roost (this dashboard,
  branch main), TibiaGuru, homelab-compose, plus a "Not in a project" bucket; 15-25 chats across them; one chat
  waiting for approval, two working, one errored. A rich transcript in the open chat: markdown with a list and code,
  a Bash call with output, an Edit with a coloured diff, a TodoWrite list, a pending permission card, a result line.
- Must look great at 1440x900 AND at 1920x1080 (content fills the space sensibly, no dead whitespace oceans),
  and have a usable phone layout at 390px wide (can be simpler).
- Compact, information-dense, crisp. Dense does not mean cramped: strong hierarchy, alignment, restraint.
  Small type (12-14px UI), tight rows (24-30px list rows on desktop), precise 1px borders, considered colour.
- No "AI slop" defaults: avoid generic purple gradients, emoji, glassmorphism, big rounded cards everywhere,
  drop shadows on everything. Have a point of view. Make the agent states (especially "needs you") unmissable.
- Keep the claude badge colour #d97757 and codex #1c1c1e for tool identity.
- At the top of the file, an HTML comment of 10-20 lines: the concept name, the idea in two sentences,
  the key layout decisions, and how each product area above maps into it.
- Do not modify anything outside design/revamp/. Do not start servers. Do not commit.
- Quality bar: this is shown to the owner to choose a direction. It must feel like a real, finished product
  screenshot, not a wireframe. Check your work: open it in the browser MCP tools if available (file:// URL),
  screenshot at 1440x900 and 390x844, and fix anything broken or ugly before finishing.
