#!/usr/bin/env bun
// Stack controller entry: bun --env-file=.env bin/stack.ts <start|stop|restart|status|logs> [--memory] [--gateway] [--9router] [--all]
// Dispatch only; the logic lives in src/stack.ts. Exit code: 0 ok, 1 a selected step failed, 2 usage error.
import { loadConfig, parseCommand, PROJECT_ROOT, run, USAGE } from '../src/stack.ts';

const parsed = parseCommand(Bun.argv.slice(2));
if (!parsed.ok) {
	console.error(`❌ ${parsed.error}`);
	console.error(USAGE);
	process.exit(2);
}
process.exitCode = await run(parsed.command, loadConfig(process.env, PROJECT_ROOT));
