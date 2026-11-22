// supermemory-local: per-project persistent memory for OpenCode v2.
// A thin bridge to bin/supermemory-hook.ts: every memory decision runs in that subprocess, so config (--env-file), failure
// isolation and the never-block rule are the same as for the other agents. Template: installer.ts rewrites HOOK_CMD and copies
// this into ~/.config/opencode/plugins/supermemory-local.ts. Payload shapes: openspec/changes/agent-integration-v2/fixtures/opencode.
// No package import on purpose: a v2 plugin is just a default-exported { id, setup(ctx) } object.

const HOOK_CMD = ['bun', 'bin/supermemory-hook.ts'];
const HOOK_TIMEOUT_MS = 15_000;
// ponytail: only the newest MAX_DELTAS deltas are kept after the start block, so the system prompt stays bounded
const MAX_DELTAS = 5;

type Json = Record<string, any>;
interface SessionState {
	started: boolean;
	blocks: string[];
}

/** Runs one hook action with the payload on stdin; any failure or timeout yields '' (memory must never break OpenCode) */
async function run(action: string, payload: Json): Promise<string> {
	try {
		const proc = Bun.spawn([...HOOK_CMD, 'opencode', action], {
			stdin: new Response(JSON.stringify(payload)),
			stdout: 'pipe',
			stderr: 'ignore',
			timeout: HOOK_TIMEOUT_MS,
			killSignal: 'SIGKILL',
		});
		return (await new Response(proc.stdout).text()).trim();
	} catch {
		return '';
	}
}

const textOf = (content: unknown): string =>
	Array.isArray(content)
		? content
				.filter((p: Json) => p?.type === 'text' && p.text)
				.map((p: Json) => p.text)
				.join('\n')
		: '';

export default {
	id: 'supermemory-local',
	async setup(ctx: Json) {
		const sessions = new Map<string, SessionState>();
		const cwds = new Map<string, string>();
		const stateOf = (id: string) => sessions.get(id) ?? sessions.set(id, { started: false, blocks: [] }).get(id)!;

		// ctx.location is where the plugin loaded, not where a session works: the v2 service is shared by every project
		const cwdOf = async (sessionID: string): Promise<string> => {
			let dir = cwds.get(sessionID);
			if (!dir) {
				try {
					dir = (await ctx.session.get({ sessionID })).location?.directory;
				} catch {}
				dir ||= ctx.location.directory as string;
				cwds.set(sessionID, dir);
			}
			return dir;
		};

		// Full recall on the session's first prompt, then each prompt appends what others stored since + prompt-relevant hits
		await ctx.session.hook('prompt', async (e: Json) => {
			const state = stateOf(e.sessionID);
			const block = await run(state.started ? 'sync' : 'start', {
				cwd: await cwdOf(e.sessionID),
				sessionID: e.sessionID,
				prompt: e.prompt?.text,
			});
			state.started = true;
			if (block) state.blocks.push(block);
			if (state.blocks.length > MAX_DELTAS + 1) state.blocks.splice(1, 1);
		});

		// Runs once per model request: only hands over what the prompt hook already fetched
		await ctx.session.hook('context', (e: Json) => {
			const blocks = sessions.get(e.sessionID)?.blocks;
			if (blocks?.length) e.system.push({ type: 'text', text: blocks.join('\n\n') });
		});

		await ctx.tool.hook('execute.after', async (e: Json) => {
			if (e.status !== 'completed') return;
			// Not awaited: recording a change must not slow the agent down
			void run('change', { cwd: await cwdOf(e.sessionID), sessionID: e.sessionID, tool: e.tool, args: e.input });
		});

		const lastReply = async (sessionID: string) => {
			const messages: Json[] = await ctx.session.context({ sessionID });
			return messages.findLast((m) => m.type === 'assistant');
		};

		const controller = new AbortController();
		void (async () => {
			for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
				const sessionID = ev.data?.sessionID;
				if (!sessionID) continue;
				try {
					if (ev.type === 'session.execution.succeeded') {
						const summary = textOf((await lastReply(sessionID))?.content);
						if (summary) void run('stop', { cwd: await cwdOf(sessionID), sessionID, summary });
					} else if (ev.type === 'session.compaction.ended') {
						// The summary is the `summary` string of the newest `compaction` item (fixtures/opencode/08-compaction.json)
						const messages: Json[] = await ctx.session.context({ sessionID });
						const m = messages.findLast((x) => x.type === 'compaction');
						const summary = typeof m?.summary === 'string' ? m.summary : '';
						if (summary) void run('compact', { cwd: await cwdOf(sessionID), sessionID, summary });
					}
				} catch {}
			}
		})().catch(() => {});

		return () => controller.abort();
	},
};
