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
claude_chat /workspace/api 11111111-1111-4111-8111-111111111111 "Add rate limiting to the login endpoint" 5 "add rate limiting to /login" remote
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
