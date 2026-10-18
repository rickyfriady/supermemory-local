// Unit checks for the sessions UI actions (approval queue, trash, sidecar): bun test
import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	ActionError,
	SessionActions,
	listTrash,
	newSessionCommand,
	readMeta,
	resumeCommand,
	type Deps,
} from './sessions-actions.ts';
import { buildCatalog, type Roots } from './sessions-scan.ts';
import { SupermemoryClient } from './supermemory-client.ts';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const TRANSCRIPT = `${JSON.stringify({ type: 'user', cwd: '/work/app', timestamp: '2026-10-01T10:00:00.000Z', message: { content: 'hello' } })}\n`;

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Temp ~/.claude with session A (transcript + sibling folder + file-history) and session B (transcript only) */
function setup() {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-actions-'));
	tmpDirs.push(home);
	const roots: Roots = {
		projectsDir: path.join(home, 'claude', 'projects'),
		sessionsDir: path.join(home, 'claude', 'sessions'),
		fileHistoryDir: path.join(home, 'claude', 'file-history'),
	};
	const dataDir = path.join(home, 'data');
	const slug = path.join(roots.projectsDir, '-work-app');
	fs.mkdirSync(slug, { recursive: true });
	fs.mkdirSync(roots.sessionsDir, { recursive: true });
	fs.writeFileSync(path.join(slug, `${ID_A}.jsonl`), TRANSCRIPT);
	fs.mkdirSync(path.join(slug, ID_A, 'subagents'), { recursive: true });
	fs.writeFileSync(path.join(slug, ID_A, 'subagents', 'x.jsonl'), 'sub');
	fs.mkdirSync(path.join(roots.fileHistoryDir, ID_A), { recursive: true });
	fs.writeFileSync(path.join(roots.fileHistoryDir, ID_A, 'abc@v1'), 'backup');
	fs.writeFileSync(path.join(slug, `${ID_B}.jsonl`), TRANSCRIPT);
	return {
		roots,
		dataDir,
		transcriptA: path.join(slug, `${ID_A}.jsonl`),
		folderA: path.join(slug, ID_A),
		historyA: path.join(roots.fileHistoryDir, ID_A),
	};
}

const yes = async () => true;
const no = async () => false;
const make = (env: ReturnType<typeof setup>, over: Partial<Deps> = {}) =>
	new SessionActions({ roots: env.roots, dataDir: env.dataDir, prompt: yes, isLive: () => false, ...over });
const logLines = (dataDir: string) =>
	fs.existsSync(path.join(dataDir, 'sessions-ui.log'))
		? fs
				.readFileSync(path.join(dataDir, 'sessions-ui.log'), 'utf-8')
				.trim()
				.split('\n')
				.map((l) => JSON.parse(l))
		: [];
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ---- 3.1 approval state machine -----------------------------------------------------------------------------------

test('create() only records a pending action; nothing runs until the terminal prompt says yes', async () => {
	const env = setup();
	let answer!: (ok: boolean) => void;
	const actions = make(env, { prompt: () => new Promise((r) => (answer = r)) });
	const a = actions.create({ kind: 'delete', sessionId: ID_A });
	await new Promise((r) => setTimeout(r, 10));
	expect(actions.get(a.id)!.status).toBe('pending');
	expect(fs.existsSync(env.transcriptA)).toBe(true);
	answer(true);
	await actions.idle();
	expect(actions.get(a.id)!.status).toBe('done');
	expect(fs.existsSync(env.transcriptA)).toBe(false);
});

test('a rejected action changes nothing', async () => {
	const env = setup();
	const actions = make(env, { prompt: no });
	const a = actions.create({ kind: 'delete', sessionId: ID_A });
	await actions.idle();
	expect(actions.get(a.id)!.status).toBe('rejected');
	expect(fs.existsSync(env.transcriptA)).toBe(true);
	expect(logLines(env.dataDir).map((l) => l.status)).toEqual(['rejected']);
});

test('an action expires after 5 minutes, and a late "y" is ignored', async () => {
	const env = setup();
	let t = 1_000_000;
	let answer!: (ok: boolean) => void;
	const actions = make(env, { now: () => t, prompt: () => new Promise((r) => (answer = r)) });
	const a = actions.create({ kind: 'delete', sessionId: ID_A });
	t += 5 * 60_000 + 1;
	expect(actions.get(a.id)!.status).toBe('expired'); // the browser sees it right away
	answer(true);
	await actions.idle();
	expect(actions.get(a.id)!.status).toBe('expired');
	expect(fs.existsSync(env.transcriptA)).toBe(true);
});

test('prompts are asked one at a time, in order', async () => {
	const env = setup();
	const asked: string[] = [];
	let open = 0;
	let maxOpen = 0;
	const actions = make(env, {
		prompt: async (s) => {
			asked.push(s);
			maxOpen = Math.max(maxOpen, ++open);
			await new Promise((r) => setTimeout(r, 5));
			open--;
			return false;
		},
	});
	actions.create({ kind: 'delete', sessionId: ID_A });
	actions.create({ kind: 'delete', sessionId: ID_B });
	await actions.idle();
	expect(maxOpen).toBe(1);
	expect(asked.map((s) => s.includes(ID_A.slice(0, 8)))).toEqual([true, false]);
});

test('the public surface has no way to approve: only create/get/list/idle', () => {
	const names = Object.getOwnPropertyNames(SessionActions.prototype).filter((n) => !n.startsWith('_'));
	const publicOnes = names.filter(
		(n) =>
			![
				'constructor',
				'view',
				'validate',
				'pump',
				'process',
				'finish',
				'execute',
				'softDelete',
				// OpenCode/agy helpers: none of them can answer a prompt
				'openCode',
				'assertOpenCodeIdle',
				'otherSession',
				'agentOf',
				'checkSessionId',
				'openCodeDelete',
				'openCodeRestore',
			].includes(n),
	);
	expect(publicOnes.sort()).toEqual(['create', 'get', 'idle', 'list']);
});

// ---- 3.2 soft delete ----------------------------------------------------------------------------------------------

test('approved delete moves transcript, sibling folder and file-history into the trash with a manifest', async () => {
	const env = setup();
	const actions = make(env, { describe: () => '"Fix login"' });
	const a = actions.create({ kind: 'delete', sessionId: ID_A });
	await actions.idle();
	expect(actions.get(a.id)!.status).toBe('done');
	for (const p of [env.transcriptA, env.folderA, env.historyA]) expect(fs.existsSync(p)).toBe(false);
	const [entry] = listTrash(env.dataDir);
	expect(entry).toMatchObject({ id: ID_A, label: '"Fix login"' });
	const dir = path.join(env.dataDir, 'sessions-trash', entry!.trashId);
	expect(fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf-8')).toBe(TRANSCRIPT);
	expect(fs.readFileSync(path.join(dir, 'session-dir', 'subagents', 'x.jsonl'), 'utf-8')).toBe('sub');
	expect(fs.readFileSync(path.join(dir, 'file-history', 'abc@v1'), 'utf-8')).toBe('backup');
	expect(buildCatalog(env.roots).flatMap((g) => g.sessions.map((s) => s.id))).toEqual([ID_B]);
});

test('a live session is refused at request time without creating a pending action', () => {
	const env = setup();
	const actions = make(env, { isLive: (id) => id === ID_A });
	expect(() => actions.create({ kind: 'delete', sessionId: ID_A })).toThrow(ActionError);
	expect(actions.list()).toEqual([]);
	expect(fs.existsSync(env.transcriptA)).toBe(true);
});

test('a session that starts running between request and approval is not moved', async () => {
	const env = setup();
	let live = false;
	const actions = make(env, {
		isLive: () => live,
		prompt: async () => {
			live = true; // started while the human was reading the prompt
			return true;
		},
	});
	const a = actions.create({ kind: 'delete', sessionId: ID_A });
	await actions.idle();
	expect(actions.get(a.id)).toMatchObject({ status: 'failed' });
	expect(fs.existsSync(env.transcriptA)).toBe(true);
	expect(listTrash(env.dataDir)).toEqual([]);
});

test('malformed or unknown ids are rejected before anything is created', () => {
	const env = setup();
	const actions = make(env);
	for (const sessionId of ['../../etc/passwd', 'abc', '', `${ID_A}/..`]) {
		expect(() => actions.create({ kind: 'delete', sessionId })).toThrow(ActionError);
	}
	expect(() => actions.create({ kind: 'delete', sessionId: '99999999-9999-4999-8999-999999999999' })).toThrow('not found');
	expect(() => actions.create({ kind: 'purge', trashId: '../../x' })).toThrow('invalid trash id');
	expect(actions.list()).toEqual([]);
});

// ---- 3.3 restore and purge ----------------------------------------------------------------------------------------

test('restore puts every file back and empties the trash entry', async () => {
	const env = setup();
	const actions = make(env);
	actions.create({ kind: 'delete', sessionId: ID_A });
	await actions.idle();
	const { trashId } = listTrash(env.dataDir)[0]!;
	const r = actions.create({ kind: 'restore', trashId });
	await actions.idle();
	expect(actions.get(r.id)!.status).toBe('done');
	expect(fs.readFileSync(env.transcriptA, 'utf-8')).toBe(TRANSCRIPT);
	expect(fs.existsSync(path.join(env.folderA, 'subagents', 'x.jsonl'))).toBe(true);
	expect(fs.existsSync(path.join(env.historyA, 'abc@v1'))).toBe(true);
	expect(listTrash(env.dataDir)).toEqual([]);
});

test('restore is refused when a target already exists, and overwrites nothing', async () => {
	const env = setup();
	const actions = make(env);
	actions.create({ kind: 'delete', sessionId: ID_A });
	await actions.idle();
	const { trashId } = listTrash(env.dataDir)[0]!;
	fs.mkdirSync(env.historyA, { recursive: true });
	fs.writeFileSync(path.join(env.historyA, 'new-file'), 'keep me');
	const r = actions.create({ kind: 'restore', trashId });
	await actions.idle();
	expect(actions.get(r.id)).toMatchObject({ status: 'failed' });
	expect(fs.readFileSync(path.join(env.historyA, 'new-file'), 'utf-8')).toBe('keep me');
	expect(fs.existsSync(env.transcriptA)).toBe(false); // nothing was half-restored
	expect(listTrash(env.dataDir)).toHaveLength(1);
});

test('purge permanently removes the trash entry', async () => {
	const env = setup();
	const actions = make(env);
	actions.create({ kind: 'delete', sessionId: ID_A });
	await actions.idle();
	const { trashId } = listTrash(env.dataDir)[0]!;
	actions.create({ kind: 'purge', trashId });
	await actions.idle();
	expect(listTrash(env.dataDir)).toEqual([]);
	expect(fs.existsSync(path.join(env.dataDir, 'sessions-trash', trashId))).toBe(false);
});

// ---- 3.4 sidecar and audit log --------------------------------------------------------------------------------------

test('rename and tags go to the sidecar, the transcript stays byte-identical, and they survive delete + restore', async () => {
	const env = setup();
	const before = sha(env.transcriptA);
	const actions = make(env);
	actions.create({ kind: 'rename', sessionId: ID_A, name: '  Login work  ' });
	actions.create({ kind: 'tags', sessionId: ID_A, tags: ['Auth', ' auth ', 'urgent', ''] });
	await actions.idle();
	expect(readMeta(env.dataDir)[ID_A]).toEqual({ name: 'Login work', tags: ['auth', 'urgent'] });
	expect(sha(env.transcriptA)).toBe(before);

	actions.create({ kind: 'delete', sessionId: ID_A });
	await actions.idle();
	actions.create({ kind: 'restore', trashId: listTrash(env.dataDir)[0]!.trashId });
	await actions.idle();
	expect(readMeta(env.dataDir)[ID_A]).toEqual({ name: 'Login work', tags: ['auth', 'urgent'] });
	expect(sha(env.transcriptA)).toBe(before);
});

test('an empty name and no tags removes the sidecar entry; bad input is rejected', async () => {
	const env = setup();
	const actions = make(env);
	actions.create({ kind: 'rename', sessionId: ID_A, name: 'x' });
	await actions.idle();
	actions.create({ kind: 'rename', sessionId: ID_A, name: '' });
	await actions.idle();
	expect(readMeta(env.dataDir)).toEqual({});
	expect(() => actions.create({ kind: 'rename', sessionId: ID_A, name: 'x'.repeat(101) })).toThrow(ActionError);
	expect(() => actions.create({ kind: 'tags', sessionId: ID_A, tags: Array(21).fill('t') })).toThrow(ActionError);
});

test('every outcome writes exactly one audit line', async () => {
	const env = setup();
	const answers = [true, false, true];
	const actions = make(env, { prompt: async () => answers.shift()! });
	actions.create({ kind: 'rename', sessionId: ID_A, name: 'one' });
	actions.create({ kind: 'rename', sessionId: ID_A, name: 'two' });
	actions.create({ kind: 'delete', sessionId: ID_B });
	await actions.idle();
	expect(logLines(env.dataDir).map((l) => [l.kind, l.status])).toEqual([
		['rename', 'done'],
		['rename', 'rejected'],
		['delete', 'done'],
	]);
});

// ---- 3.5 linked memory deletion -------------------------------------------------------------------------------------

test('delete with memories moves the files even when a note cannot be deleted, and reports it', async () => {
	const env = setup();
	const calls: string[] = [];
	const actions = make(env, {
		memoryIds: async () => ['note-ok', 'note-busy'],
		client: {
			request: (async (method: string, url: string) => {
				calls.push(`${method} ${url}`);
				return url.endsWith('note-busy')
					? { success: false, error: 'HTTP 409: Document is still processing' }
					: { success: true, data: {} };
			}) as never,
		},
	});
	const a = actions.create({ kind: 'delete', sessionId: ID_A, deleteMemories: true });
	await actions.idle();
	expect(calls).toEqual(['DELETE /v3/documents/note-ok', 'DELETE /v3/documents/note-busy']);
	expect(fs.existsSync(env.transcriptA)).toBe(false);
	expect(actions.get(a.id)!.result).toMatchObject({
		memories: { deleted: 1, failed: [{ id: 'note-busy', error: 'HTTP 409: Document is still processing' }] },
	});
});

test('delete without the option never touches memories', async () => {
	const env = setup();
	let touched = false;
	const actions = make(env, {
		memoryIds: async () => {
			touched = true;
			return ['n'];
		},
		client: { request: (async () => ((touched = true), { success: true, data: {} })) as never },
	});
	actions.create({ kind: 'delete', sessionId: ID_A });
	await actions.idle();
	expect(touched).toBe(false);
});

test('SupermemoryClient.request treats an empty 204 (the real DELETE answer) as success, not a JSON error', async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
	try {
		const client = new SupermemoryClient({ baseUrl: 'http://127.0.0.1:6767', apiKey: 'k' });
		expect(await client.request('DELETE', '/v3/documents/x')).toEqual({ success: true, data: undefined });
	} finally {
		globalThis.fetch = realFetch;
	}
});

// ---- 3.6 commands -------------------------------------------------------------------------------------------------

test('resume and new-session commands quote awkward directories safely', () => {
	expect(resumeCommand("/Users/me/my app/it's", ID_A)).toBe(`cd '/Users/me/my app/it'\\''s' && claude --resume ${ID_A}`);
	expect(newSessionCommand('/work/app')).toBe("cd '/work/app' && claude");
	expect(() => resumeCommand('/x', 'bad; rm -rf /')).toThrow(ActionError);
});
