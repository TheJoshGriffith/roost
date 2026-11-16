# Board API contract (Mission Control)

The board shows every session's live state without opening a stream per chat (browsers allow
only 6 HTTP/1.1 connections per host; the dashboard keeps one SSE stream, for the chat on screen).
So the server keeps a small summary per live session and exposes it on the existing list endpoint.

## `GET /api/live` (existing) — each entry in `sessions[]` gains `board`

```jsonc
{
  "key": "claude:<id>", "keys": [...], "tool": "claude", "cwd": "/workspace/x",
  "status": "idle|starting|thinking|responding|tool|waiting|error|closed|offline",
  "running": true, "pending": 1, "lastActive": 1794790540806,
  "board": {
    "title": "string|null",            // chat title if known (may be null; client falls back to api/projects)
    "model": "opus|null", "mode": "auto|default|...",
    "turnStartedAt": 1794790500000,     // ms, null when idle
    "activity": {                       // what it is doing right now; null when idle/waiting
      "verb": "Running|Editing|Writing|Reading|Searching|Fetching|Thinking|Responding|Delegating|Using",
      "target": "npm test -- lanes",    // command, file path (relative to cwd when inside it), pattern, URL or tool name
      "tool": "Bash", "since": 1794790530000
    },
    "tail": ["last", "≤5 lines", "of the running or last tool's output"],  // [] when none; each line ≤ 200 chars
    "permissions": [                    // pending approvals, oldest first
      { "id": "perm-id", "name": "Bash", "title": "Claude wants to run Bash",
        "summary": "git push -u origin fix/x",   // command / file path / url: the one line that matters
        "description": "string|null", "always": "Bash(git push:*)|null",       // label for Always allow, if offered
        "at": 1794790540000 }
    ],
    "todos": { "done": 3, "total": 6, "current": "Add tests for the adjacent-box case" } | null,
    "lastTurn": { "ok": true, "durationMs": 128000, "cost": 0.74, "tokens": 61200,
                  "files": 3, "added": 55, "removed": 7, "endedAt": 1794790540000, "error": "string|null" } | null,
    "tokens": { "input": 0, "cached": 0, "output": 0 },   // session totals so far
    "error": "string|null"              // current error text when status is error
  }
}
```

Rules:
- Summaries update as events arrive (server side, in the session's emit path). Cheap: no transcript re-reads.
- `files/added/removed` count Edit/MultiEdit/Write/Patch results in that turn (best effort from patches/diffs).
- Answering a permission keeps using the existing `POST /api/live/permission {key, id, decision, message}`.
- Retry keeps using the existing send path.
- Sessions that are not live (closed transcripts) are not in this list; the board gets them from `GET /api/projects`
  (unchanged) and shows them in the Idle / Recently finished lanes using its existing fields.
- Frontend polls `GET /api/live` every 2 s while the board is visible (and on SSE `status` events), else every 5 s.
