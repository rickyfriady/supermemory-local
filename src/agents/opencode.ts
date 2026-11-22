// OpenCode v2: the plugin (src/opencode-plugin.ts) runs this hook as a subprocess and sends
// { cwd, sessionID, prompt?, tool?, args?, summary? } on stdin, see fixtures in
// openspec/changes/agent-integration-v2/fixtures/opencode. What the hook prints is injected by the plugin.
import { READONLY_CMD } from './shared.ts';
import type { AgentAdapter, HookEvent } from './types.ts';

const READONLY_TOOLS = new Set([
	'read',
	'glob',
	'grep',
	'list',
	'webfetch',
	'websearch',
	'codesearch',
	'todoread',
	'todowrite',
	'skill',
]);
// The v2 shell tool is `shell` (v1 called it `bash`)
const SHELL_TOOLS = new Set(['shell', 'bash']);

function parseChange(raw: Record<string, any>): HookEvent['change'] {
	const tool: string = raw.tool || 'action';
	const args: Record<string, any> = raw.args || {};
	if (READONLY_TOOLS.has(tool)) return undefined;
	if (SHELL_TOOLS.has(tool)) {
		const command = String(args.command ?? '');
		return READONLY_CMD.test(command) ? undefined : { tool, detail: `Command: ${command.slice(0, 300)}` };
	}
	const file = args.filePath ?? args.file_path ?? args.path;
	return { tool, file: typeof file === 'string' ? file : undefined, detail: JSON.stringify(args).slice(0, 300) };
}

export const opencode: AgentAdapter = {
	label: 'OpenCode',
	parse(raw, action) {
		const event: HookEvent = { cwd: raw.cwd || process.cwd(), sessionId: raw.sessionID, prompt: raw.prompt };
		if (action === 'change') event.change = parseChange(raw);
		if (action === 'stop' || action === 'compact') event.summary = raw.summary;
		return event;
	},
	render: (context) => context || null,
};
