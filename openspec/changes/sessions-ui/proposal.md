# Proposal

## Why

Claude Code keeps every conversation as a `.jsonl` file under `~/.claude/projects/`. There are around 200 sessions across 29 projects, and the only way to see them is the `/resume` picker, one project at a time. Finding "which session touched this file" or cleaning up old sessions means `ls` and `rm` by hand, which has already gone wrong once (an aliased `rm` silently did nothing). This repo already stores one shared memory per project, keyed by `metadata.session`, so it is the natural place to show sessions next to the memories they produced.

## What Changes

- Add a local web page (`bun run sessions`) that lists all Claude Code sessions on this Mac, grouped by project, with title, branch, timestamps, size, files touched, PR link, cost, and a "live" badge for running sessions.
- Show the supermemory notes written by each session (joined on `metadata.session == sessionId`), read-only.
- Add mutating actions, all behind a two-step approval: the browser only creates a *pending* action, and it runs only after the user approves it in the terminal that runs the server.
  - **Delete** is a soft delete into `data/sessions-trash/`, with restore and purge. A live session can never be deleted. An optional, separate checkbox also deletes that session's supermemory notes.
  - **Rename and tags** are stored in a sidecar file in `data/`. Transcripts are never edited.
  - **Resume / new session** gives a ready-to-run `claude --resume <id>` command (or a new `claude` in a project folder).
- `~/.claude` stays read-only except for the approved soft delete. Raw transcript text is never sent anywhere.
- Out of scope: editing transcript contents, merging sessions, creating transcripts, starting the UI from `start.sh`, other agents' sessions (Antigravity, OpenCode).

## Capabilities

### New Capabilities
- `session-catalog`: scans `~/.claude` and exposes each session's metadata (project, title, branch, times, size, files touched, PR link, cost), live status, and linked supermemory notes.
- `session-actions`: the approval workflow plus the actions behind it: soft delete, restore, purge, rename and tags, and resume commands.
- `sessions-ui-server`: the localhost web server and page, including how it is started, bound, and protected against requests from other origins.

### Modified Capabilities
<!-- none: the repo has no existing specs; hooks and memory behavior are untouched -->

## Impact

- **New code:** a server entry under `bin/` and modules under `src/` (scanner, action/approval state machine, trash, sidecar, HTTP routes, static page), with unit tests in `src/*.test.ts`.
- **Changed files:** `package.json` (new `sessions` script), `.env.example` (`SESSIONS_UI_PORT`, default 20131), `README.md`, `CLAUDE.md`.
- **Dependencies:** none added at runtime. Bun built-ins only.
- **Data:** reads `~/.claude/projects`, `~/.claude/sessions`, `~/.claude/file-history`, and the existing supermemory server on `:6767`. Writes only under `data/` (sidecar, trash), plus the approved move out of `~/.claude`.
- **Untouched:** the hooks, `hook-handler.ts`, `llm-proxy.ts`, `zed-adapter.ts`, `start.sh`, and the `containerTag` derivation.
