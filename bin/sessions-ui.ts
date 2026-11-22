#!/usr/bin/env bun
// Local page listing Claude Code, OpenCode and Antigravity sessions (rename/tags for all, delete for Claude Code and OpenCode): bun --env-file=<repo>/.env bin/sessions-ui.ts (bun run sessions)
// Runs in the foreground: every change requested in the browser is approved with y/N in this terminal.
import { currentConfig } from '../src/config.ts';
import { terminalPrompt } from '../src/sessions-actions.ts';
import { claudeRoots } from '../src/sessions-scan.ts';
import { startServer } from '../src/sessions-server.ts';
import { SupermemoryClient } from '../src/supermemory-client.ts';

if (!process.stdin.isTTY) {
	console.error(
		'sessions-ui needs an interactive terminal: changes are approved with y/N here. Run `bun run sessions` in a terminal.',
	);
	process.exit(1);
}

const config = currentConfig();
const port = config.sessionsUiPort;
try {
	startServer({
		port,
		roots: claudeRoots(),
		dataDir: config.dataDir,
		prompt: terminalPrompt(),
		client: new SupermemoryClient(),
	});
} catch (err) {
	if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
		console.error(`Port ${port} is already in use. Stop the other process or set SESSIONS_UI_PORT in .env.`);
	} else {
		console.error(`Could not start: ${(err as Error).message}`);
	}
	process.exit(1);
}

console.log(`Sessions UI: http://127.0.0.1:${port}`);
console.log('Changes asked for in the browser show up here and wait for your y/N. Ctrl-C to stop.');
