// Read-only view of Claude Code sessions under ~/.claude: parse transcripts, detect live ones, link supermemory notes.
// Nothing here writes to ~/.claude, and transcript text never leaves the machine (only session ids go to the memory server).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProject } from './project-resolver.ts';
import type { DocumentSummary, SupermemoryClient } from './supermemory-client.ts';

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PROMPT_CHARS = 200;
const MEMORY_LIMIT = 100;

export interface Roots {
	projectsDir: string;
	sessionsDir: string;
	fileHistoryDir: string;
}

export const claudeRoots = (home = os.homedir()): Roots => ({
	projectsDir: path.join(home, '.claude', 'projects'),
	sessionsDir: path.join(home, '.claude', 'sessions'),
	fileHistoryDir: path.join(home, '.claude', 'file-history'),
});

/** What a transcript says about itself (no file-system facts) */
export interface Parsed {
	id: string;
	project: string;
	branch: string;
	version: string;
	startedAt: string;
	lastAt: string;
	title: string;
	firstPrompt: string;
	lastPrompt: string;
	prUrl: string;
	prNumber: number | null;
	costUSD: number | null;
	files: string[];
}

export interface SessionInfo extends Parsed {
	file: string;
	slug: string;
	size: number;
	mtimeMs: number;
	live: boolean;
}

export interface ProjectGroup {
	project: string;
	lastAt: string;
	sessions: SessionInfo[];
}

/** Sidecar data (name/tags), kept outside ~/.claude; see sessions-actions.ts */
export type Meta = Record<string, { name?: string; tags?: string[] }>;

/** POSIX single-quote a string for a shell command line we only display */
export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, PROMPT_CHARS);

/** Plain text of a user entry, or '' for tool results, meta entries and local-command noise */
function userText(entry: any): string {
	if (entry.isMeta || entry.isSidechain) return '';
	const content = entry.message?.content;
	const text =
		typeof content === 'string'
			? content
			: Array.isArray(content)
				? content
						.filter((c: any) => c?.type === 'text')
						.map((c: any) => c.text)
						.join(' ')
				: '';
	if (text.startsWith('<local-command')) return '';
	// slash commands are stored as <command-name>/x</command-name> ... <command-args>y</command-args>
	const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
	return cmd ? `${cmd[1]} ${text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? ''}` : text;
}

/**
 * Metadata from the JSONL text of one transcript. Tolerates unknown, missing and malformed lines:
 * a bad line costs that line, never the session.
 */
export function parseSession(text: string, id: string): Parsed {
	const out: Parsed = {
		id,
		project: '',
		branch: '',
		version: '',
		startedAt: '',
		lastAt: '',
		title: '',
		firstPrompt: '',
		lastPrompt: '',
		prUrl: '',
		prNumber: null,
		costUSD: null,
		files: [],
	};
	const files = new Set<string>();
	let lastPromptEntry = '';
	for (const line of text.split('\n')) {
		if (!line) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (!e || typeof e !== 'object') continue;
		if (typeof e.timestamp === 'string') {
			if (!out.startedAt || e.timestamp < out.startedAt) out.startedAt = e.timestamp;
			if (e.timestamp > out.lastAt) out.lastAt = e.timestamp;
		}
		switch (e.type) {
			case 'ai-title':
				if (typeof e.aiTitle === 'string' && e.aiTitle) out.title = e.aiTitle;
				break;
			case 'pr-link':
				out.prUrl = String(e.prUrl ?? '');
				out.prNumber = typeof e.prNumber === 'number' ? e.prNumber : null;
				break;
			case 'cost-state':
				if (typeof e.totalCostUSD === 'number') out.costUSD = e.totalCostUSD;
				break;
			case 'last-prompt':
				if (typeof e.lastPrompt === 'string') lastPromptEntry = e.lastPrompt;
				break;
			case 'user': {
				if (!out.project && typeof e.cwd === 'string' && !e.isSidechain) out.project = e.cwd;
				if (e.gitBranch && !e.isSidechain) out.branch = e.gitBranch;
				if (e.version && !out.version) out.version = e.version;
				const t = userText(e);
				if (t) {
					if (!out.firstPrompt) out.firstPrompt = clip(t);
					out.lastPrompt = clip(t);
				}
				break;
			}
			case 'assistant':
				for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
					if (b?.type !== 'tool_use' || !WRITE_TOOLS.has(b.name)) continue;
					const p = b.input?.file_path ?? b.input?.notebook_path;
					if (typeof p === 'string' && p) files.add(p);
				}
				break;
		}
	}
	if (!out.lastPrompt && lastPromptEntry) out.lastPrompt = clip(lastPromptEntry);
	out.files = [...files];
	return out;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
	}
}

/**
 * Session ids with a running Claude Code process, from ~/.claude/sessions/<pid>.json.
 * ponytail: pid reuse can show a stale session as live; that only blocks a delete, never allows one
 */
export function liveSessionIds(sessionsDir: string, isAlive: (pid: number) => boolean = pidAlive): Set<string> {
	const live = new Set<string>();
	let names: string[] = [];
	try {
		names = fs.readdirSync(sessionsDir).filter((n) => n.endsWith('.json'));
	} catch {}
	for (const name of names) {
		try {
			const rec = JSON.parse(fs.readFileSync(path.join(sessionsDir, name), 'utf-8'));
			if (typeof rec.sessionId === 'string' && Number.isInteger(rec.pid) && isAlive(rec.pid)) live.add(rec.sessionId);
		} catch {}
	}
	return live;
}

export type Cache = Map<string, { mtimeMs: number; size: number; parsed: Parsed }>;
const readText = (file: string) => fs.readFileSync(file, 'utf-8');

/**
 * All sessions grouped by project, newest activity first. Parsed sessions are cached by mtime and size, so only
 * changed transcripts are read again. ponytail: in-memory cache, add a SQLite index if the first load is slow
 */
export function buildCatalog(roots: Roots, cache: Cache = new Map(), read: (file: string) => string = readText): ProjectGroup[] {
	const live = liveSessionIds(roots.sessionsDir);
	const groups = new Map<string, ProjectGroup>();
	let slugs: string[] = [];
	try {
		slugs = fs.readdirSync(roots.projectsDir);
	} catch {}
	for (const slug of slugs) {
		let names: string[] = [];
		try {
			names = fs.readdirSync(path.join(roots.projectsDir, slug)).filter((n) => n.endsWith('.jsonl'));
		} catch {}
		for (const name of names) {
			const id = name.slice(0, -'.jsonl'.length);
			if (!SESSION_ID.test(id)) continue;
			const file = path.join(roots.projectsDir, slug, name);
			try {
				const st = fs.statSync(file);
				let hit = cache.get(file);
				if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
					hit = { mtimeMs: st.mtimeMs, size: st.size, parsed: parseSession(read(file), id) };
					cache.set(file, hit);
				}
				const p = hit.parsed;
				const info: SessionInfo = {
					...p,
					project: p.project || slug,
					lastAt: p.lastAt || new Date(st.mtimeMs).toISOString(),
					title: p.title || p.firstPrompt || id.slice(0, 8),
					file,
					slug,
					size: st.size,
					mtimeMs: st.mtimeMs,
					live: live.has(id),
				};
				const g = groups.get(info.project) ?? { project: info.project, lastAt: '', sessions: [] };
				g.sessions.push(info);
				if (info.lastAt > g.lastAt) g.lastAt = info.lastAt;
				groups.set(info.project, g);
			} catch {} // unreadable file: skip it, keep the rest
		}
	}
	for (const g of groups.values()) g.sessions.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
	return [...groups.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export interface Filter {
	q?: string; // matches title, prompts, file paths, custom name, tags
	project?: string;
	live?: boolean;
	sort?: 'recent' | 'size';
}

/** Search, filter and sort; empty groups are dropped */
export function filterCatalog(groups: ProjectGroup[], f: Filter, meta: Meta = {}): ProjectGroup[] {
	const q = f.q?.trim().toLowerCase();
	const hay = (s: SessionInfo) => {
		const m = meta[s.id];
		return [s.title, s.firstPrompt, s.lastPrompt, ...s.files, m?.name ?? '', ...(m?.tags ?? [])].join('\n').toLowerCase();
	};
	return groups
		.filter((g) => !f.project || g.project === f.project)
		.map((g) => {
			const sessions = g.sessions
				.filter((s) => (!q || hay(s).includes(q)) && (f.live === undefined || s.live === f.live))
				.sort((a, b) => (f.sort === 'size' ? b.size - a.size : b.lastAt.localeCompare(a.lastAt)));
			return { ...g, sessions };
		})
		.filter((g) => g.sessions.length > 0);
}

export interface MemoryRef {
	id: string;
	type: string;
	createdAt: string;
}

export interface MemoryLinks {
	available: boolean;
	/** a project's listing was full, so older notes may be missing */
	incomplete: boolean;
	bySession: Record<string, MemoryRef[]>;
}

type MemoryClient = Pick<SupermemoryClient, 'isHealthy' | 'listDocuments' | 'getDocument'>;

/**
 * Notes per session id, from one listing per project (hooks tag every note with metadata.session).
 * Only container tags and a limit are sent; a down server gives { available: false } and the catalog still loads.
 */
export async function linkMemories(groups: ProjectGroup[], client: MemoryClient): Promise<MemoryLinks> {
	const links: MemoryLinks = { available: false, incomplete: false, bySession: {} };
	if (!(await client.isHealthy())) return links;
	links.available = true;
	const tags = new Map<string, string>(); // containerTag -> project
	for (const g of groups) tags.set(resolveProject(g.project).containerTag, g.project);
	await Promise.all(
		[...tags.keys()].map(async (tag) => {
			const docs: DocumentSummary[] = await client.listDocuments({ containerTags: [tag], limit: MEMORY_LIMIT });
			if (docs.length >= MEMORY_LIMIT) links.incomplete = true;
			for (const d of docs) {
				const session = d.metadata?.session;
				if (typeof session !== 'string') continue;
				(links.bySession[session] ??= []).push({ id: d.id, type: String(d.metadata?.type ?? ''), createdAt: d.createdAt });
			}
		}),
	);
	return links;
}

/** Short excerpts for a session's notes, fetched only when the session is opened */
export async function memoryExcerpts(client: MemoryClient, refs: MemoryRef[], chars = 300) {
	return Promise.all(
		refs.map(async (r) => {
			const doc = await client.getDocument(r.id);
			const text = (doc?.content ?? '').replace(/\s+/g, ' ').trim();
			return { ...r, excerpt: text.length > chars ? `${text.slice(0, chars)}…` : text };
		}),
	);
}
