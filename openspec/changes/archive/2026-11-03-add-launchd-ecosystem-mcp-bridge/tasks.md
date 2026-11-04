# Tasks

## 1. Foreground runner

- [x] 1.1 Create `scripts/run.sh <server|llm-proxy|zed-adapter>` carrying `start.sh`'s `.env` loading, store selection (`data/stores/<model>-<dims>d`, `data/current` symlink) and env exports, ending in `exec`; verify each component runs attached to the terminal and answers on its port (after stopping the legacy daemons with the old `bun run stop`)
- [x] 1.2 Verify `scripts/run.sh` with an unknown component or missing `OPENAI_API_KEY` exits non-zero with a message naming the problem

## 2. LaunchAgents and controller

- [x] 2.1 Create `scripts/service.sh` with `start` that generates the three `com.supermemory-local.*` plists (RunAtLoad, KeepAlive, logs in `data/`, `$PROJECT_ROOT`/`$HOME`/`command -v bun` substituted) into `~/Library/LaunchAgents` and bootstraps them; verify `plutil -lint` passes on each and all three ports answer
- [x] 2.2 Add the single-runtime port guard to `start`; verify starting while a foreground `scripts/run.sh server` holds 6767 exits non-zero naming port 6767 and the holder, and loads no LaunchAgent
- [x] 2.3 Add the 9router check to `start` (warn + `launchctl kickstart gui/$UID/com.9router.autostart` hint, continue); verify the warning text appears when 9router does not answer (simulated with a failing `curl` on PATH, so `.env` stays untouched)
- [x] 2.4 Add `stop` (bootout, wait until unloaded and ports free), `restart` (stop then start), `logs`; verify two consecutive `restart`s leave all three ports answering and `stop` leaves none listening
- [x] 2.5 Verify restart-on-exit: `kill` the llm-proxy PID; it answers again within 30 s while the server PID is unchanged
- [x] 2.6 Verify portability: `grep -rn "/Users/" scripts/ package.json` returns nothing

## 3. Status, package scripts, cleanup, docs

- [x] 3.1 Update `scripts/status.sh`: per-label launchd state, drop the PID-file branch, exit 1 when the memory API or LLM proxy is down; verify exit 0 when healthy and non-zero after `scripts/service.sh stop`
- [x] 3.2 Point `package.json` `start`/`stop`/`restart`/`status`/`logs` at `scripts/service.sh` and delete `scripts/start.sh`, `scripts/stop.sh` and stale `.gitignore` PID entries; verify `bun run start` and `bun run status` work and no `.*.pid` files are created
- [x] 3.3 Update README (Menjalankan Server, Mengganti Model restart commands, log locations) and CLAUDE.md Commands for the controller, foreground runner and auto-start; verify `grep -n "start.sh\|stop.sh\|--foreground" README.md CLAUDE.md` returns nothing

## 4. MCP server

- [x] 4.1 Create `bin/supermemory-mcp.ts`: stdio JSON-RPC loop (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`), stdout protocol-only; add `src/mcp-server.test.ts` covering initialize, tools/list (exactly `search`, `add`, `profile`) and an unknown method error; verify `bun test` passes
- [x] 4.2 Implement `project_path` validation (absolute, existing) → `resolveProject().containerTag`; verify a test with a relative path returns `isError` naming `project_path`
- [x] 4.3 Implement `search` (`toEnglish` + `/v4/search` hybrid, default limit 6, dated lines), `add` (`metadata.agent = "MCP"`, returns document ID) and `profile` (long-lived / recent groups), mapping API failures to `isError` results; verify by piping JSON-RPC to `bun --env-file=.env bin/supermemory-mcp.ts`: `add` then `search` on a scratch project returns the added text (scratch so no real project's memory gets test data), `search` on a real repo returns memories written by hooks, `profile` returns two groups
- [x] 4.4 Verify unavailability handling: with `scripts/service.sh stop`, a `search` call returns an error mentioning the memory server and the process keeps answering; after `start`, the same call succeeds
- [x] 4.5 Document the MCP server (tools, invocation line, `project_path` semantics) in README and CLAUDE.md; verify `bun run typecheck` passes. `bun run format:check` cannot run here (pre-existing: pnpm's `node_modules` hides `prettier-plugin-organize-imports`), so new files are checked with prettier using the same options minus that plugin

## 5. Integration

- [x] 5.1 Simulate a login: `scripts/service.sh stop`, then `launchctl bootstrap` the three plists only (as launchd does at login); verify `bun run status` exits 0 and a hook call (`echo '{"cwd":"…"}' | bun --env-file=.env bin/supermemory-hook.ts claude-code start`) prints memory context

## Workflow follow-up

- Register the MCP server in mcpm-gateway via the gateway-side change `add-supermemory-mcp`.
- Run `/opsx:verify`, then archive.
