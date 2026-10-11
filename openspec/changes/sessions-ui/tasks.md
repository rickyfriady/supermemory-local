# Tasks

## 1. Scanner and catalog (read-only)

- [ ] 1.1 Create `src/sessions-scan.ts` with a transcript parser that extracts id, cwd, branch, version, first and last timestamps, latest title, PR link, cost, first and last prompt, and files from Edit/Write `tool_use`. Verify with `bun test -t "parseSession"` against trimmed real-shape fixtures, including a malformed line, a file with no title, and a file with no cost.
- [ ] 1.2 Add live-session detection from `~/.claude/sessions/<pid>.json` (pid alive and session id match). Verify with a test using a temp directory holding one record for the current process and one for a dead pid.
- [ ] 1.3 Add the catalog builder: group by cwd, sort by last activity, skip empty projects, and cache parsed sessions by mtime and size. Verify with a test that a second build does not re-read an unchanged file and does re-read a modified one.
- [ ] 1.4 Add search and filter helpers (title, prompts, file path, tag, project, live, sort by recency or size). Verify with unit tests for each filter and a combined project + term case.
- [ ] 1.5 Smoke-check on real data: run the catalog against `~/.claude` and confirm the session count matches `find ~/.claude/projects -name '*.jsonl' | wc -l` and that first-load time is printed and under a few seconds (if not, note it for the SQLite follow-up).

## 2. Linked memories

- [ ] 2.1 Add memory linking in `src/sessions-scan.ts` using `resolveProject` and `SupermemoryClient.listDocuments`, matching `metadata.session`, with lazy excerpt fetch via `getDocument`. Verify with a test using a fake client, including the server-down case returning "unavailable" and the catalog still loading.
- [ ] 2.2 Verify the no-leak requirement: a test that fails if any request body other than the local memory-server calls is attempted while building the catalog (assert only session ids and container tags are sent).

## 3. Actions: approval, trash, sidecar

- [ ] 3.1 Create `src/sessions-actions.ts` with the pending-action state machine (pending, approved, rejected, expired, done, failed), serialized one-at-a-time terminal approval through an injected prompt function, and 5-minute expiry. Verify with tests for approve, reject, expire, and "no HTTP-facing function can approve".
- [ ] 3.2 Implement soft delete into `data/sessions-trash/<ts>_<id>/` with a manifest, rename with `EXDEV` copy fallback, a UUID check on every id, and live re-check right before the move. Verify with temp-directory tests: all three artifacts move, a live session is refused at request and at execution, and a malformed id is rejected.
- [ ] 3.3 Implement restore (refuse if any target exists) and purge. Verify with tests for a clean restore, a restore blocked by an existing file with nothing overwritten, and purge removing the trash folder.
- [ ] 3.4 Implement the sidecar `data/sessions-meta.json` (name, tags, atomic write) and the audit log `data/sessions-ui.log`. Verify that rename leaves the transcript byte-identical (hash before and after), that name and tags survive delete then restore, and that each outcome writes one log line.
- [ ] 3.5 Implement the optional linked-memory deletion using `client.request('DELETE', '/v3/documents/:id')` with per-note results. Verify with a fake client returning 200 for one note and 409 for another: files still go to trash and the result lists the 409 note.
- [ ] 3.6 Implement resume and new-session command strings with safe shell quoting. Verify with a test using a working directory that contains spaces and a single quote.

## 4. Server and page

- [ ] 4.1 Create `src/sessions-server.ts` and `bin/sessions-ui.ts`: `Bun.serve` on `127.0.0.1` with `SESSIONS_UI_PORT` (default 20131), refuse to start when stdin is not a TTY or the port is taken (clear message), and print the URL. Verify by running `bun run sessions` and seeing the URL, then running it with `< /dev/null` and seeing the refusal.
- [ ] 4.2 Add request guards: `Host` check, `Origin` check on state-changing requests, per-run token on every `/api` route, and CSP with a per-response nonce. Verify with tests (or `curl`) for wrong Host, foreign Origin, missing token, and a valid request; the foreign-Origin POST must create no pending action.
- [ ] 4.3 Add API routes: list catalog, session detail with memories, create pending action, read action state, list trash. There is deliberately no approve route. Verify with a test that enumerates the routes and asserts none can change an action's state to approved.
- [ ] 4.4 Build the single-file page (no external resources): project groups, session rows with live and deleted badges, search and filters, detail panel, copy-command buttons, typed-short-id modal, "waiting for approval in terminal" state, trash view with restore and purge. All transcript-derived text via `textContent`. Verify in a browser: offline load works, a title containing `<img onerror=...>` renders as plain text, and the network panel shows no third-party requests.

## 5. Integration, docs, and wrap-up

- [ ] 5.1 Add `"sessions"` to `package.json` scripts and `SESSIONS_UI_PORT=20131` to `.env.example`. Verify `bun run sessions` starts and `bun run typecheck` passes.
- [ ] 5.2 End-to-end check with a throwaway session: create a dummy `.jsonl` under a temp project folder in `~/.claude/projects`, delete it from the page, approve in the terminal, confirm it appears in trash and not in the catalog, restore it, then purge it. Verify each step by listing the folders.
- [ ] 5.3 Confirm existing stack is unaffected: with the UI running, run `bun test`, `bun run test-memory`, and pipe a payload into `bin/supermemory-hook.ts claude-code start`; verify identical output to before.
- [ ] 5.4 Update `README.md` (Indonesian) with a "Sessions UI" section (start, approval flow, trash, ports) and `CLAUDE.md` with the architecture notes and invariants (read-only except approved soft delete; no HTTP approve route; transcripts never edited; foreground only). Verify by following the documented commands from a clean shell.
- [ ] 5.5 Run `bun run format:check` and `bun run typecheck`, and fix findings. Verify both exit 0.

## Workflow follow-up

- Archive the change after review with `/opsx:archive`.
