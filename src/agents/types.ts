// What every agent adapter produces and consumes. The core handlers (src/hook-handler.ts) only ever see a HookEvent,
// so agent-specific payload shapes and output formats stay inside one file per agent.

export type Action = 'start' | 'sync' | 'change' | 'stop' | 'compact';

export interface HookEvent {
	/** Where the agent works: the project is resolved from here */
	cwd: string;
	/** The agent's own session id; items written by it are never injected back into it */
	sessionId?: string;
	/** The user's prompt (sync only) */
	prompt?: string;
	/** A state-changing tool run, already filtered for read-only noise */
	change?: { tool: string; detail: string; /** file the tool touched, when it names one */ file?: string };
	/** Final reply (stop) or compaction summary (compact), unfiltered: the core strips injected context and translates */
	summary?: string;
}

export interface AgentAdapter {
	/** Name stored with every memory, e.g. "Antigravity" */
	label: string;
	/** Raw stdin payload → event; null when the payload needs no work (e.g. an agy model call that is not the first of its turn) */
	parse(raw: Record<string, any>, action: Action): HookEvent | null;
	/** Text for stdout given the injected context ('' = none); null prints nothing */
	render(context: string): string | null;
}
