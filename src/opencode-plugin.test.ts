// Runs the real plugin against a fake v2 `ctx` shaped like the captured fixtures, with a stub script in place of the hook.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginSource } from './installer.ts';

const FIX = path.join(import.meta.dir, 'agents', 'fixtures', 'opencode');
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf-8'));

let dir: string;
let calls: { action: string; payload: any }[] = [];
const readCalls = () =>
	fs.existsSync(path.join(dir, 'calls.jsonl'))
		? fs
				.readFileSync(path.join(dir, 'calls.jsonl'), 'utf-8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
const waitForCalls = async (n: number) => {
	for (let i = 0; i < 100 && (calls = readCalls()).length < n; i++) await Bun.sleep(50);
	return calls;
};

let plugin: { setup(ctx: any): Promise<() => void> };

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-plugin-'));
	// Stand-in for bin/supermemory-hook.ts: logs "<action> <stdin>" and answers start/sync with a block
	const stub = path.join(dir, 'stub.ts');
	fs.writeFileSync(
		stub,
		`import fs from 'node:fs';
const [, , , action] = process.argv;
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({ action, payload: JSON.parse(await Bun.stdin.text()) }) + '\\n');
if (action === 'start' || action === 'sync') console.log('BLOCK-' + action);`,
	);
	const file = path.join(dir, 'plugin.ts');
	fs.writeFileSync(
		file,
		pluginSource(fs.readFileSync(path.join(import.meta.dir, 'opencode-plugin.ts'), 'utf-8'), [Bun.which('bun')!, stub]),
	);
	plugin = (await import(file)).default;
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function fakeCtx(contextItems: any[]) {
	const hooks: Record<string, (e: any) => any> = {};
	const events: any[] = [];
	let wake: (() => void) | undefined;
	const ctx = {
		location: { directory: '/plugin/instance/dir' },
		session: {
			hook: async (name: string, cb: (e: any) => any) => void (hooks['session.' + name] = cb),
			get: async () => fixture('04-session.get.json'),
			context: async () => contextItems,
		},
		tool: { hook: async (name: string, cb: (e: any) => any) => void (hooks['tool.' + name] = cb) },
		event: {
			async *subscribe({ signal }: { signal: AbortSignal }) {
				while (!signal.aborted) {
					while (events.length) yield events.shift();
					await new Promise<void>((r) => ((wake = r), signal.addEventListener('abort', () => r())));
				}
			},
		},
	};
	return { ctx, hooks, emit: (ev: any) => (events.push(ev), wake?.()) };
}

test('prompt → start then sync, context hook hands the blocks to the system prompt', async () => {
	const { ctx, hooks } = fakeCtx([]);
	const cleanup = await plugin.setup(ctx);
	const prompt = fixture('01-prompt.json').e;

	await hooks['session.prompt']!(prompt);
	await hooks['session.prompt']!({ ...prompt, prompt: { text: 'second prompt here' } });
	calls = readCalls().slice(-2);
	expect(calls.map((c) => c.action)).toEqual(['start', 'sync']);
	// the session's own directory, not the plugin instance's
	expect(calls[0]!.payload).toMatchObject({ cwd: '/work/project', sessionID: prompt.sessionID, prompt: prompt.prompt.text });
	expect(calls[1]!.payload.prompt).toBe('second prompt here');

	const request = { sessionID: prompt.sessionID, system: [{ type: 'text', text: 'base' }] };
	hooks['session.context']!(request);
	expect(request.system).toHaveLength(2);
	expect(request.system[1]!.text).toBe('BLOCK-start\n\nBLOCK-sync');

	const other = { sessionID: 'ses_other', system: [] as any[] };
	hooks['session.context']!(other);
	expect(other.system).toEqual([]);
	cleanup();
});

test('execute.after records completed tool runs with the shell tool name and args', async () => {
	const before = readCalls().length;
	const { ctx, hooks } = fakeCtx([]);
	const cleanup = await plugin.setup(ctx);
	const after = fixture('03-execute.after.json');
	await hooks['tool.execute.after']!({ ...after, status: 'error' });
	await hooks['tool.execute.after']!(after);
	const got = (await waitForCalls(before + 1)).slice(before);
	expect(got).toHaveLength(1);
	expect(got[0]).toMatchObject({
		action: 'change',
		payload: { tool: 'shell', args: { command: 'echo spike' }, cwd: '/work/project' },
	});
	cleanup();
});

test('turn end stores the last assistant reply; a compaction stores its summary', async () => {
	const before = readCalls().length;
	const { items } = fixture('07-session.context.json');
	const { ctx, emit } = fakeCtx(items);
	const cleanup = await plugin.setup(ctx);
	emit(fixture('06-execution.succeeded.json'));
	const got = (await waitForCalls(before + 1)).slice(before);
	expect(got[0]).toMatchObject({ action: 'stop', payload: { summary: 'OK', cwd: '/work/project' } });

	// the real item from POST /api/session/{id}/compact: a `compaction` entry carrying its summary as a string
	const compaction = fixture('08-compaction.json').item;
	const compacted = fakeCtx([{ type: 'assistant', content: [{ type: 'text', text: 'earlier reply' }] }, compaction]);
	const cleanup2 = await plugin.setup(compacted.ctx);
	compacted.emit({ type: 'session.compaction.ended', data: { sessionID: 'ses_x' } });
	const more = (await waitForCalls(before + 2)).slice(before + 1);
	expect(more[0]).toMatchObject({ action: 'compact', payload: { summary: compaction.summary } });
	expect(compaction.summary.length).toBeGreaterThan(100);
	cleanup();
	cleanup2();
});

test('a compaction item is never stored as a reply, and a turn with no assistant text stores nothing', async () => {
	const before = readCalls().length;
	const compaction = fixture('08-compaction.json').item;
	const { ctx, emit } = fakeCtx([compaction, { type: 'idle', outcome: 'succeeded' }]);
	const cleanup = await plugin.setup(ctx);
	emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_y' } });
	await Bun.sleep(400);
	expect(readCalls().length).toBe(before);
	cleanup();
});
