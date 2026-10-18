// Changes to Claude sessions (delete/restore/purge, rename, tags), each gated by approval in the server's terminal.
// The HTTP side can only create() pending actions; the only path to execution is the injected `prompt` (a y/N on stdin).
// ~/.claude is written to only by an approved delete (a move into the trash) or restore (a move back). Transcripts are never edited.
// OpenCode sessions can also be deleted (backup first, then OpenCode's own CLI) and restored from that backup; Antigravity ones only get
// a name and tags. Names and tags of every agent live in the sidecar, never in the agent's own files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { findOpenCode, realOpenCode, type OpenCodeCli } from './opencode-cli.ts';
import { listAgy, listOpenCode, openCodeFamily, otherPaths, type OtherPaths } from './sessions-other.ts';
import { quote, SESSION_ID, liveSessionIds, type Meta, type Roots } from './sessions-scan.ts';
import type { SupermemoryClient } from './supermemory-client.ts';

const TRASH_ID = /^\d+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENCODE_ID = /^ses_[A-Za-z0-9]{8,64}$/;
const OPENCODE_TRASH_ID = /^\d+_ses_[A-Za-z0-9]{8,64}$/;
const TTL_MS = 5 * 60_000;
const MAX_NAME = 100;
const MAX_TAGS = 20;
const MAX_TAG = 40;

export class ActionError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

export type Agent = 'claude' | 'opencode' | 'antigravity';

/** `agent` defaults to 'claude'. delete/restore/purge exist for claude and opencode; rename/tags for all three. */
export type ActionRequest =
	| { kind: 'delete'; sessionId: string; agent?: 'claude' | 'opencode'; deleteMemories?: boolean }
	| { kind: 'restore' | 'purge'; trashId: string; agent?: 'claude' | 'opencode' }
	| { kind: 'rename'; sessionId: string; name: string; agent?: Agent }
	| { kind: 'tags'; sessionId: string; tags: string[]; agent?: Agent };

export type Status = 'pending' | 'approved' | 'rejected' | 'expired' | 'done' | 'failed';

export interface Action {
	id: string;
	kind: ActionRequest['kind'];
	target: string;
	summary: string;
	status: Status;
	createdAt: number;
	expiresAt: number;
	result?: unknown;
	error?: string;
}

export interface Deps {
	roots: Roots;
	/** repo data/ directory: holds sessions-trash/, sessions-meta.json, sessions-ui.log */
	dataDir: string;
	/** asks the human; true = approved. In production a y/N on the terminal running the server. */
	prompt: (summary: string) => Promise<boolean>;
	isLive?: (sessionId: string) => boolean;
	/** short human label for prompts and the trash manifest */
	describe?: (sessionId: string) => string;
	/** ids of the supermemory notes written by a session (used only when a delete asks for them) */
	memoryIds?: (sessionId: string) => Promise<string[]>;
	client?: Pick<SupermemoryClient, 'request'>;
	now?: () => number;
	/** OpenCode and agy databases, read to check that an id exists (the real ones by default) */
	others?: OtherPaths;
	/** the OpenCode CLI used to delete and restore; the real binary found on PATH by default */
	opencode?: OpenCodeCli;
}

interface Item {
	name: string;
	from: string;
}
interface Manifest {
	id: string;
	deletedAt: string;
	label: string;
	items: Item[];
}

const exists = (p: string) => fs.existsSync(p);
const trashRoot = (dataDir: string) => path.join(dataDir, 'sessions-trash');
const short = (id: string) => id.slice(0, 8);

function move(from: string, to: string) {
	try {
		fs.renameSync(from, to);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
		fs.cpSync(from, to, { recursive: true, errorOnExist: true });
		fs.rmSync(from, { recursive: true });
	}
}

function dirSize(p: string): number {
	try {
		const st = fs.statSync(p);
		if (!st.isDirectory()) return st.size;
		return fs.readdirSync(p).reduce((n, f) => n + dirSize(path.join(p, f)), 0);
	} catch {
		return 0;
	}
}

// ---- sidecar (name/tags) ------------------------------------------------------------------------------------------

export const metaFile = (dataDir: string) => path.join(dataDir, 'sessions-meta.json');

export function readMeta(dataDir: string): Meta {
	try {
		return JSON.parse(fs.readFileSync(metaFile(dataDir), 'utf-8'));
	} catch {
		return {};
	}
}

function writeMeta(dataDir: string, meta: Meta) {
	fs.mkdirSync(dataDir, { recursive: true });
	const tmp = `${metaFile(dataDir)}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
	fs.renameSync(tmp, metaFile(dataDir)); // atomic: a crash never leaves half a file
}

/** Claude keys stay the bare session id (older sidecars); the other agents are prefixed so ids can never collide. */
export const metaKey = (agent: Agent, id: string) => (agent === 'claude' ? id : `${agent}:${id}`);

// ---- trash --------------------------------------------------------------------------------------------------------

export function findTranscript(roots: Roots, sessionId: string): string | undefined {
	if (!SESSION_ID.test(sessionId)) return undefined;
	try {
		for (const slug of fs.readdirSync(roots.projectsDir)) {
			const file = path.join(roots.projectsDir, slug, `${sessionId}.jsonl`);
			if (exists(file)) return file;
		}
	} catch {}
	return undefined;
}

function sessionItems(roots: Roots, sessionId: string): Item[] {
	const transcript = findTranscript(roots, sessionId);
	if (!transcript) throw new ActionError('session not found', 404);
	const items: Item[] = [{ name: 'transcript.jsonl', from: transcript }];
	const folder = transcript.slice(0, -'.jsonl'.length);
	const history = path.join(roots.fileHistoryDir, sessionId);
	if (exists(folder)) items.push({ name: 'session-dir', from: folder });
	if (exists(history)) items.push({ name: 'file-history', from: history });
	return items;
}

export interface TrashEntry extends Manifest {
	trashId: string;
	size: number;
}

export function listTrash(dataDir: string): TrashEntry[] {
	const root = trashRoot(dataDir);
	let names: string[] = [];
	try {
		names = fs.readdirSync(root).filter((n) => TRASH_ID.test(n));
	} catch {}
	const out: TrashEntry[] = [];
	for (const trashId of names) {
		try {
			const m: Manifest = JSON.parse(fs.readFileSync(path.join(root, trashId, 'manifest.json'), 'utf-8'));
			out.push({ ...m, trashId, size: dirSize(path.join(root, trashId)) });
		} catch {} // folder without a readable manifest is left alone
	}
	return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

// OpenCode backups: one JSON file per delete holding the export of the session and all its sub-agent sessions
interface OpenCodeExport {
	info: { id: string; location?: { directory?: string } };
	messages: unknown[];
}
interface OpenCodeBackup {
	version: 1;
	id: string;
	label: string;
	deletedAt: string;
	exports: OpenCodeExport[];
}

const openCodeTrashRoot = (dataDir: string) => path.join(dataDir, 'opencode-trash');
function openCodeBackupFile(dataDir: string, trashId: string): string {
	if (!OPENCODE_TRASH_ID.test(trashId)) throw new ActionError('invalid trash id');
	const file = path.join(openCodeTrashRoot(dataDir), `${trashId}.json`);
	if (!exists(file)) throw new ActionError('not in trash', 404);
	return file;
}

function readBackup(file: string): OpenCodeBackup {
	const b = JSON.parse(fs.readFileSync(file, 'utf-8')) as OpenCodeBackup;
	if (b.version !== 1 || !Array.isArray(b.exports) || !b.exports.length)
		throw new ActionError('backup file is not readable', 500);
	return b;
}

// ponytail: parses each whole backup just to list it; add a small sidecar if the trash ever holds many large backups
export function listOpenCodeTrash(dataDir: string): (TrashEntry & { agent: 'opencode' })[] {
	const root = openCodeTrashRoot(dataDir);
	let names: string[] = [];
	try {
		names = fs.readdirSync(root).filter((n) => n.endsWith('.json') && OPENCODE_TRASH_ID.test(n.slice(0, -'.json'.length)));
	} catch {}
	const out: (TrashEntry & { agent: 'opencode' })[] = [];
	for (const n of names) {
		try {
			const file = path.join(root, n);
			const b = readBackup(file);
			out.push({
				id: b.id,
				deletedAt: b.deletedAt,
				label: b.label,
				items: [],
				trashId: n.slice(0, -'.json'.length),
				size: fs.statSync(file).size,
				agent: 'opencode',
			});
		} catch {} // unreadable file is left alone
	}
	return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

function parseExport(text: string, id: string): OpenCodeExport {
	let j: OpenCodeExport | undefined;
	try {
		j = JSON.parse(text);
	} catch {}
	if (!j || j.info?.id !== id || !Array.isArray(j.messages))
		throw new ActionError(`OpenCode export of ${id} was not usable; nothing deleted`, 500);
	return j;
}

function trashDir(dataDir: string, trashId: string): string {
	if (!TRASH_ID.test(trashId)) throw new ActionError('invalid trash id');
	const dir = path.join(trashRoot(dataDir), trashId);
	if (!exists(dir)) throw new ActionError('not in trash', 404);
	return dir;
}

// ---- shell commands (shown, never run) -----------------------------------------------------------------------------

export function resumeCommand(cwd: string, sessionId: string): string {
	if (!SESSION_ID.test(sessionId)) throw new ActionError('invalid session id');
	return `cd ${quote(cwd)} && claude --resume ${sessionId}`;
}

export const newSessionCommand = (cwd: string) => `cd ${quote(cwd)} && claude`;

// ---- actions ------------------------------------------------------------------------------------------------------

type Rec = Action & { req: ActionRequest };

export class SessionActions {
	private actions = new Map<string, Rec>();
	private queue: Rec[] = [];
	private pumping: Promise<void> = Promise.resolve();
	private running = false;

	constructor(private deps: Deps) {}

	private now = () => (this.deps.now ?? Date.now)();
	private isLive = (id: string) => (this.deps.isLive ?? ((s: string) => liveSessionIds(this.deps.roots.sessionsDir).has(s)))(id);
	private label = (id: string) => this.deps.describe?.(id) ?? short(id);
	private paths = () => this.deps.others ?? otherPaths();
	private cli?: OpenCodeCli;

	private openCode(): OpenCodeCli {
		if (this.deps.opencode) return this.deps.opencode;
		if (!this.cli) {
			const bin = findOpenCode();
			if (!bin) throw new ActionError('the opencode command was not found on PATH (set OPENCODE_BIN)', 503);
			this.cli = realOpenCode(bin);
		}
		return this.cli;
	}

	private assertOpenCodeIdle() {
		if (this.openCode().running()) throw new ActionError('OpenCode is running; close every OpenCode window first', 409);
	}

	/** Existing OpenCode / agy session by id (also validates the id's shape), or an ActionError */
	private otherSession(agent: 'opencode' | 'antigravity', id: string) {
		const ok = agent === 'opencode' ? OPENCODE_ID.test(id) : SESSION_ID.test(id);
		if (!ok) throw new ActionError('invalid session id');
		const list = agent === 'opencode' ? listOpenCode(this.paths().opencodeDb) : listAgy(this.paths().agyDb);
		if (!list.available) throw new ActionError(`${agent} data is not available`, 503);
		const found = list.sessions.find((s) => s.id === id);
		if (!found) throw new ActionError('session not found', 404);
		return found;
	}

	private agentOf(req: { agent?: string }, allowed: Agent[]): Agent {
		const agent = (req.agent ?? 'claude') as Agent;
		if (!allowed.includes(agent)) throw new ActionError(`not supported for ${String(req.agent)}`);
		return agent;
	}

	/** Records a pending action and queues it for terminal approval. Changes nothing yet. */
	create(req: ActionRequest): Action {
		const { target, summary } = this.validate(req);
		const now = this.now();
		const rec: Rec = {
			id: crypto.randomUUID(),
			kind: req.kind,
			target,
			summary,
			status: 'pending',
			createdAt: now,
			expiresAt: now + TTL_MS,
			req,
		};
		this.actions.set(rec.id, rec);
		this.queue.push(rec);
		this.pump();
		return this.view(rec);
	}

	get(id: string): Action | undefined {
		const rec = this.actions.get(id);
		return rec && this.view(rec);
	}

	list(): Action[] {
		return [...this.actions.values()].map((r) => this.view(r)).sort((a, b) => b.createdAt - a.createdAt);
	}

	/** Resolves when the queue is empty (tests) */
	idle(): Promise<void> {
		return this.pumping;
	}

	private view({ req: _req, ...a }: Rec): Action {
		return a.status === 'pending' && this.now() >= a.expiresAt ? { ...a, status: 'expired' } : { ...a };
	}

	private validate(req: ActionRequest): { target: string; summary: string } {
		switch (req.kind) {
			case 'delete': {
				if (this.agentOf(req, ['claude', 'opencode']) === 'opencode') {
					if (req.deleteMemories) throw new ActionError('supermemory notes are not linked to OpenCode sessions');
					const s = this.otherSession('opencode', req.sessionId);
					this.assertOpenCodeIdle();
					return {
						target: req.sessionId,
						summary: `DELETE OpenCode session ${req.sessionId} "${s.title}" and its sub-agent sessions (a backup is kept in data/opencode-trash and can be restored)`,
					};
				}
				if (!SESSION_ID.test(req.sessionId)) throw new ActionError('invalid session id');
				if (!findTranscript(this.deps.roots, req.sessionId)) throw new ActionError('session not found', 404);
				if (this.isLive(req.sessionId)) throw new ActionError('session is running; close it first', 409);
				const extra = req.deleteMemories ? ' AND its supermemory notes' : '';
				return {
					target: req.sessionId,
					summary: `DELETE session ${short(req.sessionId)} ${this.label(req.sessionId)} (moved to trash)${extra}`,
				};
			}
			case 'restore':
			case 'purge':
				if (this.agentOf(req, ['claude', 'opencode']) === 'opencode') {
					const b = readBackup(openCodeBackupFile(this.deps.dataDir, req.trashId));
					if (req.kind === 'restore') this.assertOpenCodeIdle();
					return {
						target: req.trashId,
						summary:
							req.kind === 'purge'
								? `PURGE OpenCode backup ${req.trashId} "${b.label}" (permanent, cannot be undone)`
								: `RESTORE OpenCode session ${b.id} "${b.label}" (${b.exports.length} session(s)) into OpenCode`,
					};
				}
				trashDir(this.deps.dataDir, req.trashId);
				return {
					target: req.trashId,
					summary:
						req.kind === 'purge' ? `PURGE ${req.trashId} (permanent, cannot be undone)` : `RESTORE ${req.trashId} to ~/.claude`,
				};
			case 'rename': {
				this.checkSessionId(req);
				if (typeof req.name !== 'string' || req.name.length > MAX_NAME)
					throw new ActionError(`name must be at most ${MAX_NAME} characters`);
				return {
					target: req.sessionId,
					summary: `RENAME ${this.agentTag(req)}session ${short(req.sessionId)} to "${req.name.trim()}"`,
				};
			}
			case 'tags': {
				this.checkSessionId(req);
				if (
					!Array.isArray(req.tags) ||
					req.tags.length > MAX_TAGS ||
					req.tags.some((t) => typeof t !== 'string' || t.length > MAX_TAG)
				)
					throw new ActionError(`at most ${MAX_TAGS} tags of ${MAX_TAG} characters`);
				return {
					target: req.sessionId,
					summary: `TAGS for ${this.agentTag(req)}session ${short(req.sessionId)}: ${req.tags.join(', ') || '(none)'}`,
				};
			}
			default:
				throw new ActionError('unknown action');
		}
	}

	private agentTag = (req: { agent?: Agent }) => (req.agent && req.agent !== 'claude' ? `${req.agent} ` : '');

	/** rename/tags: Claude ids are only shape-checked (as before); OpenCode and agy ids must exist */
	private checkSessionId(req: { agent?: Agent; sessionId: string }) {
		const agent = this.agentOf(req, ['claude', 'opencode', 'antigravity']);
		if (agent === 'claude') {
			if (!SESSION_ID.test(req.sessionId)) throw new ActionError('invalid session id');
		} else this.otherSession(agent, req.sessionId);
	}

	private pump() {
		if (this.running) return;
		this.running = true;
		this.pumping = (async () => {
			try {
				for (let rec = this.queue.shift(); rec; rec = this.queue.shift()) await this.process(rec);
			} finally {
				this.running = false;
			}
		})();
	}

	private async process(rec: Rec) {
		if (this.view(rec).status === 'expired') return this.finish(rec, 'expired');
		let ok = false;
		try {
			ok = await this.deps.prompt(rec.summary);
		} catch {}
		if (this.view(rec).status === 'expired') return this.finish(rec, 'expired'); // answered too late: ignored
		if (!ok) return this.finish(rec, 'rejected');
		rec.status = 'approved';
		try {
			rec.result = await this.execute(rec.req);
			this.finish(rec, 'done');
		} catch (err) {
			rec.error = (err as Error).message;
			this.finish(rec, 'failed');
		}
	}

	private finish(rec: Rec, status: Status) {
		rec.status = status;
		try {
			fs.mkdirSync(this.deps.dataDir, { recursive: true });
			const line = {
				at: new Date(this.now()).toISOString(),
				kind: rec.kind,
				target: rec.target,
				status,
				error: rec.error,
				result: rec.result,
			};
			fs.appendFileSync(path.join(this.deps.dataDir, 'sessions-ui.log'), `${JSON.stringify(line)}\n`);
		} catch {}
	}

	private async execute(req: ActionRequest): Promise<unknown> {
		const { dataDir } = this.deps;
		switch (req.kind) {
			case 'delete':
				return req.agent === 'opencode'
					? this.openCodeDelete(req.sessionId)
					: this.softDelete(req.sessionId, !!req.deleteMemories);
			case 'restore': {
				if (req.agent === 'opencode') return this.openCodeRestore(req.trashId);
				const dir = trashDir(dataDir, req.trashId);
				const m: Manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
				const taken = m.items.filter((i) => exists(i.from));
				if (taken.length) throw new ActionError(`not restored, already exists: ${taken.map((i) => i.from).join(', ')}`, 409);
				for (const i of m.items) {
					fs.mkdirSync(path.dirname(i.from), { recursive: true });
					move(path.join(dir, i.name), i.from);
				}
				fs.rmSync(dir, { recursive: true });
				return { restored: m.items.map((i) => i.from) };
			}
			case 'purge':
				if (req.agent === 'opencode') fs.rmSync(openCodeBackupFile(dataDir, req.trashId));
				else fs.rmSync(trashDir(dataDir, req.trashId), { recursive: true });
				return { purged: req.trashId };
			case 'rename':
			case 'tags': {
				const key = metaKey(req.agent ?? 'claude', req.sessionId);
				const meta = readMeta(dataDir);
				const cur = (meta[key] ??= {});
				if (req.kind === 'rename') cur.name = req.name.trim() || undefined;
				else cur.tags = [...new Set(req.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
				if (!cur.name && !cur.tags?.length) delete meta[key];
				writeMeta(dataDir, meta);
				return meta[key] ?? {};
			}
		}
	}

	/**
	 * Backup first, then OpenCode's own `session delete`. The backup holds the export of the session and every sub-agent session
	 * (the CLI deletes those too) and is written and re-read before anything is deleted, so a failure at any step loses nothing.
	 */
	private async openCodeDelete(id: string) {
		const { dataDir } = this.deps;
		const { opencodeDb } = this.paths();
		const cli = this.openCode();
		if (cli.running()) throw new ActionError('OpenCode started running; nothing deleted', 409); // re-check right before the change
		const listed = this.otherSession('opencode', id);
		const family = openCodeFamily(opencodeDb, id);
		if (family[0] !== id) throw new ActionError('could not read the session tree; nothing deleted', 500);
		const exports: OpenCodeExport[] = [];
		for (const sid of family) exports.push(parseExport(await cli.exportSession(sid), sid));

		const trashId = `${this.now()}_${id}`;
		const root = openCodeTrashRoot(dataDir);
		fs.mkdirSync(root, { recursive: true, mode: 0o700 });
		const file = path.join(root, `${trashId}.json`);
		const backup: OpenCodeBackup = {
			version: 1,
			id,
			label: listed.title,
			deletedAt: new Date(this.now()).toISOString(),
			exports,
		};
		fs.writeFileSync(file, JSON.stringify(backup), { flag: 'wx', mode: 0o600 }); // transcripts inside: owner only
		if (readBackup(file).exports.length !== family.length) {
			fs.rmSync(file, { force: true });
			throw new ActionError('backup could not be verified; nothing deleted', 500);
		}

		let cliError = '';
		try {
			await cli.deleteSession(id);
		} catch (err) {
			cliError = (err as Error).message;
		}
		// the backup is kept whatever happens below: with it nothing can be lost, and a surplus one is purged in the UI
		const after = listOpenCode(opencodeDb);
		if (!after.available) throw new ActionError(`could not confirm the delete; backup kept as ${trashId}`, 500);
		if (after.sessions.some((s) => s.id === id))
			throw new ActionError(`OpenCode still lists the session${cliError ? `: ${cliError}` : ''}; backup kept as ${trashId}`, 500);
		return { trashId, sessions: family.length };
	}

	/** Re-imports the backup (parent first). Only the sessions still missing are imported, so a half-finished restore can be retried. */
	private async openCodeRestore(trashId: string) {
		const { dataDir } = this.deps;
		const { opencodeDb } = this.paths();
		const file = openCodeBackupFile(dataDir, trashId);
		const backup = readBackup(file);
		const cli = this.openCode();
		if (cli.running()) throw new ActionError('OpenCode is running; close every OpenCode window first', 409);
		const have = new Set(openCodeFamily(opencodeDb, backup.id));
		const missing = backup.exports.filter((e) => !have.has(e.info.id));
		if (!missing.length) throw new ActionError('this session already exists in OpenCode; nothing restored', 409);

		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-restore-'));
		try {
			for (const [i, e] of missing.entries()) {
				const part = path.join(tmp, `${i}.json`);
				fs.writeFileSync(part, JSON.stringify(e), { mode: 0o600 });
				await cli.importSession(part, e.info.location?.directory ?? process.cwd());
			}
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
		if (openCodeFamily(opencodeDb, backup.id).length < backup.exports.length)
			throw new ActionError('OpenCode did not take every session; the backup was kept, retry the restore', 500);
		fs.rmSync(file);
		return { restored: backup.id, sessions: missing.length };
	}

	private async softDelete(sessionId: string, withMemories: boolean) {
		const { roots, dataDir } = this.deps;
		if (this.isLive(sessionId)) throw new ActionError('session started running; nothing moved', 409); // re-check right before the move
		const items = sessionItems(roots, sessionId);
		const trashId = `${this.now()}_${sessionId}`;
		const dir = path.join(trashRoot(dataDir), trashId);
		fs.mkdirSync(dir, { recursive: true });
		const manifest: Manifest = {
			id: sessionId,
			deletedAt: new Date(this.now()).toISOString(),
			label: this.label(sessionId),
			items,
		};
		fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2)); // before the moves: a crash stays restorable
		const moved: Item[] = [];
		try {
			for (const i of items) {
				move(i.from, path.join(dir, i.name));
				moved.push(i);
			}
		} catch (err) {
			for (const i of moved.reverse()) {
				try {
					move(path.join(dir, i.name), i.from);
				} catch {}
			}
			fs.rmSync(dir, { recursive: true, force: true });
			throw err;
		}
		const result: { trashId: string; memories?: { deleted: number; failed: { id: string; error: string }[] } } = { trashId };
		if (withMemories) {
			const memories = { deleted: 0, failed: [] as { id: string; error: string }[] };
			for (const id of (await this.deps.memoryIds?.(sessionId)) ?? []) {
				const res = await this.deps.client?.request('DELETE', `/v3/documents/${encodeURIComponent(id)}`);
				if (res?.success) memories.deleted++;
				else memories.failed.push({ id, error: res?.error ?? 'no memory client' });
			}
			result.memories = memories;
		}
		return result;
	}
}

/** y/N on the terminal running the server. Anything but y/yes (including stdin closing) is a no. */
export function terminalPrompt(): (summary: string) => Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	let closed = false;
	rl.on('close', () => (closed = true));
	return (summary) =>
		closed
			? Promise.resolve(false)
			: new Promise((resolve) => {
					rl.once('close', () => resolve(false));
					rl.question(`\n? Approval needed: ${summary}\n  Approve? [y/N] `, (a) => resolve(/^y(es)?$/i.test(a.trim())));
				});
}
