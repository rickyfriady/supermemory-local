#!/usr/bin/env bun
// Hook entrypoint for all agents: bun --env-file=<repo>/.env bin/supermemory-hook.ts <agent> <action>
// (--env-file stops Bun from auto-loading the .env of whatever project the agent is working in)
import { emptyOutput, log, runHook } from '../src/hook-handler.ts';

const agent = process.argv[2] || 'generic'; // 'claude-code' | 'antigravity' | 'opencode'
const action = process.argv[3] || 'check'; // 'start' | 'sync' | 'change' | 'stop' | 'compact' (+ aliases)

try {
	await runHook(agent, action);
} catch (err) {
	// Always fail safe: never block the agent CLI
	log(`Hook error (${agent} ${action}): ${(err as Error).stack || err}`);
	const out = emptyOutput(agent);
	if (out !== null) console.log(out);
}
process.exit(0);
