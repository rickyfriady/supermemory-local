// Checks for rename/tags on OpenCode + agy sessions and for deleting/restoring OpenCode ones. The OpenCode CLI is replaced by a fake that
// edits a throwaway SQLite file, so every failure path can be forced: bun test
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findOpenCode, hasOpenCodeProcess, realOpenCode, type OpenCodeCli } from './opencode-cli.ts';
import { SessionActions, listOpenCodeTrash, readMeta, type ActionRequest } from './sessions-actions.ts';
import { listOpenCode, openCodeFamily } from './sessions-other.ts';
import { createApp } from './sessions-server.ts';

const PARENT = 'ses_parent0001';
const CHILD = 'ses_child00001';
const OTHER = 'ses_other00001';
const AGY = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface FakeState {
	running: boolean;
	failExport: boolean;
	failDelete: boolean;
	/** delete reports success but removes nothing */
	noopDelete: boolean;
	failImportOn: Set<string>;
	calls: string[];
}

function setup(prompt: (summary: string) => Promise<boolean> = async () => true) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-oc-'));
	tmpDirs.push(home);
	const opencodeDb = path.join(home, 'opencode.db');
	const agyDb = path.join(home, 'conversation_summaries.db');

	const oc = new Database(opencodeDb);
	oc.run(
		'create table session_v2 (id text primary key, parent_id text, directory text not null, title text, time_created integer not null, time_updated integer not null, agent text, model text, summary_files integer, cost real default 0, time_archived integer)',
	);
	const add = oc.prepare(
		'insert into session_v2 (id, parent_id, directory, title, time_created, time_updated) values (?,?,?,?,?,?)',
	);
	add.run(PARENT, null, '/w/app', 'Parent work', 1, 2000);
	add.run(CHILD, PARENT, '/w/app', 'Sub-agent', 1, 2100);
	add.run(OTHER, null, '/w/other', 'Other work', 1, 1000);
	oc.close();

	const agy = new Database(agyDb);
	agy.run(
		'create table conversation_summaries (conversation_id text primary key, title text not null default "", preview text not null default "", step_count integer not null default 0, last_modified_time datetime not null, workspace_uris text not null, parent_conversation_id text not null default "")',
	);
	agy.run('insert into conversation_summaries values (?,?,?,?,?,?,?)', [
		AGY,
		'agy chat',
		'',
		3,
		'2026-10-13 03:00:00+00:00',
		'["file:///w/agy"]',
		'',
	]);
	agy.close();

	const state: FakeState = {
		running: false,
		failExport: false,
		failDelete: false,
		noopDelete: false,
		failImportOn: new Set(),
		calls: [],
	};
	const withDb = <T>(fn: (db: Database) => T): T => {
		const db = new Database(opencodeDb);
		try {
			return fn(db);
		} finally {
			db.close();
		}
	};
	const cli: OpenCodeCli = {
		running: () => state.running,
		exportSession: async (id) => {
			state.calls.push(`export ${id}`);
			if (state.failExport) throw new Error('export boom');
			const row = withDb((db) => db.query('select id, parent_id, directory, title from session_v2 where id = ?').get(id)) as {
				parent_id: string | null;
				directory: string;
				title: string;
			} | null;
			if (!row) throw new Error('no such session');
			return JSON.stringify({
				info: {
					id,
					...(row.parent_id ? { parentID: row.parent_id } : {}),
					title: row.title,
					location: { directory: row.directory },
				},
				messages: [{ id: 'm1', text: `secret text of ${id}` }],
			});
		},
		deleteSession: async (id) => {
			state.calls.push(`delete ${id}`);
			if (state.failDelete) throw new Error('delete boom');
			if (state.noopDelete) return;
			withDb((db) =>
				db.run(
					'with recursive fam(id) as (select ? union all select s.id from session_v2 s join fam on s.parent_id = fam.id) delete from session_v2 where id in (select id from fam)',
					[id],
				),
			);
		},
		importSession: async (file, directory) => {
			const e = JSON.parse(fs.readFileSync(file, 'utf-8')) as { info: { id: string; parentID?: string; title: string } };
			state.calls.push(`import ${e.info.id} ${directory}`);
			if (state.failImportOn.has(e.info.id)) throw new Error('import boom');
			withDb((db) =>
				db.run('insert into session_v2 (id, parent_id, directory, title, time_created, time_updated) values (?,?,?,?,?,?)', [
					e.info.id,
					e.info.parentID ?? null,
					directory,
					e.info.title,
					1,
					NOW,
				]),
			);
		},
	};
	const dataDir = path.join(home, 'data');
	const asked: string[] = [];
	const actions = new SessionActions({
		roots: { projectsDir: path.join(home, 'p'), sessionsDir: path.join(home, 's'), fileHistoryDir: path.join(home, 'f') },
		dataDir,
		prompt: async (summary) => {
			asked.push(summary);
			return prompt(summary);
		},
		isLive: () => false,
		now: () => NOW,
		others: { opencodeDb, agyDb },
		opencode: cli,
	});
	const ids = () => listOpenCode(opencodeDb).sessions.map((s) => s.id);
	const family = (id: string) => openCodeFamily(opencodeDb, id);
	const run = async (req: ActionRequest) => {
		const a = actions.create(req);
		await actions.idle();
		return actions.get(a.id)!;
	};
	return { home, dataDir, opencodeDb, agyDb, state, actions, asked, ids, family, run, cli };
}

// ---- rename and tags -------------------------------------------------------------------------------------------------

test('rename and tags work for OpenCode and agy sessions and live in the sidecar under a prefixed key', async () => {
	const t = setup();
	expect((await t.run({ kind: 'rename', agent: 'opencode', sessionId: PARENT, name: '  My title ' })).status).toBe('done');
	expect((await t.run({ kind: 'tags', agent: 'antigravity', sessionId: AGY, tags: ['Review', 'review', 'zsh'] })).status).toBe(
		'done',
	);
	expect(readMeta(t.dataDir)).toEqual({
		[`opencode:${PARENT}`]: { name: 'My title' },
		[`antigravity:${AGY}`]: { tags: ['review', 'zsh'] },
	});
	expect(t.asked[0]).toContain('RENAME opencode session');
	expect(t.state.calls).toEqual([]); // the agent's own CLI and database are never involved
});

test('rename of an unknown, malformed or wrong-agent id is refused before anything is queued', () => {
	const t = setup();
	const refuse = (req: ActionRequest) => expect(() => t.actions.create(req)).toThrow();
	refuse({ kind: 'rename', agent: 'opencode', sessionId: 'ses_doesnotexist1', name: 'x' });
	refuse({ kind: 'rename', agent: 'opencode', sessionId: '../../etc/passwd', name: 'x' });
	refuse({ kind: 'rename', agent: 'opencode', sessionId: AGY, name: 'x' }); // an agy id is not an OpenCode session
	refuse({ kind: 'tags', agent: 'antigravity', sessionId: PARENT, tags: [] });
	refuse({ kind: 'rename', agent: 'gemini' as never, sessionId: PARENT, name: 'x' });
	expect(t.actions.list()).toEqual([]);
});

test('Antigravity sessions cannot be deleted, restored or purged', () => {
	const t = setup();
	expect(() => t.actions.create({ kind: 'delete', agent: 'antigravity' as never, sessionId: AGY })).toThrow('not supported');
	expect(() => t.actions.create({ kind: 'purge', agent: 'antigravity' as never, trashId: 'x' })).toThrow('not supported');
});

// ---- delete ----------------------------------------------------------------------------------------------------------

test('delete: backs up the session and its sub-agent sessions, then deletes them through the CLI', async () => {
	const t = setup();
	const a = await t.run({ kind: 'delete', agent: 'opencode', sessionId: PARENT });
	expect(a.status).toBe('done');
	expect(a.result).toEqual({ trashId: `${NOW}_${PARENT}`, sessions: 2 });
	expect(t.ids()).toEqual([OTHER]); // parent and child gone, the unrelated session untouched
	expect(t.family(OTHER)).toEqual([OTHER]);

	const file = path.join(t.dataDir, 'opencode-trash', `${NOW}_${PARENT}.json`);
	const backup = JSON.parse(fs.readFileSync(file, 'utf-8'));
	expect(backup.exports.map((e: { info: { id: string } }) => e.info.id)).toEqual([PARENT, CHILD]); // parent first
	expect(backup.exports[1].info.parentID).toBe(PARENT);
	expect(fs.statSync(file).mode & 0o777).toBe(0o600); // the backup holds transcripts
	expect(t.state.calls).toEqual([`export ${PARENT}`, `export ${CHILD}`, `delete ${PARENT}`]);

	const [entry] = listOpenCodeTrash(t.dataDir);
	expect(entry).toMatchObject({ id: PARENT, label: 'Parent work', trashId: `${NOW}_${PARENT}`, agent: 'opencode' });
});

test('delete: the backup is on disk before the CLI deletes anything', async () => {
	const t = setup();
	const file = path.join(t.dataDir, 'opencode-trash', `${NOW}_${PARENT}.json`);
	let backedUpFirst = false;
	const del = t.cli.deleteSession;
	t.cli.deleteSession = async (id) => {
		backedUpFirst = fs.existsSync(file);
		return del(id);
	};
	await t.run({ kind: 'delete', agent: 'opencode', sessionId: PARENT });
	expect(backedUpFirst).toBe(true);
});

test('delete: rejecting at the terminal changes nothing', async () => {
	const t = setup(async () => false);
	const a = await t.run({ kind: 'delete', agent: 'opencode', sessionId: PARENT });
	expect(a.status).toBe('rejected');
	expect(t.state.calls).toEqual([]);
	expect(t.ids()).toEqual([PARENT, OTHER].sort((x, y) => (x === PARENT ? -1 : 1)));
	expect(fs.existsSync(path.join(t.dataDir, 'opencode-trash'))).toBe(false);
});

test('delete: refused while OpenCode is running, at request time and again right before the change', async () => {
	const t = setup();
	t.state.running = true;
	expect(() => t.actions.create({ kind: 'delete', agent: 'opencode', sessionId: PARENT })).toThrow('OpenCode is running');

	t.state.running = false;
	const a = t.actions.create({ kind: 'delete', agent: 'opencode', sessionId: PARENT });
	t.state.running = true; // OpenCode started while the prompt was waiting
	await t.actions.idle();
	expect(t.actions.get(a.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('started running') });
	expect(t.state.calls).toEqual([]);
	expect(t.ids()).toContain(PARENT);
});

test('delete: a failing export aborts before the CLI is asked to delete anything and leaves no backup', async () => {
	const t = setup();
	t.state.failExport = true;
	const a = await t.run({ kind: 'delete', agent: 'opencode', sessionId: PARENT });
	expect(a.status).toBe('failed');
	expect(t.state.calls.some((c) => c.startsWith('delete'))).toBe(false);
	expect(t.ids()).toContain(PARENT);
	expect(listOpenCodeTrash(t.dataDir)).toEqual([]);
});

test('delete: an export that is not for this session is rejected', async () => {
	const t = setup();
	t.cli.exportSession = async () => JSON.stringify({ info: { id: 'ses_someoneelse1' }, messages: [] });
	const a = await t.run({ kind: 'delete', agent: 'opencode', sessionId: PARENT });
	expect(a.status).toBe('failed');
	expect(t.state.calls).toEqual([]);
	expect(t.ids()).toContain(PARENT);
});

test('delete: if OpenCode still lists the session afterwards the backup is kept and the failure is reported', async () => {
	const t = setup();
	t.state.failDelete = true;
	const a = await t.run({ kind: 'delete', agent: 'opencode', sessionId: PARENT });
	expect(a.status).toBe('failed');
	expect(a.error).toContain('still lists the session');
	expect(a.error).toContain('delete boom');
	expect(t.ids()).toContain(PARENT);
	expect(listOpenCodeTrash(t.dataDir)).toHaveLength(1); // never throw a backup away on a failure path
});

test('delete: a request with deleteMemories is refused for OpenCode (its sessions have no linked notes)', () => {
	const t = setup();
	expect(() => t.actions.create({ kind: 'delete', agent: 'opencode', sessionId: PARENT, deleteMemories: true })).toThrow(
		'not linked',
	);
});

// ---- restore and purge -----------------------------------------------------------------------------------------------

test('restore: re-imports the parent first, then the sub-agent session, and removes the backup', async () => {
	const t = setup();
	await t.run({ kind: 'tags', agent: 'opencode', sessionId: PARENT, tags: ['keep'] });
	await t.run({ kind: 'delete', agent: 'opencode', sessionId: PARENT });
	t.state.calls.length = 0;

	const a = await t.run({ kind: 'restore', agent: 'opencode', trashId: `${NOW}_${PARENT}` });
	expect(a.status).toBe('done');
	expect(t.state.calls).toEqual([`import ${PARENT} /w/app`, `import ${CHILD} /w/app`]);
	expect(t.family(PARENT)).toEqual([PARENT, CHILD]);
	expect(listOpenCodeTrash(t.dataDir)).toEqual([]);
	expect(readMeta(t.dataDir)[`opencode:${PARENT}`]).toEqual({ tags: ['keep'] }); // tags survive delete + restore
});

test('restore: refused when the session already exists, and while OpenCode is running', async () => {
	const t = setup();
	await t.run({ kind: 'delete', agent: 'opencode', sessionId: PARENT });
	const id = `${NOW}_${PARENT}`;

	t.state.running = true;
	expect(() => t.actions.create({ kind: 'restore', agent: 'opencode', trashId: id })).toThrow('OpenCode is running');
	t.state.running = false;

	await t.run({ kind: 'restore', agent: 'opencode', trashId: id });
	// put the backup back by hand and try again: both sessions exist now, nothing may be imported twice
	fs.mkdirSync(path.join(t.dataDir, 'opencode-trash'), { recursive: true });
	const backup = {
		version: 1,
		id: PARENT,
		label: 'x',
		deletedAt: new Date(NOW).toISOString(),
		exports: [
			{ info: { id: PARENT }, messages: [] },
			{ info: { id: CHILD }, messages: [] },
		],
	};
	fs.writeFileSync(path.join(t.dataDir, 'opencode-trash', `${id}.json`), JSON.stringify(backup));
	t.state.calls.length = 0;
	const again = await t.run({ kind: 'restore', agent: 'opencode', trashId: id });
	expect(again.status).toBe('failed');
	expect(again.error).toContain('already exists');
	expect(t.state.calls).toEqual([]);
});

test('restore: a half-finished restore keeps the backup and a retry imports only what is missing', async () => {
	const t = setup();
	await t.run({ kind: 'delete', agent: 'opencode', sessionId: PARENT });
	const id = `${NOW}_${PARENT}`;
	t.state.failImportOn.add(CHILD);
	const first = await t.run({ kind: 'restore', agent: 'opencode', trashId: id });
	expect(first.status).toBe('failed');
	expect(t.ids()).toContain(PARENT);
	expect(t.family(PARENT)).toEqual([PARENT]);
	expect(listOpenCodeTrash(t.dataDir)).toHaveLength(1);

	t.state.failImportOn.clear();
	t.state.calls.length = 0;
	const retry = await t.run({ kind: 'restore', agent: 'opencode', trashId: id });
	expect(retry.status).toBe('done');
	expect(t.state.calls).toEqual([`import ${CHILD} /w/app`]); // the parent is not imported twice
	expect(t.family(PARENT)).toEqual([PARENT, CHILD]);
});

test('purge removes only the backup file', async () => {
	const t = setup();
	await t.run({ kind: 'delete', agent: 'opencode', sessionId: PARENT });
	const a = await t.run({ kind: 'purge', agent: 'opencode', trashId: `${NOW}_${PARENT}` });
	expect(a.status).toBe('done');
	expect(listOpenCodeTrash(t.dataDir)).toEqual([]);
	expect(t.ids()).toEqual([OTHER]);
});

test('trash ids are validated: no path can be built from them', () => {
	const t = setup();
	for (const trashId of ['../../etc/passwd', `${NOW}_../../x`, 'x', `${NOW}_ses_`, `${NOW}_${PARENT}/../../x`])
		for (const kind of ['restore', 'purge'] as const)
			expect(() => t.actions.create({ kind, agent: 'opencode', trashId })).toThrow();
	expect(() => t.actions.create({ kind: 'purge', agent: 'opencode', trashId: `${NOW}_ses_missing0001` })).toThrow('not in trash');
});

// ---- API ------------------------------------------------------------------------------------------------------------

test('API: /api/other carries names and tags, /api/trash lists OpenCode backups next to Claude ones, and POST goes through approval', async () => {
	const t = setup();
	const app = createApp({
		port: 20131,
		roots: { projectsDir: path.join(t.home, 'p'), sessionsDir: path.join(t.home, 's'), fileHistoryDir: path.join(t.home, 'f') },
		dataDir: t.dataDir,
		token: 'tok',
		isLive: () => false,
		now: () => NOW,
		prompt: async () => true,
		others: { opencodeDb: t.opencodeDb, agyDb: t.agyDb },
		opencode: t.cli,
		client: {
			isHealthy: async () => false,
			listDocuments: async () => [],
			getDocument: async () => null,
			request: (async () => ({ success: true })) as never,
		},
	});
	const origin = 'http://127.0.0.1:20131';
	const get = (p: string) => app.fetch(new Request(origin + p, { headers: { 'x-token': 'tok' } }));
	const post = (body: unknown) =>
		app.fetch(
			new Request(`${origin}/api/actions`, {
				method: 'POST',
				headers: { 'x-token': 'tok', origin, 'content-type': 'application/json' },
				body: JSON.stringify(body),
			}),
		);

	expect((await post({ kind: 'rename', agent: 'opencode', sessionId: PARENT, name: 'Shown name' })).status).toBe(202);
	expect((await post({ kind: 'delete', agent: 'opencode', sessionId: OTHER })).status).toBe(202);
	await app.actions.idle();

	const other = (await (await get('/api/other')).json()) as any;
	expect(other.opencode.sessions.map((s: any) => [s.id, s.name])).toEqual([[PARENT, 'Shown name']]);
	expect(other.antigravity.sessions[0].id).toBe(AGY);

	const trash = (await (await get('/api/trash')).json()) as any;
	expect(trash.trash).toHaveLength(1);
	expect(trash.trash[0]).toMatchObject({ agent: 'opencode', id: OTHER, label: 'Other work' });

	expect((await post({ kind: 'delete', agent: 'opencode', sessionId: 'nope' })).status).toBe(400);
	expect((await post({ kind: 'delete', agent: 'opencode', sessionId: 'ses_missing00001' })).status).toBe(404);
	t.state.running = true;
	expect((await post({ kind: 'delete', agent: 'opencode', sessionId: PARENT })).status).toBe(409);
});

// ---- opencode-cli ---------------------------------------------------------------------------------------------------

test('findOpenCode skips the Zentty shell-script wrapper and takes the real binary', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-oc-'));
	tmpDirs.push(dir);
	const wrapper = path.join(dir, 'wrapper');
	const real = path.join(dir, 'real');
	fs.mkdirSync(wrapper);
	fs.mkdirSync(real);
	fs.writeFileSync(path.join(wrapper, 'opencode'), '#!/usr/bin/env bash\nexec zentty launch opencode "$@"\n', { mode: 0o755 });
	fs.writeFileSync(path.join(real, 'opencode'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]), { mode: 0o755 });
	expect(findOpenCode([wrapper, real].join(path.delimiter), '')).toBe(path.join(real, 'opencode'));
	expect(findOpenCode(wrapper, '')).toBeUndefined();
	expect(findOpenCode('', path.join(real, 'opencode'))).toBe(path.join(real, 'opencode'));
	expect(findOpenCode('', path.join(real, 'missing'))).toBeUndefined();
});

test('hasOpenCodeProcess matches the executable name only', () => {
	expect(hasOpenCodeProcess('/sbin/launchd\n/opt/homebrew/Cellar/opencode-v2/2.0.26/bin/opencode\n')).toBe(true);
	expect(hasOpenCodeProcess('/bin/zsh\n/usr/bin/grep\n/Users/me/opencode-notes/editor\n/bin/opencode-helper\n')).toBe(false);
});

test('realOpenCode runs exactly `session <verb> --standalone` and surfaces stderr when the CLI fails', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-oc-'));
	tmpDirs.push(dir);
	const log = path.join(dir, 'args.log');
	const bin = path.join(dir, 'opencode');
	fs.writeFileSync(
		bin,
		`#!/bin/sh\necho "$@" >> '${log}'\n[ "$4" = "ses_bad" ] && { echo "no such session" >&2; exit 3; }\necho '{"info":{"id":"x"},"messages":[]}'\n`,
		{ mode: 0o755 },
	);
	const cli = realOpenCode(bin);
	expect(await cli.exportSession('ses_ok')).toContain('"messages"');
	await cli.deleteSession('ses_ok');
	await cli.importSession('/tmp/f.json', '/w/app');
	expect(fs.readFileSync(log, 'utf-8').trim().split('\n')).toEqual([
		'session export --standalone ses_ok',
		'session delete --standalone ses_ok',
		'session import --standalone --directory /w/app /tmp/f.json',
	]);
	await expect(cli.deleteSession('ses_bad')).rejects.toThrow('no such session');
});
