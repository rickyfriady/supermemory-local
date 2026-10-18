// Unit checks for the OpenCode / agy session lists: read-only, sub-agents and empty conversations hidden: bun test
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAgy, listOpenCode, openCodeFamily, otherPaths } from './sessions-other.ts';

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-other-'));
	tmpDirs.push(d);
	return d;
};

function openCodeDb(file: string) {
	const db = new Database(file);
	db.run(
		'create table session (id text primary key, parent_id text, directory text not null, title text not null, time_created integer not null, time_updated integer not null, agent text, model text, summary_files integer, cost real default 0 not null, time_archived integer)',
	);
	const add = db.prepare(
		'insert into session (id, parent_id, directory, title, time_created, time_updated, agent, model, summary_files, time_archived) values (?,?,?,?,?,?,?,?,?,?)',
	);
	add.run(
		'ses_old',
		null,
		"/work/it's app",
		'Old one',
		1_790_000_000_000,
		1_790_000_100_000,
		'build',
		'{"id":"gpt-x","providerID":"9router"}',
		3,
		null,
	);
	add.run('ses_new', null, '/work/other', 'New one', 1_791_000_000_000, 1_791_000_100_000, 'plan', 'not json', 0, null);
	add.run('ses_sub', 'ses_new', '/work/other', 'Sub-agent run', 1_791_000_000_000, 1_791_000_200_000, 'build', null, 0, null);
	add.run('ses_arch', null, '/work/other', 'Archived', 1_791_000_000_000, 1_791_000_300_000, 'build', null, 0, 1_791_000_400_000);
	db.close();
}

test('OpenCode: newest first, sub-agent and archived sessions left out, resume command is shell-safe', () => {
	const file = path.join(tmp(), 'opencode.db');
	openCodeDb(file);
	const r = listOpenCode(file);
	expect(r.available).toBe(true);
	expect(r.sessions.map((s) => s.id)).toEqual(['ses_new', 'ses_old']);
	expect(r.hidden).toBe(1);
	const old = r.sessions[1]!;
	expect(old.facts).toEqual(['build', 'gpt-x', '3 files']);
	expect(old.resume).toBe("cd '/work/it'\\''s app' && opencode --session ses_old");
	expect(r.sessions[0]!.facts).toEqual(['plan']);
});

test('OpenCode: a missing or broken database is reported, never thrown', () => {
	const dir = tmp();
	expect(listOpenCode(path.join(dir, 'nope.db'))).toEqual({ available: false, sessions: [], hidden: 0 });
	const bad = path.join(dir, 'bad.db');
	fs.writeFileSync(bad, 'this is not sqlite at all, just text');
	const r = listOpenCode(bad);
	expect(r.available).toBe(false);
	expect(r.error).toBeTruthy();
});

test('OpenCode: the database file is not modified by listing', () => {
	const file = path.join(tmp(), 'opencode.db');
	openCodeDb(file);
	const before = fs.readFileSync(file);
	listOpenCode(file);
	expect(fs.readFileSync(file).equals(before)).toBe(true);
});

test('agy: empty conversations hidden, workspace taken from the first file:// URI, newest first', () => {
	const file = path.join(tmp(), 'conversation_summaries.db');
	const db = new Database(file);
	db.run(
		'create table conversation_summaries (conversation_id text primary key, title text not null default "", preview text not null default "", step_count integer not null default 0, last_modified_time datetime not null, workspace_uris text not null, parent_conversation_id text not null default "")',
	);
	const add = db.prepare('insert into conversation_summaries values (?,?,?,?,?,?,?)');
	add.run('a1', 'Zshrc review', 'Zshrc review', 20, '2026-10-13 03:57:58.052241+00:00', '["file:///Users/me/my%20app"]', '');
	add.run('a2', '', 'Only a preview', 4, '2026-10-12 03:00:00.000000+00:00', '[]', '');
	add.run('a3', '', '', 0, '0001-01-01 00:00:00+00:00', '["file:///x"]', '');
	add.run('a4', 'Child', '', 9, '2026-10-13 05:00:00.000000+00:00', '["file:///x"]', 'a1');
	db.close();
	const r = listAgy(file);
	expect(r.sessions.map((s) => s.id)).toEqual(['a1', 'a2']);
	expect(r.hidden).toBe(1);
	expect(r.sessions[0]).toMatchObject({ title: 'Zshrc review', project: '/Users/me/my app', facts: ['20 steps'] });
	expect(r.sessions[0]!.updatedAt).toBe('2026-10-13T03:57:58.052Z');
	expect(r.sessions[1]).toMatchObject({ title: 'Only a preview', project: '' });
});

test('default paths follow XDG_DATA_HOME for OpenCode', () => {
	expect(otherPaths('/h', undefined).opencodeDb).toBe('/h/.local/share/opencode/opencode.db');
	expect(otherPaths('/h', '/x').opencodeDb).toBe('/x/opencode/opencode.db');
	expect(otherPaths('/h').agyDb).toBe('/h/.gemini/antigravity-cli/conversation_summaries.db');
});

test('agy: a WAL-mode database without -wal/-shm files still opens, and no side files are created', () => {
	const dir = tmp();
	const file = path.join(dir, 'conversation_summaries.db');
	const db = new Database(file);
	db.run('pragma journal_mode = wal');
	db.run(
		'create table conversation_summaries (conversation_id text primary key, title text not null default "", preview text not null default "", step_count integer not null default 0, last_modified_time datetime not null, workspace_uris text not null, parent_conversation_id text not null default "")',
	);
	db.run('insert into conversation_summaries values ("w1", "In WAL", "", 2, "2026-10-13 03:00:00+00:00", "[]", "")');
	db.close();
	for (const ext of ['-wal', '-shm']) fs.rmSync(file + ext, { force: true });
	const r = listAgy(file);
	expect(r.sessions.map((s) => s.id)).toEqual(['w1']);
	expect(fs.readdirSync(dir)).toEqual(['conversation_summaries.db']);
});

test('OpenCode v2: session_v2 wins over the stale legacy table, and a missing title is shown as untitled', () => {
	const file = path.join(tmp(), 'opencode.db');
	const db = new Database(file);
	const cols =
		'(id text primary key, parent_id text, directory text not null, title text, time_created integer not null, time_updated integer not null, agent text, model text, summary_files integer, cost real default 0, time_archived integer)';
	db.run(`create table session ${cols}`);
	db.run(`create table session_v2 ${cols}`);
	db.run("insert into session values ('ses_legacy0001', null, '/a', 'Legacy only', 1, 10, null, null, null, 0, null)");
	db.run("insert into session_v2 values ('ses_legacy0001', null, '/a', 'Legacy only', 1, 10, null, null, null, 0, null)");
	db.run("insert into session_v2 values ('ses_newer00001', null, '/b', null, 1, 20, null, null, null, 0, null)"); // never reached the legacy table
	db.run("insert into session_v2 values ('ses_childof001', 'ses_newer00001', '/b', 'sub', 1, 30, null, null, null, 0, null)");
	db.run("insert into session_v2 values ('ses_grandkid01', 'ses_childof001', '/b', 'sub2', 1, 40, null, null, null, 0, null)");
	db.close();
	const r = listOpenCode(file);
	expect(r.sessions.map((s) => [s.id, s.title])).toEqual([
		['ses_newer00001', '(untitled)'],
		['ses_legacy0001', 'Legacy only'],
	]);
	expect(r.hidden).toBe(2);
	expect(openCodeFamily(file, 'ses_newer00001')).toEqual(['ses_newer00001', 'ses_childof001', 'ses_grandkid01']);
	expect(openCodeFamily(file, 'ses_missing0001')).toEqual([]); // an id that is not there has no family, not a family of one
});
