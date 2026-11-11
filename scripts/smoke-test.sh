#!/usr/bin/env bash
# smoke-test.sh <image>: boot the image and check every front-door route answers.
set -euo pipefail

image="${1:-roost:test}"
name="roost-smoke-$$"
port="${SMOKE_PORT:-17680}"
auth="roost:smoke-test-pw"
tmp="$(mktemp -d)"

# shellcheck disable=SC2329 # invoked via trap
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "---- container logs ----"
    docker logs "$name" 2>&1 | tail -n 100 || true
    echo "---- service logs ----"
    docker exec "$name" bash -c 'for f in /config/roost/logs/*.log; do echo "== $f"; tail -n 20 "$f"; done' 2>&1 || true
  fi
  docker rm -f "$name" > /dev/null 2>&1 || true
  rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT

docker run -d --name "$name" --shm-size=1g \
  -e ROOST_PASSWORD=smoke-test-pw \
  -p "127.0.0.1:$port:7680" \
  "$image" > /dev/null

echo "waiting for healthy..."
for _ in $(seq 1 60); do
  state="$(docker inspect -f '{{.State.Health.Status}}' "$name" 2> /dev/null || echo starting)"
  [ "$state" = healthy ] && break
  sleep 2
done
[ "$state" = healthy ] || { echo "container never became healthy ($state)"; exit 1; }
sleep 5 # let the slower services (code-server, chromium) settle

check() { # check <path> <expected status> [auth]
  local path="$1" want="$2" use_auth="${3:-yes}" got
  if [ "$use_auth" = yes ]; then
    got="$(curl -s -o /dev/null -w '%{http_code}' -u "$auth" "http://127.0.0.1:$port$path")"
  else
    got="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$path")"
  fi
  if [ "$got" = "$want" ]; then echo "ok   $path -> $got"; else echo "FAIL $path -> $got (want $want)"; return 1; fi
}

fail=0
check / 401 no || fail=1
check / 200 || fail=1
check /api/status 200 || fail=1
check /code/ 302 || fail=1 # redirects to ./?folder=/workspace
check "/code/?folder=/workspace" 200 || fail=1
check /files/ 200 || fail=1
check /files/api/resources?source=workspace\&path=/ 200 || fail=1
check /term/ 200 || fail=1
check /vnc/vnc.html 200 || fail=1

curl -fsS -u "$auth" "http://127.0.0.1:$port/api/status" > "$tmp/status.json"
echo "services:"
jq -r '.services[] | "  \(.name): \(.state)"' "$tmp/status.json"
not_running="$(jq -r '[.services[] | select(.state != "RUNNING") | .name] | join(" ")' "$tmp/status.json")"
if [ -n "$not_running" ]; then echo "FAIL services not running: $not_running"; fail=1; fi
if jq -e '.browser.up == true' "$tmp/status.json" > /dev/null; then echo "ok   browser CDP up"; else echo "FAIL browser CDP down"; fail=1; fi

# A POST without the anti-CSRF header must be refused.
got="$(curl -s -o /dev/null -w '%{http_code}' -u "$auth" -X POST "http://127.0.0.1:$port/api/services/ttyd/restart")"
if [ "$got" = 403 ]; then echo "ok   CSRF guard"; else echo "FAIL CSRF guard -> $got"; fail=1; fi

docker exec -u roost "$name" bash -lc 'claude --version && codex --version && playwright-mcp --version && gh --version | head -1 && uv --version' || fail=1
docker exec "$name" bash -c 'test "$(stat -c %U /config/home)" = roost' && echo "ok   home owned by roost" || fail=1
docker exec "$name" bash -c '! pgrep -u root -x claude' > /dev/null && echo "ok   no agent processes as root" || fail=1

exit "$fail"
