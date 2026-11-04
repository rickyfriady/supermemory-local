# Design

## Context

`scripts/start.sh` loads `.env`, derives the per-model store (`data/stores/<model>-<dims>d`, `data/current` symlink), then `nohup`s `bun src/llm-proxy.ts`, `bun src/zed-adapter.ts` and `~/.supermemory/bin/supermemory-server`, tracking PID files. It also starts 9router if absent. 9router already has its own LaunchAgent (`com.9router.autostart`, `RunAtLoad`, no `KeepAlive`).

The sibling project `mcpm-gateway` set the pattern this change follows: a LaunchAgent with `KeepAlive`, a controller (`gateway.sh start|stop|restart|status|logs`) with a single-runtime port guard, and a health script with an exit code. Its restart bug (new process starting before the old one freed the port) is the reason stop here waits for unload *and* free ports.

`/bin/bash` is 3.2 (no `wait -n`), the runtime has zero dependencies (Bun only), and `supermemory-server` 0.0.8 has no MCP endpoint (`/mcp` returns 404).

## Goals / Non-Goals

**Goals:**
- launchd supervises each process; no custom supervisor loop.
- Same `.env` handling and store selection as today, in one place.
- MCP server reuses the hooks' client, project resolver and translation code.

**Non-Goals:**
- PM2 / `ecosystem.config.js` dev mode (pm2 is not installed; foreground runner covers debugging).
- Managing or modifying 9router's LaunchAgent.
- Running Sessions UI under launchd (it needs a TTY for approvals).
- Log rotation (current logs are not rotated either).
- Registering the MCP server in the mcpm gateway (separate change in that project).

## Decisions

### 1. Three LaunchAgents, labels `com.supermemory-local.{server,llm-proxy,zed-adapter}`
Each has `RunAtLoad` + `KeepAlive`, so a crash restarts only that process. Logs go to the existing files in `data/` (`supermemory.log`, `llm-proxy.log`, `zed-adapter.log`), stdout and stderr together.

Alternative: one LaunchAgent running a supervisor script. Rejected: any child crash restarts all three, and bash 3.2 lacks `wait -n`, so it needs a polling loop.

The `-local` suffix keeps labels clear of any official supermemory app.

### 2. `scripts/run.sh <server|llm-proxy|zed-adapter>` — foreground, `exec`
Holds the env/store logic now in `start.sh`, then `exec`s the process so launchd tracks the real PID. LaunchAgents call it; humans call it for debugging. `bun run start`'s old `--foreground` flag is replaced by `scripts/run.sh server`.

### 3. `scripts/service.sh` controller, plists generated at install
`start` writes the three plists to `~/Library/LaunchAgents` from a heredoc using `$PROJECT_ROOT`, `$HOME` and `command -v bun`, then `launchctl bootstrap`s them. No plist templates in the repo, so no hardcoded `/Users/...`.
- `start`: single-runtime guard on the three ports (name the holder via `lsof`), 9router check (warn with `launchctl kickstart gui/$UID/com.9router.autostart` hint), bootstrap, wait for ports.
- `stop`: `bootout` each label, wait until unloaded and ports free.
- `restart`: `stop` then `start` (not `kickstart -k`, see Context).
- `status`: delegates to `scripts/status.sh`. `logs`: `tail -f` the three logs.

`package.json`: `start`/`stop`/`restart`/`status`/`logs` → `service.sh`. `start.sh` and `stop.sh` are deleted.

### 4. `status.sh` gains launchd state and an exit code
Adds a line per label (`launchctl print` loaded / PID) and exits 1 if the memory API or the LLM proxy is down. The PID-file branch goes away with the PID files.

### 5. MCP server: `bin/supermemory-mcp.ts`, hand-written stdio JSON-RPC
Newline-delimited JSON-RPC over stdin/stdout; handles `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. About a hundred lines, which keeps the zero-runtime-dependency rule; the MCP SDK would be the first runtime dependency.
- `project_path` → `resolveProject()` → `containerTag` (identical to hooks).
- `search` → `toEnglish(query)` then `/v4/search` hybrid; `add` → `addDocument` with `metadata.agent = "MCP"`, `type = "note"`; `profile` → `/v4/profile`.
- Errors: call `client.request` directly (the `search`/`profile` helpers swallow errors into empty results) and map failures to `isError: true` results.
- Invoked as `bun --env-file=<repo>/.env <repo>/bin/supermemory-mcp.ts`, like the hooks, so it never loads the target project's `.env`.
- Logging only to `~/.supermemory-hook.log` via the existing `log()`; stdout is protocol-only.

## Risks / Trade-offs

- [Legacy `nohup` processes still running when the LaunchAgents load → port clash, KeepAlive crash loop] → Start's port guard refuses; migration stops them first.
- [9router down at login → memory extraction fails until it is up] → Status/start warn; extraction is retried by the server on later documents only, so a long 9router outage loses extraction for documents stored meanwhile (same as today).
- [KeepAlive crash loop on bad config (e.g. missing `OPENAI_API_KEY`)] → launchd throttles restarts (10 s); `run.sh` exits with a clear message that lands in the component log.
- [Bun path differs on another machine] → plist uses `command -v bun` resolved at `start` time.
- [Hand-written MCP protocol drifts from spec] → Only the stable core methods are implemented; verified against the mcpm gateway client (FastMCP) in the gateway change.
- [`add` lets any gateway agent write memory for any path] → Same trust boundary as the hooks (local user, loopback gateway).

## Migration Plan

1. `bun run stop` with the old scripts (kills PID-file processes) before deleting them.
2. Land the new scripts; `bun run start` loads the LaunchAgents.
3. Rollback: `bun run stop` (boots out the LaunchAgents), restore `start.sh`/`stop.sh` from git, `bun run start`.
