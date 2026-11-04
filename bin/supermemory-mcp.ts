#!/usr/bin/env bun
// MCP entrypoint for any MCP client: bun --env-file=<repo>/.env bin/supermemory-mcp.ts
// (--env-file stops Bun from auto-loading the .env of whatever directory the client started it in)
// stdout carries protocol messages only; diagnostics go to ~/.supermemory-hook.log
import { handleLine } from '../src/mcp-server.ts';

for await (const line of console) {
	if (!line.trim()) continue;
	// Not awaited: a slow call must not hold up ping or other requests
	handleLine(line).then((reply) => {
		if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
	});
}
