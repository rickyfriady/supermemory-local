// Contract tests: payloads captured from the real agents (fixtures/) must parse into the events the core expects.
// When an agent changes its payload, refresh the fixture first; a failing test here is the early warning.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { adapterFor, normalizeAction } from './index.ts';

const FIX = path.join(import.meta.dir, 'fixtures');
const fixture = (agent: string, name: string) => JSON.parse(fs.readFileSync(path.join(FIX, agent, name), 'utf-8'));
const agy = adapterFor('antigravity');
const oc = adapterFor('opencode');
const claude = adapterFor('claude-code');

test('action aliases map to the five actions', () => {
	expect(
		['start', 'check', 'prompt', 'sync', 'observation', 'summarize', 'session-end', 'compacted', 'nope'].map(normalizeAction),
	).toEqual(['start', 'start', 'sync', 'sync', 'change', 'stop', 'stop', 'compact', undefined]);
});

test('unknown agents use the Claude Code payload shape under their own name', () => {
	expect(adapterFor('zed').label).toBe('zed');
	expect(adapterFor('zed').parse({ cwd: '/p', session_id: 's' }, 'start')).toMatchObject({ cwd: '/p', sessionId: 's' });
});

// ---- Claude Code
test('claude: file edit becomes a change note with its file, read-only Bash is dropped', () => {
	const edit = claude.parse({ cwd: '/p', tool_name: 'Edit', tool_input: { file_path: 'x.ts' } }, 'change');
	expect(edit?.change).toEqual({ tool: 'Edit', file: 'x.ts', detail: 'File: x.ts' });
	expect(claude.parse({ cwd: '/p', tool_name: 'Bash', tool_input: { command: 'git status' } }, 'change')?.change).toBeUndefined();
	expect(claude.parse({ cwd: '/p', tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }, 'change')?.change?.detail).toBe(
		'Command: rm -rf x',
	);
});

test('claude: stop uses last_assistant_message, prompt and session pass through, render prints context only when there is some', () => {
	const e = claude.parse(
		{ cwd: '/p', session_id: 's1', prompt: 'hello there friend', last_assistant_message: 'done it' },
		'stop',
	);
	expect(e).toMatchObject({ sessionId: 's1', prompt: 'hello there friend', summary: 'done it' });
	expect(claude.render('ctx')).toBe('ctx');
	expect(claude.render('')).toBeNull();
});

// ---- Antigravity (real payloads)
test('agy: SessionStart gives session id and cwd from the real payload', () => {
	const e = agy.parse(fixture('antigravity', '01-SessionStart.json'), 'start');
	expect(e?.sessionId).toBe('a6592955-aac1-4f36-97e9-0dd6c5cd7cde');
	expect(e?.cwd).toBe('/work/project');
	expect(e?.prompt).toBe('Reply with exactly: FIRST');
});

test('agy: only the first PreInvocation of a turn does work', () => {
	const first = fixture('antigravity', '02-PreInvocation.json');
	expect(first.invocationNum).toBe(0);
	expect(agy.parse(first, 'sync')?.prompt).toBe('Reply with exactly: FIRST');
	expect(agy.parse({ ...first, invocationNum: 1 }, 'sync')).toBeNull();
	// An older install that still runs `start` on PreInvocation gets the same once-per-turn rule
	expect(agy.parse({ ...first, invocationNum: 3 }, 'start')).toBeNull();
});

test('agy: Stop stores the last model reply from the transcript, only for a normal turn end', () => {
	const stop = fixture('antigravity', '04-Stop.json');
	expect(stop.terminationReason).toBe('NO_TOOL_CALL');
	const transcriptPath = path.join(FIX, 'antigravity', 'transcript_full.tail.jsonl');
	expect(agy.parse({ ...stop, transcriptPath }, 'stop')?.summary).toBe('PELICAN-42');
	expect(agy.parse({ ...stop, transcriptPath, terminationReason: 'USER_CANCELED' }, 'stop')).toBeNull();
	expect(agy.parse({ ...stop, transcriptPath: '/nonexistent' }, 'stop')?.summary).toBe('');
});

test('agy: tool calls become change notes with the target file; reads and read-only commands are dropped', () => {
	const call = (name: string, args: object) => agy.parse({ cwd: '/p', toolCall: { name, args } }, 'change')?.change;
	expect(call('write_to_file', { TargetFile: '/p/a.ts', Description: 'add' })).toMatchObject({ file: '/p/a.ts' });
	expect(call('run_command', { CommandLine: 'npm test' })?.detail).toBe('Command: npm test');
	expect(call('run_command', { CommandLine: 'ls -la' })).toBeUndefined();
	expect(call('view_file', { AbsolutePath: '/p/a.ts' })).toBeUndefined();
});

test('agy: output is always a JSON object, a persistent systemMessage when there is context', () => {
	expect(agy.render('')).toBe('{}');
	expect(JSON.parse(agy.render('ctx')!)).toEqual({ injectSteps: [{ systemMessage: { systemMessage: 'ctx' } }] });
});

// ---- OpenCode v2 (real payloads)
test('opencode: the v2 shell tool from the real execute.after payload', () => {
	const after = fixture('opencode', '03-execute.after.json');
	expect(after.tool).toBe('shell');
	const raw = { cwd: '/p', sessionID: after.sessionID, tool: after.tool, args: after.input };
	// `echo spike` is read-only noise
	expect(oc.parse(raw, 'change')?.change).toBeUndefined();
	expect(oc.parse({ ...raw, args: { command: 'bun install' } }, 'change')?.change).toEqual({
		tool: 'shell',
		detail: 'Command: bun install',
	});
});

test('opencode: read tools are dropped, edits keep their file, prompt and summary pass through', () => {
	expect(oc.parse({ cwd: '/p', tool: 'read', args: { filePath: '/p/a' } }, 'change')?.change).toBeUndefined();
	expect(oc.parse({ cwd: '/p', tool: 'edit', args: { filePath: '/p/a.ts' } }, 'change')?.change?.file).toBe('/p/a.ts');
	expect(oc.parse({ cwd: '/p', sessionID: 'ses_1', prompt: 'do the thing please' }, 'sync')).toMatchObject({
		sessionId: 'ses_1',
		prompt: 'do the thing please',
	});
	expect(oc.parse({ cwd: '/p', summary: 'all done' }, 'stop')?.summary).toBe('all done');
	expect(oc.render('')).toBeNull();
});

test('opencode: the last assistant reply in the real session.context fixture is where the plugin reads the summary', () => {
	const { items } = fixture('opencode', '07-session.context.json');
	const reply = [...items].reverse().find((m: any) => m.type === 'assistant');
	expect(reply.content.find((c: any) => c.type === 'text').text).toBe('OK');
	expect(items.at(-1)).toMatchObject({ type: 'idle', outcome: 'succeeded' });
});
