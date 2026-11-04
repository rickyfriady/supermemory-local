# Proposal

## Why

`bun run start` launches supermemory-server, llm-proxy and zed-adapter as `nohup` daemons that nothing supervises: after a reboot or crash they stay down and every agent hook silently stops storing memory (this happened from 2026-10-29 until a manual restart on 2026-10-31). Memory is also reachable only through per-agent hooks, so agents behind the mcpm gateway cannot search or add memories on demand.

## What Changes

- Run the three long-lived processes as macOS LaunchAgents with restart-on-exit, started at login.
- One controller command (`start | stop | restart | status | logs`) manages all three, generating the LaunchAgent definitions from the repo location and the user's home instead of hardcoded paths.
- Foreground entry point per process, used by launchd and for manual debugging.
- `bun run start` / `stop` / `status` route through the controller. **BREAKING**: the `nohup` daemon mode and its PID files (`.supermemory.pid`, `.llm-proxy.pid`, `.zed-adapter.pid`) are removed; `start` no longer launches 9router (9router keeps its own LaunchAgent, start only checks it).
- Status exits non-zero when a required component is down, so it can serve as a health check.
- New stdio MCP server exposing project memory search, memory add and project profile, using the same per-project container tags as the hooks. Registration in the mcpm gateway is a separate change in the gateway project.

## Capabilities

### New Capabilities

- `service-lifecycle`: how the local supermemory processes are started, supervised across crashes and logins, stopped, and health-checked.
- `memory-mcp-server`: an MCP server that lets any MCP client search, add and summarise a project's shared memory.

### Modified Capabilities

_None._

## Impact

- New: controller script, per-process foreground runner, MCP server entry point; removed: `scripts/start.sh`, `scripts/stop.sh`.
- Changed: `scripts/status.sh` (exit code, launchd state), `package.json` scripts, README and CLAUDE.md run instructions.
- Writes three plists to `~/Library/LaunchAgents` (labels `com.supermemory-local.*`).
- Sessions UI unchanged (needs a TTY, stays manual). 9router's own LaunchAgent unchanged.
- Runtime stays dependency-free: the MCP server speaks the stdio protocol directly, no SDK.
