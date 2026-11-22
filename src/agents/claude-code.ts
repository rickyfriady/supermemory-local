// Claude Code: hook payloads are { session_id, cwd, prompt, tool_name, tool_input, last_assistant_message, transcript_path }.
// Whatever the hook prints becomes model context, so render passes the context through as plain text.
import { lastTranscriptText, READONLY_CMD } from './shared.ts';
import type { AgentAdapter, HookEvent } from './types.ts';

/**
 * Claude Code's compaction summary without the "session is being continued" preamble and the
 * trailing "read the full transcript / resume directly" instructions meant for the model itself
 */
export function trimCompactSummary(text: string): string {
	// ponytail: matches Claude Code's current wrapper wording; if it changes, the full text is stored as-is
	return text
		.replace(/^This session is being continued[\s\S]*?\nSummary:\n/, '')
		.replace(/\n+If you need specific details from before compaction[\s\S]*$/, '')
		.trim();
}

function parseChange(raw: Record<string, any>): HookEvent['change'] {
	const tool = raw.tool_name || 'unknown_tool';
	const input = raw.tool_input || {};
	if (tool === 'Bash' && READONLY_CMD.test(input.command || '')) return undefined;
	const file = input.file_path || input.notebook_path;
	const detail = file
		? `File: ${file}`
		: input.command
			? `Command: ${String(input.command).slice(0, 300)}`
			: raw.raw || JSON.stringify(input).slice(0, 300);
	return { tool, detail, file };
}

export const claudeCode: AgentAdapter = {
	label: 'Claude Code',
	parse(raw, action) {
		const event: HookEvent = { cwd: raw.cwd || process.cwd(), sessionId: raw.session_id, prompt: raw.prompt };
		if (action === 'change') event.change = parseChange(raw);
		if (action === 'stop') {
			event.summary =
				raw.last_assistant_message ||
				(raw.transcript_path ? lastTranscriptText(raw.transcript_path, (e) => e.type === 'assistant') : '') ||
				raw.raw ||
				'';
		}
		if (action === 'compact' && raw.transcript_path) {
			event.summary = trimCompactSummary(lastTranscriptText(raw.transcript_path, (e) => e.isCompactSummary));
		}
		return event;
	},
	render: (context) => context || null,
};
