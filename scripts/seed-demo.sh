#!/usr/bin/env bash
# seed-demo.sh <container>: fill a throwaway roost container with demo projects
# and fake Claude/Codex transcripts, for testing the Projects view. Never run it
# against a real instance.
set -euo pipefail
c="${1:?usage: seed-demo.sh <container>}"

docker exec -u roost -i "$c" bash -s <<'EOF'
set -euo pipefail
cd /workspace
git config --global user.name demo >/dev/null; git config --global user.email demo@example.com >/dev/null
for r in api web; do
  mkdir -p "$r" && cd "$r" && git init -q && echo "# $r" > README.md && git add . && git commit -qm init && cd ..
done
git -C api worktree add -q .claude/worktrees/fix-auth -b fix-auth
mkdir -p notes scratch

ts() { date -u -d "-$1 minutes" +%Y-%m-%dT%H:%M:%S.000Z; }
claude_chat() { # dir id title minutes-ago prompt [remote]
  local dir="$1" id="$2" title="$3" ago="$4" prompt="$5" enc
  enc="$(echo "$dir" | sed 's#[/.]#-#g')"
  mkdir -p "$HOME/.claude/projects/$enc"
  local f="$HOME/.claude/projects/$enc/$id.jsonl"
  {
    printf '{"type":"user","sessionId":"%s","cwd":"%s","gitBranch":"main","timestamp":"%s","message":{"role":"user","content":"%s"}}\n' "$id" "$dir" "$(ts "$ago")" "$prompt"
    printf '{"type":"assistant","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"role":"assistant","content":[{"type":"text","text":"On it. Let me look at the code first."},{"type":"tool_use","name":"Bash","input":{"command":"rg -n TODO src/"}}]}}\n' "$id" "$dir" "$(ts "$ago")"
    printf '{"type":"user","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"role":"user","content":[{"type":"tool_result","content":"src/a.ts:1: TODO"}]}}\n' "$id" "$dir" "$(ts "$ago")"
    printf '{"type":"assistant","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"role":"assistant","content":[{"type":"text","text":"Done: I fixed the TODO and ran the tests."}]}}\n' "$id" "$dir" "$(ts "$ago")"
    printf '{"type":"ai-title","sessionId":"%s","aiTitle":"%s"}\n' "$id" "$title"
    [ -n "${6:-}" ] && printf '{"type":"bridge-session","sessionId":"%s","bridgeSessionId":"cse_demo"}\n' "$id"
    true
  } > "$f"
  touch -d "-$ago minutes" "$f"
}
# A richer chat for screenshots: read, edit (with a structured patch), test run, markdown summary.
mkdir -p /workspace/api/src/routes
python3 - "$(ts 6)" "$(ts 5)" <<'PY'
import json, os, sys
t0, t1 = sys.argv[1], sys.argv[2]
sid = "11111111-1111-4111-8111-111111111111"
d = os.path.expanduser("~/.claude/projects/-workspace-api"); os.makedirs(d, exist_ok=True)
base = {"sessionId": sid, "cwd": "/workspace/api", "gitBranch": "main"}
L = []
def u(content, **kw): L.append({**base, "type": "user", "timestamp": t0, "message": {"role": "user", "content": content}, **kw})
def a(blocks): L.append({**base, "type": "assistant", "timestamp": t1, "message": {"role": "assistant", "content": blocks}})
old = "router.post('/login', async (req, res) => {\n  const { email, password } = req.body;\n  const user = await users.verify(email, password);"
new = "router.post('/login', loginLimiter, async (req, res) => {\n  const { email, password } = req.body;\n  const user = await users.verify(email, password);"
u("Add rate limiting to the /login endpoint: 5 attempts per minute per IP, and a test for it.")
a([{"type": "text", "text": "I'll look at the login route first."},
   {"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "/workspace/api/src/routes/login.ts"}}])
u([{"type": "tool_result", "tool_use_id": "t1", "content": "\n".join(f"{i:6}\u2192{l}" for i, l in enumerate([
  "import { Router } from 'express';", "import { users } from '../users';", "", "const router = Router();", "",
  "router.post('/login', async (req, res) => {", "  const { email, password } = req.body;", "  const user = await users.verify(email, password);",
  "  if (!user) return res.status(401).json({ error: 'invalid credentials' });", "  res.json({ token: user.issueToken() });", "});"], 1))}])
a([{"type": "text", "text": "There's no limiter yet. I'll add `express-rate-limit` scoped to this route."},
   {"type": "tool_use", "id": "t2", "name": "Edit", "input": {"file_path": "/workspace/api/src/routes/login.ts", "old_string": old, "new_string": new}}])
u([{"type": "tool_result", "tool_use_id": "t2", "content": "The file /workspace/api/src/routes/login.ts has been updated."}],
  toolUseResult={"filePath": "/workspace/api/src/routes/login.ts", "structuredPatch": [
    {"oldStart": 1, "oldLines": 6, "newStart": 1, "newLines": 14, "lines": [
      " import { Router } from 'express';", "+import rateLimit from 'express-rate-limit';", " import { users } from '../users';", " ",
      " const router = Router();", " ", "+// 5 attempts per minute per IP; successful logins don't count.",
      "+const loginLimiter = rateLimit({", "+  windowMs: 60_000,", "+  limit: 5,", "+  skipSuccessfulRequests: true,", "+});", "+"]},
    {"oldStart": 6, "oldLines": 3, "newStart": 14, "newLines": 3, "lines": [
      "-router.post('/login', async (req, res) => {", "+router.post('/login', loginLimiter, async (req, res) => {",
      "   const { email, password } = req.body;", "   const user = await users.verify(email, password);"]}]})
a([{"type": "tool_use", "id": "t3", "name": "Bash", "input": {"command": "npm test -- login", "description": "Run the login tests"}}])
u([{"type": "tool_result", "tool_use_id": "t3", "content": "PASS  test/login.test.ts\n  POST /login\n    \u2713 issues a token for valid credentials (41 ms)\n    \u2713 rejects a bad password (12 ms)\n    \u2713 returns 429 after 5 failed attempts (88 ms)\n\nTests:       3 passed, 3 total"}],
  toolUseResult={"stdout": "PASS  test/login.test.ts\n  POST /login\n    \u2713 issues a token for valid credentials (41 ms)\n    \u2713 rejects a bad password (12 ms)\n    \u2713 returns 429 after 5 failed attempts (88 ms)\n\nTests:       3 passed, 3 total", "stderr": "", "interrupted": False})
a([{"type": "text", "text": "## Done\n\n`/login` is now rate limited:\n\n- **5 attempts per minute per IP**, via `express-rate-limit`\n- successful logins don't count towards the limit\n- over the limit returns `429 Too Many Requests`\n\nThe new test covers the 429 case, and all 3 login tests pass:\n\n```sh\nnpm test -- login\n```"}])
L.append({"type": "ai-title", "sessionId": sid, "aiTitle": "Add rate limiting to the login endpoint"})
L.append({"type": "bridge-session", "sessionId": sid, "bridgeSessionId": "cse_demo"})
L.append({"type": "pr-link", "sessionId": sid, "prUrl": "https://github.com/example/api/pull/42", "prNumber": 42})
open(os.path.join(d, sid + ".jsonl"), "w").write("\n".join(json.dumps(x, separators=(",", ":")) for x in L) + "\n")
PY
touch -d "-5 minutes" "$HOME/.claude/projects/-workspace-api/11111111-1111-4111-8111-111111111111.jsonl"
claude_chat /workspace/api 22222222-2222-4222-8222-222222222222 "Investigate flaky integration tests" 300 "why are the integration tests flaky?"
claude_chat /workspace/api/.claude/worktrees/fix-auth 33333333-3333-4333-8333-333333333333 "Fix token refresh race" 0 "fix the token refresh race" remote
claude_chat /workspace/web 44444444-4444-4444-8444-444444444444 "Dark mode for the settings page" 1500 "add dark mode to settings"
claude_chat /workspace 55555555-5555-4555-8555-555555555555 "Plan the Q1 roadmap" 60 "help me plan the roadmap" remote
claude_chat /workspace/notes 66666666-6666-4666-8666-666666666666 "Summarise meeting notes" 4000 "summarise these notes"

mkdir -p "$HOME/.codex/sessions/2026/11/10"
id=77777777-7777-4777-8777-777777777777
f="$HOME/.codex/sessions/2026/11/10/rollout-2026-11-10T10-00-00-$id.jsonl"
{
  printf '{"type":"session_meta","timestamp":"%s","payload":{"id":"%s","cwd":"/workspace/web","timestamp":"%s","git":{"branch":"main"}}}\n' "$(ts 90)" "$id" "$(ts 90)"
  printf '{"type":"response_item","timestamp":"%s","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd</environment_context>"}]}}\n' "$(ts 90)"
  printf '{"type":"response_item","timestamp":"%s","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Refactor the API client to use fetch"}]}}\n' "$(ts 90)"
  printf '{"type":"response_item","timestamp":"%s","payload":{"type":"function_call","name":"shell","arguments":"{\\"command\\":[\\"rg\\",\\"axios\\"]}"}}\n' "$(ts 89)"
  printf '{"type":"response_item","timestamp":"%s","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Replaced axios with fetch in 4 files."}]}}\n' "$(ts 88)"
} > "$f"
touch -d "-88 minutes" "$f"
printf '{"id":"%s","thread_name":"Swap axios for fetch","updated_at":"%s"}\n' "$id" "$(ts 88)" > "$HOME/.codex/session_index.jsonl"
echo "seeded demo data"
EOF
