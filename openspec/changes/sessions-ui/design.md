# Design

## Context

See `proposal.md` for motivation. Facts about the data that shape the approach (checked on this machine):

- A session is `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, plus an optional sibling folder `<sessionId>/` and `~/.claude/file-history/<sessionId>/`. About 200 files, 213 MB in total, largest around 1 MB.
- Each line is JSON with a `type`. Useful ones: `user`/`assistant` (carry `cwd`, `gitBranch`, `version`, `timestamp`), `ai-title`, `pr-link`, `cost-state`, and `tool_use` blocks with `file_path`. `file-history-snapshot` entries sampled were empty, so they are not used.
- `~/.claude/sessions/<pid>.json` holds `{pid, sessionId, cwd, startedAt}` for running processes. Probing the pid tells live from stale.
- Hooks already store notes with `metadata.session = <sessionId>` under `containerTag = proj_<name>_<hash>`, so sessions and memories share a key.
- Repo conventions: Bun-only, no runtime dependencies, flat `src/`, tests in `src/*.test.ts`, `Bun.serve` services like `llm-proxy.ts` and `zed-adapter.ts`, `// ponytail:` for deliberate shortcuts.

## Goals / Non-Goals

**Goals:**
- Read-only browsing that is fast enough to feel instant on ~200 sessions.
- No change can happen without a human decision made outside the browser.
- Every deletion is reversible until explicitly purged.
- Reuse `SupermemoryClient` and `resolveProject` instead of re-implementing them.

**Non-Goals:**
- Parsing the full conversation for display (no transcript viewer). Only metadata and excerpts of the first and last prompt are shown.
- A persistent database or index. Revisit only if the scan becomes slow.
- Multi-user access, auth beyond the per-run token, or running as a background service.
- Other agents' sessions (Antigravity, OpenCode).

## Decisions

### D1. Plain scan with an in-memory cache, no database
Each request reads the session list; a session is re-parsed only when its `mtime` or size changed. First load parses all files once (about 213 MB of JSONL, expected a few seconds), later loads are near-instant.
*Alternative:* `bun:sqlite` index. Rejected for now: it adds a stale-cache failure mode and a rebuild command for a data set that fits in memory. `// ponytail: in-memory cache, add a SQLite index if first load exceeds a few seconds`.

### D2. Approval happens on the terminal, not in HTTP
The HTTP API can only create pending actions (`POST /api/actions`) and read their state. A single approval queue in the server process prompts on stdin (`y/N`, one action at a time, with kind, session title, short id and file count). There is no HTTP route that approves, so a forged request, another page, or an agent with `curl` cannot approve. Pending actions expire after 5 minutes.
The server refuses to start when stdin is not a TTY, since nobody could approve anything.
*Alternatives:* browser-only confirm (bypassable by any local request); one-time code typed into the browser (still approvable by anything that can read the terminal output, and clumsier).
The typed short-id modal in the browser stays as the first, cheap speed bump; the terminal prompt is the real gate.

### D3. Soft delete layout and move semantics
```
data/sessions-trash/<unixtime>_<sessionId>/
    manifest.json      original absolute paths, project cwd, title, deleted-at
    transcript.jsonl
    session-dir/       (if it existed)
    file-history/      (if it existed)
```
Moves use `fs.renameSync`; on `EXDEV` fall back to copy then remove. Restore reads the manifest, refuses if any target exists, and moves back. Purge removes the trash folder. All paths are built from a validated session id (UUID pattern) and fixed roots; client-supplied paths are never used, which rules out traversal.
The live check runs twice: when the request arrives and again right before the move.

### D4. Rename and tags in a sidecar
`data/sessions-meta.json`: `{ [sessionId]: { name?, tags[] } }`, written atomically (temp file then rename). It is keyed by session id, so it survives delete and restore. The transcript is never opened for writing.
*Alternative:* append a title entry to the transcript so Claude Code's picker shows it. Rejected: it breaks the "transcripts are never modified" guarantee that makes this tool safe to trust.

### D5. Linking memories
For each project group, resolve the container tag with `resolveProject(cwd)` and call `listDocuments` once; match `metadata.session` to session ids. Excerpts (`getDocument`) are fetched lazily when a session is expanded. If the memory server is down, the response marks memories as unavailable.
Optional memory deletion uses `client.request('DELETE', '/v3/documents/:id')` per note and reports each result (409 while a note is still processing).

### D6. Server hardening
`Bun.serve` on `127.0.0.1` only. Every request: check `Host` equals `127.0.0.1:<port>` or `localhost:<port>`; state-changing requests also require `Origin` equal to the server origin; every `/api` call requires the per-run token (random 32 bytes, injected into the served page). Responses carry `Content-Security-Policy` with a per-response script nonce and `default-src 'none'`, so the page cannot load anything external. The page writes transcript-derived text with `textContent` only (never `innerHTML`), because titles and prompts are untrusted.

### D7. Module layout (flat, fewest files)
- `bin/sessions-ui.ts`: entry, wires config and starts the server.
- `src/sessions-scan.ts`: transcript parsing, live detection, catalog and cache. Pure parsing functions are exported for tests.
- `src/sessions-actions.ts`: pending-action state machine, terminal approval, trash, sidecar, audit log. Takes the filesystem roots and the prompt function as arguments so tests can use temp directories and a fake prompt.
- `src/sessions-server.ts`: routes, security checks, and the single-file page (HTML, CSS, JS as one string, no build step).
- `package.json` gets `"sessions": "bun --env-file=.env bin/sessions-ui.ts"`. `--env-file` follows the existing rule for entry points; `SESSIONS_UI_PORT` is added to `.env.example`.

### D8. Resume and new-session commands are text only
The server returns a string such as `cd '<cwd>' && claude --resume <id>` with the path shell-quoted; the page offers a copy button. The server never spawns `claude` or a terminal.

## Risks / Trade-offs

- **First load is slow on a big history** → in-memory cache keyed by mtime and size; only head lines, `ai-title`, `pr-link`, `cost-state`, and `tool_use` paths are kept, never whole transcripts in memory.
- **Claude Code's file format changes** → every parser tolerates unknown or malformed lines and falls back to the first prompt as title; unit tests use trimmed real-shape fixtures.
- **A session starts running between approval and move** → live check repeated right before the move; the action fails with a clear message.
- **`listDocuments` returns a limited page** (the hooks use 50) → memory links for very active projects may be incomplete. Mitigation: request a larger limit and show "memories may be incomplete" when the page is full.
- **`resolveProject` for a deleted working directory** gives a different hash than the original, so links may be missing for old sessions → show them as "no linked memories" rather than guessing.
- **Pid reuse could show a stale session as live** → the failure direction is safe (it only blocks a delete).
- **Terminal prompt blocks the server's stdin** → by design, one action at a time; the web page keeps showing "waiting for approval in terminal".
- **Trash grows** → listed with sizes in the page; purge is an explicit approved action. No automatic expiry.

## Migration Plan

Purely additive: new files, one `package.json` script, one `.env.example` line, README and CLAUDE.md sections. Rollback is deleting those files. The trash and sidecar live under the gitignored `data/` directory.
