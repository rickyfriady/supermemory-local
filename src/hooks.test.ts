// Unit checks for the transforms that guard memory quality and sync: bun test
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEnglish, lastTranscriptText, newSince, pickHits, stripContext, trimCompactSummary } from './hook-handler.ts';
import { fixEmbeddingResponse, rewriteBody } from './llm-proxy.ts';
import { cleanText } from './zed-adapter.ts';

const block = (inner: string) => `<supermemory-context>\n# Shared Project Memory: p (/x)\n${inner}\n</supermemory-context>`;

test('stripContext removes nested, single and unclosed injected blocks', () => {
	expect(stripContext(`before ${block(`a ${block('b')}`)} after`)).toBe('before  after');
	expect(stripContext(`keep ${block('cut')}`)).toBe('keep');
	expect(stripContext('head\n<supermemory-context>\n# Shared Project Memory: p\ntruncated')).toBe('head');
});

test('stripContext keeps plain mentions of the tag in prose', () => {
	const prose = 'prose `<supermemory-context>` mention stays';
	expect(stripContext(prose)).toBe(prose);
});

test('rewriteBody sets stream:false on chat and dimensions on embeddings, only when unset', () => {
	expect(JSON.parse(rewriteBody('{"model":"m"}', '/chat/completions')).stream).toBe(false);
	expect(JSON.parse(rewriteBody('{"stream":true}', '/chat/completions')).stream).toBe(true);
	expect(rewriteBody('not json', '/chat/completions')).toBe('not json');
	expect(rewriteBody('', '/chat/completions')).toBe('');
	expect(JSON.parse(rewriteBody('{"input":"x"}', '/embeddings', 1024))).toEqual({ input: 'x', dimensions: 1024 });
	expect(JSON.parse(rewriteBody('{"input":"x","dimensions":768}', '/embeddings', 1024)).dimensions).toBe(768);
});

test('fixEmbeddingResponse adds usage.prompt_tokens when a provider only sends total_tokens', () => {
	expect(JSON.parse(fixEmbeddingResponse('{"data":[],"usage":{"total_tokens":6}}')).usage).toEqual({
		total_tokens: 6,
		prompt_tokens: 6,
	});
	expect(JSON.parse(fixEmbeddingResponse('{"usage":{"prompt_tokens":2,"total_tokens":6}}')).usage.prompt_tokens).toBe(2);
	expect(fixEmbeddingResponse('{"data":[]}')).toBe('{"data":[]}');
	expect(fixEmbeddingResponse('not json')).toBe('not json');
});

test('newSince keeps only newer docs from other sessions', () => {
	const doc = (id: string, createdAt: string, session?: string) => ({ id, createdAt, metadata: { session } });
	const recent = [
		doc('a', '2026-01-03T00:00:00Z', 'other'),
		doc('b', '2026-01-02T00:00:00Z', 'me'),
		doc('c', '2026-01-01T00:00:00Z'),
	];
	expect(newSince(recent, '2026-01-01T00:00:00Z', 'me').map((d) => d.id)).toEqual(['a']);
	expect(newSince(recent, '', 'me').map((d) => d.id)).toEqual(['a', 'c']);
});

test('compaction summary is read from the transcript and unwrapped', () => {
	const summary =
		'This session is being continued from a previous conversation.\n\nSummary:\n1. Intent: X\n2. Pending: Y\n\nIf you need specific details from before compaction, read the full transcript at: /t.jsonl\nContinue the conversation.';
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-')), 't.jsonl');
	const lines = [
		{ type: 'user', isCompactSummary: true, message: { content: 'old summary' } },
		{ type: 'user', isCompactSummary: true, message: { content: summary } },
		{ type: 'assistant', message: { content: [{ type: 'text', text: 'reply after' }] } },
	];
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
	expect(trimCompactSummary(lastTranscriptText(file, (e) => e.isCompactSummary))).toBe('1. Intent: X\n2. Pending: Y');
	expect(lastTranscriptText(file, (e) => e.type === 'assistant')).toBe('reply after');
});

test('zed-adapter cleanText unwraps fences, applies stop and restores zeta markers', () => {
	const [s, e] = ['<|editable_region_start|>', '<|editable_region_end|>'];
	expect(cleanText('```python\nfoo()\n```')).toBe('foo()');
	expect(cleanText('abc<|endoftext|>junk', ['<|endoftext|>'])).toBe('abc');
	expect(cleanText(undefined)).toBe('');
	expect(cleanText('x = 1', [], `a ${s} b`)).toBe(`${s}\nx = 1\n${e}`);
	expect(cleanText(`${s}\nx\n${e}`, [], s)).toBe(`${s}\nx\n${e}`);
});

test('pickHits drops own-session and already-seen hits and keeps one chunk per document, two at most', () => {
	const mem = (id: string, session = 'other') => ({ id, memory: id, similarity: 0.8, metadata: { session } });
	const chunk = (id: string, doc: string) => ({ id, chunk: id, similarity: 0.7, metadata: {}, documents: [{ id: doc }] });
	const hits = [
		mem('m1'),
		mem('m2', 'me'),
		mem('m3'),
		chunk('c1', 'd1'),
		chunk('c2', 'd1'),
		chunk('c3', 'd2'),
		chunk('c4', 'd3'),
	];
	expect(pickHits(hits, 'me', new Set(['m3'])).map((h) => h.id)).toEqual(['m1', 'c1', 'c3']);
});

test('isEnglish tells English prose from other languages', () => {
	expect(isEnglish('I fixed the login bug: the refresh token expired after 5 minutes because of the TTL unit.')).toBe(true);
	expect(isEnglish('Saya sudah memperbaiki bug login: token refresh kedaluwarsa setelah 5 menit karena satuan TTL.')).toBe(false);
	expect(isEnglish('kenapa token refresh cepat kedaluwarsa?')).toBe(false);
	expect(isEnglish('为什么刷新令牌很快过期')).toBe(false);
	expect(isEnglish('fix login bug')).toBe(true);
});

// ---- hooks where the agent's folder has no project (real entrypoint as a subprocess, unreachable memory server, temp HOME)
function hook(agent: string, action: string, payload: object, env: Record<string, string> = {}) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-home-'));
	const r = Bun.spawnSync(['bun', path.join(import.meta.dir, '..', 'bin', 'supermemory-hook.ts'), agent, action], {
		stdin: new Blob([JSON.stringify(payload)]),
		env: {
			...process.env,
			HOME: home,
			SUPERMEMORY_DATA_DIR: path.join(home, 'data'),
			SUPERMEMORY_API_URL: 'http://127.0.0.1:1',
			...env,
		},
	});
	const logFile = path.join(home, '.supermemory-hook.log');
	const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '';
	fs.rmSync(home, { recursive: true, force: true });
	return { exit: r.exitCode, out: r.stdout.toString().trim(), log };
}

function workspace() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-ws-')));
	for (const name of ['alpha', 'beta']) {
		fs.mkdirSync(path.join(root, name));
		Bun.spawnSync(['git', 'init', '-q'], { cwd: path.join(root, name) });
	}
	return root;
}

test('start in a folder of repositories injects only a hint saying memory is per repository', () => {
	const root = workspace();
	const claude = hook('claude-code', 'start', { cwd: root });
	expect(claude.exit).toBe(0);
	expect(claude.out).toContain('# Shared Project Memory: (no project)');
	expect(claude.out).toContain('alpha, beta');
	// agy always gets a JSON object, here carrying the hint as a persistent system message
	const agy = JSON.parse(hook('antigravity', 'start', { cwd: root }).out);
	expect(agy.injectSteps[0].systemMessage.systemMessage).toContain('(no project)');
	fs.rmSync(root, { recursive: true, force: true });
});

test('hooks in an ignored folder print nothing (agy: {})', () => {
	const root = workspace();
	const env = { SUPERMEMORY_IGNORE: 'hook-ws-' };
	expect(hook('claude-code', 'start', { cwd: root }, env).out).toBe('');
	expect(hook('antigravity', 'start', { cwd: root }, env).out).toBe('{}');
	fs.rmSync(root, { recursive: true, force: true });
});

test('a change made from a folder of repositories goes to the repository that owns the file, or is dropped', () => {
	const root = workspace();
	const edit = (file: string) => ({ cwd: root, tool_name: 'Edit', tool_input: { file_path: file } });
	const owned = hook('claude-code', 'change', edit(path.join(root, 'alpha', 'src', 'new-file.ts')));
	expect(owned.log).toContain(`Project: alpha (${path.join(root, 'alpha')})`);
	const stray = hook('claude-code', 'change', edit(path.join(root, 'notes.md')));
	expect(stray.log).toContain('No project for');
	expect(stray.log).not.toContain('Saving');
	// summaries have no file to route by: nothing is stored
	expect(hook('claude-code', 'stop', { cwd: root, last_assistant_message: 'a long enough reply to be stored' }).log).toContain(
		'No project for',
	);
	fs.rmSync(root, { recursive: true, force: true });
});
