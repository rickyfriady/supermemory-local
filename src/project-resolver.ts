// Project Resolver: maps a directory to the project memory (container tag) shared by every agent.
//
// Identity: the repository root's legacy tag `proj_<name>_<sha256(realpath)[:6]>` stays the tag of every repository, so
// stored memories never move (the memory server cannot re-tag documents). Clones of one `origin` remote are linked through
// a small registry (<dataDir>/projects.json): they write to one tag and read each clone's own earlier tag too.
// Folders that only hold repositories ("workspace containers"), $HOME and ignored folders have no project at all.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentConfig } from './config.ts';

export interface Project {
	projectName: string;
	sanitizedName: string;
	rootDir: string;
	/** The one tag everything is written to */
	containerTag: string;
	/** Every tag to read from: containerTag first, then the tags of other clones of the same remote */
	readTags: string[];
}

export interface ResolveOptions {
	dataDir?: string;
	ignore?: RegExp | null;
	home?: string;
}

/** `proj_<name>_<hash>`: the tag a repository (or plain folder) has always had */
export function legacyTag(rootDir: string): string {
	const name = path.basename(rootDir) || 'default-project';
	const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
	const hash = crypto.createHash('sha256').update(rootDir).digest('hex').slice(0, 6);
	return `proj_${sanitized}_${hash}`;
}

/**
 * Same string for every spelling of one remote: https://u:t@Repo.X/a/b.git, ssh://git@repo.x:22/a/b and git@repo.x:a/b.git
 * all give "repo.x/a/b". Returns null for an empty or unparseable URL.
 */
export function normalizeRemote(url: string): string | null {
	let s = url.trim();
	if (!s) return null;
	const scp = s.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/); // git@host:path
	if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `ssh://${scp[1]}/${scp[2]}`;
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		return null;
	}
	const repo = u.pathname
		.replace(/\/+$/, '')
		.replace(/\.git$/, '')
		.replace(/^\/+/, '');
	return repo ? `${u.hostname.toLowerCase()}/${repo}` : null;
}

// ---- registry: { "<normalized remote>": { tag, also: [tags of other clones] } }
export type Registry = Record<string, { tag: string; also: string[] }>;

export const registryFile = (dataDir: string) => path.join(dataDir, 'projects.json');

/** The registry, or {} when missing or unreadable: a broken file must only cost sharing, never a hook */
export function readRegistry(dataDir: string): Registry {
	try {
		const parsed = JSON.parse(fs.readFileSync(registryFile(dataDir), 'utf-8'));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function writeRegistry(dataDir: string, registry: Registry): boolean {
	try {
		fs.mkdirSync(dataDir, { recursive: true });
		const tmp = `${registryFile(dataDir)}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n');
		fs.renameSync(tmp, registryFile(dataDir));
		return true;
	} catch {
		return false;
	}
}

/**
 * Registers `tag` under `remote` (first clone seen becomes the write tag, later ones are added to `also`).
 * Returns the entry and whether the registry changed.
 */
export function link(registry: Registry, remote: string, tag: string): { entry: Registry[string]; changed: boolean } {
	const entry = registry[remote];
	if (!entry || typeof entry.tag !== 'string') {
		const fresh = { tag, also: [] };
		registry[remote] = fresh;
		return { entry: fresh, changed: true };
	}
	const also = Array.isArray(entry.also) ? entry.also : [];
	if (entry.tag === tag || also.includes(tag)) return { entry: { tag: entry.tag, also }, changed: false };
	entry.also = [...also, tag];
	return { entry, changed: true };
}

// ---- repositories and containers
function git(cwd: string, ...args: string[]): string | null {
	try {
		const r = Bun.spawnSync(['git', ...args], { cwd, stderr: 'ignore' });
		const out = r.stdout.toString().trim();
		return r.success && out ? out : null;
	} catch {
		return null;
	}
}

const SKIP_DIRS = new Set(['node_modules']);

/** Git repositories at depth one or two below `dir` (dot-directories and node_modules skipped), at most `limit` of them */
export function findRepos(dir: string, limit = 8): string[] {
	const found: string[] = [];
	const subdirs = (d: string) => {
		try {
			return fs
				.readdirSync(d, { withFileTypes: true })
				.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
				.map((e) => path.join(d, e.name))
				.sort();
		} catch {
			return [];
		}
	};
	for (const child of subdirs(dir)) {
		if (fs.existsSync(path.join(child, '.git'))) found.push(child);
		else for (const grand of subdirs(child)) if (fs.existsSync(path.join(grand, '.git'))) found.push(grand);
		if (found.length >= limit) break;
	}
	return found;
}

export interface NoProject {
	kind: 'ignored' | 'home' | 'repos';
	message: string;
}

/** Why `dir` has no project of its own (for the MCP error and the hooks' hint); null when it has one */
export function containerReason(dir: string, opts: ResolveOptions = {}): NoProject | null {
	const cfg = currentConfig();
	const ignore = opts.ignore === undefined ? cfg.ignore : opts.ignore;
	const home = opts.home ?? os.homedir();
	if (ignore?.test(dir)) return { kind: 'ignored', message: 'this directory is excluded by SUPERMEMORY_IGNORE' };
	const resolved = safeRealpath(dir);
	if (git(resolved, 'rev-parse', '--show-toplevel')) return null;
	if (resolved === home) return { kind: 'home', message: 'this is the home directory; memory is kept per repository' };
	const repos = findRepos(resolved);
	return repos.length
		? {
				kind: 'repos',
				message: `this folder holds several repositories (${repos.map((r) => path.basename(r)).join(', ')}); pass one of them`,
			}
		: null;
}

function safeRealpath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * Project for a directory or file path, or null when it has none (ignored, $HOME, or a folder that only holds repositories).
 */
export function resolveProject(candidateDir?: string, opts: ResolveOptions = {}): Project | null {
	const cfg = currentConfig();
	const dataDir = opts.dataDir ?? cfg.dataDir;
	const ignore = opts.ignore === undefined ? cfg.ignore : opts.ignore;
	const home = opts.home ?? os.homedir();

	let cwd = candidateDir || process.cwd();
	// If candidateDir is a file, use its directory
	try {
		if (fs.statSync(cwd).isFile()) cwd = path.dirname(cwd);
	} catch {}
	if (ignore?.test(cwd)) return null;

	const toplevel = git(cwd, 'rev-parse', '--show-toplevel');
	let rootDir = safeRealpath(toplevel && fs.existsSync(toplevel) ? toplevel : cwd);
	if (ignore?.test(rootDir)) return null;

	if (!toplevel) {
		// Not in a repository: $HOME and folders of repositories are containers, anything else is its own project
		if (rootDir === home || findRepos(rootDir, 1).length) return null;
	}

	const legacy = legacyTag(rootDir);
	let containerTag = legacy;
	let readTags = [legacy];
	const remote = toplevel ? normalizeRemote(git(rootDir, 'remote', 'get-url', 'origin') ?? '') : null;
	if (remote) {
		const registry = readRegistry(dataDir);
		const { entry, changed } = link(registry, remote, legacy);
		if (changed) writeRegistry(dataDir, registry);
		containerTag = entry.tag;
		readTags = [entry.tag, ...entry.also];
	}

	const projectName = path.basename(rootDir) || 'default-project';
	return {
		projectName,
		sanitizedName: projectName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase(),
		rootDir,
		containerTag,
		readTags,
	};
}
