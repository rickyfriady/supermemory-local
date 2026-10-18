// Unit checks for the sessions UI (scanner, memory links): bun test
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	buildCatalog,
	filterCatalog,
	linkMemories,
	liveSessionIds,
	memoryExcerpts,
	parseSession,
	type Cache,
	type ProjectGroup,
	type Roots,
} from './sessions-scan.ts';
import { resolveProject } from './project-resolver.ts';
import { SupermemoryClient } from './supermemory-client.ts';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

const tmpDirs: string[] = [];
const tmp = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-test-'));
	tmpDirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const lines = (...entries: unknown[]) => entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
const user = (text: string, extra: object = {}) => ({
	type: 'user',
	cwd: '/work/app',
	gitBranch: 'feat/x',
	version: '2.1.0',
	timestamp: '2026-10-01T10:00:00.000Z',
	message: { role: 'user', content: text },
	...extra,
});
const tool = (name: string, input: object) => ({
	type: 'assistant',
	timestamp: '2026-10-01T10:05:00.000Z',
	message: {
		content: [
			{ type: 'text', text: 'ok' },
			{ type: 'tool_use', name, input },
		],
	},
});

/** Temp ~/.claude with the given transcripts: { [slug]: { [sessionId]: jsonl } } */
function fakeClaude(projects: Record<string, Record<string, string>>): Roots {
	const home = tmp();
	const roots: Roots = {
		projectsDir: path.join(home, 'projects'),
		sessionsDir: path.join(home, 'sessions'),
		fileHistoryDir: path.join(home, 'file-history'),
	};
	fs.mkdirSync(roots.sessionsDir, { recursive: true });
	for (const [slug, sessions] of Object.entries(projects)) {
		fs.mkdirSync(path.join(roots.projectsDir, slug), { recursive: true });
		for (const [id, text] of Object.entries(sessions)) fs.writeFileSync(path.join(roots.projectsDir, slug, `${id}.jsonl`), text);
	}
	return roots;
}

test('parseSession reads title, branch, prompts, PR, cost and written files; skips noise and bad lines', () => {
	const p = parseSession(
		lines(
			{ type: 'ai-title', aiTitle: 'Old title' },
			user('<local-command-caveat>x</local-command-caveat>'),
			user('meta noise', { isMeta: true }),
			user('first real prompt'),
			'{ not json',
			tool('Edit', { file_path: '/work/app/a.ts' }),
			tool('Write', { file_path: '/work/app/b.ts' }),
			tool('Edit', { file_path: '/work/app/a.ts' }),
			tool('Read', { file_path: '/work/app/never.ts' }),
			{ type: 'user', timestamp: '2026-10-01T11:00:00.000Z', message: { content: [{ type: 'tool_result' }] } },
			user('second prompt', { timestamp: '2026-10-01T12:00:00.000Z' }),
			{ type: 'ai-title', aiTitle: 'New title' },
			{ type: 'pr-link', prNumber: 7, prUrl: 'https://x/pr/7' },
			{ type: 'cost-state', totalCostUSD: 1.5 },
		),
		ID_A,
	);
	expect(p).toMatchObject({
		id: ID_A,
		project: '/work/app',
		branch: 'feat/x',
		version: '2.1.0',
		title: 'New title',
		firstPrompt: 'first real prompt',
		lastPrompt: 'second prompt',
		prUrl: 'https://x/pr/7',
		prNumber: 7,
		costUSD: 1.5,
		startedAt: '2026-10-01T10:00:00.000Z',
		lastAt: '2026-10-01T12:00:00.000Z',
	});
	expect(p.files).toEqual(['/work/app/a.ts', '/work/app/b.ts']);
});

test('parseSession shows a slash command as /command args instead of raw tags', () => {
	const raw =
		'<command-message>doctor</command-message>\n<command-name>/doctor</command-name>\n<command-args>--fix now</command-args>';
	expect(parseSession(lines(user(raw)), ID_A).firstPrompt).toBe('/doctor --fix now');
});

test('parseSession on a bare transcript leaves optional fields blank', () => {
	const p = parseSession(lines(user('only prompt')), ID_A);
	expect(p).toMatchObject({ title: '', prUrl: '', prNumber: null, costUSD: null, files: [] });
	expect(parseSession('', ID_A).project).toBe('');
});

test('liveSessionIds counts a running pid and ignores a dead one', () => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: ID_A }));
	fs.writeFileSync(path.join(dir, '999999.json'), JSON.stringify({ pid: 999999, sessionId: ID_B }));
	fs.writeFileSync(path.join(dir, 'broken.json'), 'nope');
	expect([...liveSessionIds(dir)]).toEqual([ID_A]);
	expect(liveSessionIds(path.join(dir, 'missing')).size).toBe(0);
});

test('buildCatalog groups by project, falls back to the prompt as title, skips empty projects, marks live', () => {
	const roots = fakeClaude({
		'-work-app': {
			[ID_A]: lines(user('add login page'), tool('Edit', { file_path: '/work/app/login.ts' })),
			[ID_B]: lines({ type: 'ai-title', aiTitle: 'Titled' }, user('later', { timestamp: '2026-10-02T10:00:00.000Z' })),
		},
		'-work-other': { [ID_C]: lines(user('other', { cwd: '/work/other', timestamp: '2026-10-03T10:00:00.000Z' })) },
		'-work-empty': {},
	});
	fs.writeFileSync(path.join(roots.sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: ID_B }));

	const groups = buildCatalog(roots);
	expect(groups.map((g) => g.project)).toEqual(['/work/other', '/work/app']);
	const app = groups[1]!;
	expect(app.sessions.map((s) => s.id)).toEqual([ID_B, ID_A]);
	expect(app.sessions.find((s) => s.id === ID_A)!.title).toBe('add login page');
	expect(app.sessions.find((s) => s.id === ID_B)).toMatchObject({ title: 'Titled', live: true });
});

test('buildCatalog survives an unreadable transcript and keeps the other sessions', () => {
	const roots = fakeClaude({ '-work-app': { [ID_A]: lines(user('ok')), [ID_B]: lines(user('bad')) } });
	const groups = buildCatalog(roots, new Map(), (file) => {
		if (file.includes(ID_B)) throw new Error('EACCES');
		return fs.readFileSync(file, 'utf-8');
	});
	expect(groups[0]!.sessions.map((s) => s.id)).toEqual([ID_A]);
});

test('buildCatalog re-reads a transcript only when its mtime or size changed', () => {
	const roots = fakeClaude({ '-work-app': { [ID_A]: lines(user('one')) } });
	const cache: Cache = new Map();
	let reads = 0;
	const read = (f: string) => (reads++, fs.readFileSync(f, 'utf-8'));
	buildCatalog(roots, cache, read);
	buildCatalog(roots, cache, read);
	expect(reads).toBe(1);
	fs.appendFileSync(path.join(roots.projectsDir, '-work-app', `${ID_A}.jsonl`), `\n${JSON.stringify(user('two'))}`);
	const groups = buildCatalog(roots, cache, read);
	expect(reads).toBe(2);
	expect(groups[0]!.sessions[0]!.lastPrompt).toBe('two');
});

const sample = (): ProjectGroup[] => {
	const roots = fakeClaude({
		'-a': {
			[ID_A]: lines(
				{ type: 'ai-title', aiTitle: 'Login work' },
				user('login', { cwd: '/a' }),
				tool('Edit', { file_path: '/a/src/auth.ts' }),
			),
			[ID_B]: lines(user('billing', { cwd: '/a', timestamp: '2026-10-02T10:00:00.000Z' }), 'x'.repeat(500)),
		},
		'-b': { [ID_C]: lines(user('docs', { cwd: '/b', timestamp: '2026-10-03T10:00:00.000Z' })) },
	});
	fs.writeFileSync(path.join(roots.sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: ID_C }));
	return buildCatalog(roots);
};
const ids = (gs: ProjectGroup[]) => gs.flatMap((g) => g.sessions.map((s) => s.id));

test('filterCatalog searches title, prompts, files, name and tags; filters project and live; sorts', () => {
	const groups = sample();
	expect(ids(filterCatalog(groups, { q: 'LOGIN' }))).toEqual([ID_A]);
	expect(ids(filterCatalog(groups, { q: 'auth.ts' }))).toEqual([ID_A]);
	expect(ids(filterCatalog(groups, { q: 'nothing-matches' }))).toEqual([]);
	expect(ids(filterCatalog(groups, { q: 'invoices' }, { [ID_B]: { name: 'Invoices', tags: ['finance'] } }))).toEqual([ID_B]);
	expect(ids(filterCatalog(groups, { q: 'finance' }, { [ID_B]: { tags: ['finance'] } }))).toEqual([ID_B]);
	expect(ids(filterCatalog(groups, { project: '/a', q: 'billing' }))).toEqual([ID_B]);
	expect(ids(filterCatalog(groups, { live: true }))).toEqual([ID_C]);
	expect(ids(filterCatalog(groups, { project: '/a', sort: 'size' }))).toEqual([ID_B, ID_A]);
	expect(ids(filterCatalog(groups, { project: '/a' }))).toEqual([ID_B, ID_A]);
});

// ---- linked memories -------------------------------------------------------------------------------------------

const doc = (id: string, session: string, type = 'session_summary') => ({
	id,
	createdAt: '2026-10-01T10:00:00.000Z',
	metadata: { session, type },
});

test('linkMemories maps notes to sessions by metadata.session', async () => {
	const client = {
		isHealthy: async () => true,
		// notes of project /a only; /b has none
		listDocuments: async ({ containerTags = [] }: { containerTags?: string[] }) =>
			containerTags[0] === resolveProject('/a').containerTag
				? [doc('d1', ID_A), doc('d2', ID_A, 'change_observation'), doc('d3', ID_B), { id: 'd4', createdAt: '', metadata: {} }]
				: [],
		getDocument: async () => null,
	};
	const links = await linkMemories(sample(), client);
	expect(links.available).toBe(true);
	expect(links.bySession[ID_A]!.map((m) => m.id)).toEqual(['d1', 'd2']);
	expect(links.bySession[ID_B]!.map((m) => m.type)).toEqual(['session_summary']);
});

test('linkMemories reports unavailable (not an error) when the memory server is down', async () => {
	const client = {
		isHealthy: async () => false,
		listDocuments: async (): Promise<never> => {
			throw new Error('must not be called');
		},
		getDocument: async () => null,
	};
	expect(await linkMemories(sample(), client)).toEqual({ available: false, incomplete: false, bySession: {} });
});

test('memoryExcerpts shortens note text', async () => {
	const client = {
		isHealthy: async () => true,
		listDocuments: async () => [],
		getDocument: async (id: string) => ({ id, createdAt: '', content: 'word '.repeat(200) }),
	};
	const [ex] = await memoryExcerpts(client, [{ id: 'd1', type: 't', createdAt: '' }], 20);
	expect(ex!.excerpt.length).toBe(21);
	expect(ex!.excerpt.endsWith('…')).toBe(true);
});

test('building the catalog and its links sends no transcript text, only tags and a limit to the local server', async () => {
	const SECRET = 'SECRET-PROMPT-TEXT';
	const roots = fakeClaude({
		'-a': { [ID_A]: lines(user(SECRET, { cwd: '/a' }), tool('Edit', { file_path: '/a/secret-file.ts' })) },
	});
	const groups = buildCatalog(roots);
	const calls: { url: string; body: string }[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), body: String(init?.body ?? '') });
		return Response.json(String(url).includes('/documents/list') ? { memories: [] } : {});
	}) as unknown as typeof fetch;
	try {
		await linkMemories(groups, new SupermemoryClient({ baseUrl: 'http://127.0.0.1:6767', apiKey: 'k' }));
	} finally {
		globalThis.fetch = realFetch;
	}
	expect(calls.length).toBeGreaterThan(0);
	for (const c of calls) {
		expect(c.url.startsWith('http://127.0.0.1:6767/')).toBe(true);
		expect(c.url + c.body).not.toContain(SECRET);
		expect(c.url + c.body).not.toContain('secret-file');
		expect(c.url + c.body).not.toContain(ID_A); // listing is per project; ids never need to leave
	}
});
