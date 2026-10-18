// Read-only lists of OpenCode and Antigravity (agy) sessions for the sessions UI. Both agents keep sessions in SQLite;
// we only open them with mode=ro and select a few columns (no message bodies, nothing is ever written or deleted here).
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quote } from './sessions-scan.ts';

export interface OtherSession {
	id: string;
	title: string;
	/** working directory the session ran in ('' when unknown) */
	project: string;
	updatedAt: string;
	createdAt?: string;
	/** short facts shown under the title, e.g. agent, model, steps */
	facts: string[];
	/** copyable command that reopens the session, when the agent has one */
	resume?: string;
}

export interface OtherList {
	available: boolean;
	sessions: OtherSession[];
	/** rows left out on purpose (sub-agent sessions, empty conversations) */
	hidden: number;
	error?: string;
}

export interface OtherPaths {
	opencodeDb: string;
	agyDb: string;
}

export const otherPaths = (home = os.homedir(), xdgData = process.env.XDG_DATA_HOME): OtherPaths => ({
	opencodeDb: path.join(xdgData || path.join(home, '.local', 'share'), 'opencode', 'opencode.db'),
	agyDb: path.join(home, '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
});

const iso = (ms: number) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '');

/**
 * Opens read-only; a file that does not exist is "not installed", anything else is reported but never thrown.
 * A WAL-mode database with no -wal/-shm files next to it cannot be opened with mode=ro (SQLite would have to create them),
 * so that case retries with immutable=1, which is safe because nothing is writing it then.
 */
function withDb(file: string, read: (db: Database) => Omit<OtherList, 'available'>): OtherList {
	if (!fs.existsSync(file)) return { available: false, sessions: [], hidden: 0 };
	let error = '';
	for (const flags of ['mode=ro', 'mode=ro&immutable=1']) {
		let db: Database | undefined;
		try {
			db = new Database(`file:${file}?${flags}`, { readonly: true });
			return { available: true, ...read(db) };
		} catch (err) {
			error = (err as Error).message;
		} finally {
			db?.close();
		}
	}
	return { available: false, sessions: [], hidden: 0, error };
}

interface OpenCodeRow {
	id: string;
	directory: string;
	title: string | null;
	time_created: number;
	time_updated: number;
	agent: string | null;
	model: string | null;
	summary_files: number | null;
	cost: number;
}

/** `model` is a JSON string like {"id":"x","providerID":"y"} */
const modelId = (raw: string | null) => {
	try {
		return raw ? String((JSON.parse(raw) as { id?: string }).id ?? '') : '';
	} catch {
		return '';
	}
};

/**
 * OpenCode v2 keeps its live sessions in `session_v2`; the older `session` table is a migrated copy that is no longer updated
 * (new sessions never reach it, and a delete leaves its row behind). Older installs only have `session`.
 */
const sessionTable = (db: Database) =>
	db.query("select 1 from sqlite_master where type = 'table' and name = 'session_v2'").get() ? 'session_v2' : 'session';

/** The session and every descendant (sub-agent sessions), parent first: what `opencode session delete` removes together. */
export function openCodeFamily(dbFile: string, id: string): string[] {
	let ids: string[] = [];
	const r = withDb(dbFile, (db) => {
		const t = sessionTable(db);
		ids = (
			db
				.query(
					`with recursive fam(id, depth) as (select id, 0 from ${t} where id = ? union all select s.id, fam.depth + 1 from ${t} s join fam on s.parent_id = fam.id) select id from fam order by depth`,
				)
				.all(id) as { id: string }[]
		).map((x) => x.id);
		return { sessions: [], hidden: 0 };
	});
	return r.available ? ids : [];
}

export function listOpenCode(dbFile: string): OtherList {
	return withDb(dbFile, (db) => {
		const t = sessionTable(db);
		const rows = db
			.query(
				`select id, directory, title, time_created, time_updated, agent, model, summary_files, cost from ${t} where parent_id is null and time_archived is null order by time_updated desc`,
			)
			.all() as OpenCodeRow[];
		const hidden = (db.query(`select count(*) c from ${t} where parent_id is not null`).get() as { c: number }).c;
		return {
			hidden,
			sessions: rows.map((r) => ({
				id: r.id,
				title: r.title || '(untitled)',
				project: r.directory,
				updatedAt: iso(r.time_updated),
				createdAt: iso(r.time_created),
				facts: [r.agent, modelId(r.model), r.summary_files ? `${r.summary_files} files` : ''].filter((x): x is string => !!x),
				resume: `cd ${quote(r.directory)} && opencode --session ${r.id}`,
			})),
		};
	});
}

interface AgyRow {
	conversation_id: string;
	title: string;
	preview: string;
	step_count: number;
	last_modified_time: string;
	workspace_uris: string;
}

/** workspace_uris is a JSON array of file:// URIs; the first one is the project */
const workspaceOf = (raw: string) => {
	try {
		const first = (JSON.parse(raw) as string[])[0];
		return first?.startsWith('file://') ? decodeURIComponent(new URL(first).pathname) : '';
	} catch {
		return '';
	}
};

export function listAgy(dbFile: string): OtherList {
	return withDb(dbFile, (db) => {
		const rows = db
			.query(
				'select conversation_id, title, preview, step_count, last_modified_time, workspace_uris from conversation_summaries where parent_conversation_id = "" order by last_modified_time desc',
			)
			.all() as AgyRow[];
		// ponytail: a conversation with no steps was opened but never used; hide it instead of listing a blank row
		const used = rows.filter((r) => r.step_count > 0);
		return {
			hidden: rows.length - used.length,
			sessions: used.map((r) => ({
				id: r.conversation_id,
				title: r.title || r.preview || '(untitled)',
				project: workspaceOf(r.workspace_uris),
				updatedAt: iso(Date.parse(r.last_modified_time)),
				facts: [`${r.step_count} steps`],
			})),
		};
	});
}

export const listOthers = (paths: OtherPaths) => ({
	opencode: listOpenCode(paths.opencodeDb),
	antigravity: listAgy(paths.agyDb),
});
