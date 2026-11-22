import { antigravity } from './antigravity.ts';
import { claudeCode } from './claude-code.ts';
import { opencode } from './opencode.ts';
import type { Action, AgentAdapter } from './types.ts';

const ADAPTERS: Record<string, AgentAdapter> = { 'claude-code': claudeCode, antigravity, opencode };

/** Unknown agents get Claude Code's payload shape under their own name */
export function adapterFor(agent: string): AgentAdapter {
	return ADAPTERS[agent.toLowerCase()] ?? { ...claudeCode, label: agent || 'Unknown Agent' };
}

const ALIASES: Record<string, Action> = {
	start: 'start',
	check: 'start',
	context: 'start',
	sync: 'sync',
	prompt: 'sync',
	change: 'change',
	observation: 'change',
	stop: 'stop',
	'session-end': 'stop',
	summarize: 'stop',
	compact: 'compact',
	compacted: 'compact',
};

/** The action names agents' configs use, mapped to one of five; undefined for an unknown name */
export const normalizeAction = (action: string): Action | undefined => ALIASES[action];

export type { Action, AgentAdapter, HookEvent } from './types.ts';
