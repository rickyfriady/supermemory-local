// Antigravity (agy): payloads are camelCase protojson, see fixtures in openspec/changes/agent-integration-v2/fixtures/antigravity.
// Every event carries conversationId, cwd/workspacePaths, transcriptPath and lastUserInput. PreInvocation fires before EVERY model
// call and its invocationNum is 0 only on the first call of a user turn; Stop carries no reply text, so the reply is read from
// the transcript (transcript_full.jsonl, whose last PLANNER_RESPONSE line is already written when Stop runs).
// Output is always a JSON object. Hooks run synchronously and block the agent loop, so keep them cheap.
import { lastTranscriptText, READONLY_CMD } from './shared.ts';
import type { AgentAdapter, HookEvent } from './types.ts';

const SKIPPED_TOOLS = new Set(['search_web', 'schedule']);

function parseChange(raw: Record<string, any>): HookEvent['change'] {
	const tool: string = raw.toolCall?.name || 'unknown_tool';
	const args: Record<string, string | undefined> = raw.toolCall?.args || {};
	if (tool.startsWith('view_') || tool.startsWith('read_') || SKIPPED_TOOLS.has(tool)) return undefined;
	if (args.TargetFile) {
		return {
			tool,
			file: args.TargetFile,
			detail: `File: ${args.TargetFile}\nDescription: ${args.Description || args.Instruction || ''}`,
		};
	}
	if (args.CommandLine) {
		if (READONLY_CMD.test(args.CommandLine)) return undefined;
		return { tool, detail: `Command: ${args.CommandLine}` };
	}
	return { tool, detail: JSON.stringify(args).slice(0, 300) };
}

export const antigravity: AgentAdapter = {
	label: 'Antigravity',
	parse(raw, action) {
		// A model call that is not the first of its turn: the turn already got its memory
		if (raw.hookEventName === 'PreInvocation' && raw.invocationNum > 0) return null;
		const event: HookEvent = {
			cwd: raw.cwd || raw.workspacePaths?.[0] || process.cwd(),
			sessionId: raw.conversationId,
			prompt: raw.lastUserInput,
		};
		if (action === 'change') event.change = parseChange(raw);
		if (action === 'stop') {
			// Cancelled or failed turns have no reply worth keeping
			if (raw.terminationReason && raw.terminationReason !== 'NO_TOOL_CALL') return null;
			event.summary = raw.transcriptPath
				? lastTranscriptText(raw.transcriptPath, (e) => e.type === 'PLANNER_RESPONSE' && e.source === 'MODEL')
				: '';
		}
		return event;
	},
	// systemMessage persists in the conversation for later turns (ephemeralMessage is deprecated and re-sent per call)
	render: (context) => JSON.stringify(context ? { injectSteps: [{ systemMessage: { systemMessage: context } }] } : {}),
};
