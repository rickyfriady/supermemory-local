import { afterAll, beforeAll, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	containerReason,
	findRepos,
	legacyTag,
	link,
	normalizeRemote,
	readRegistry,
	registryFile,
	resolveProject,
} from './project-resolver.ts';

let base: string;
beforeAll(() => {
	base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-')));
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

let n = 0;
const fresh = (name: string) => {
	const dir = path.join(base, `${name}-${n++}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
};
const sh = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe' });
	if (!r.success) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
/** A git repository named `name` under a fresh parent, optionally with an origin */
const repo = (name: string, origin?: string) => {
	const dir = path.join(fresh('parent'), name);
	fs.mkdirSync(dir);
	sh(dir, 'init', '-q');
	if (origin) sh(dir, 'remote', 'add', 'origin', origin);
	return dir;
};
const opts = () => ({ dataDir: fresh('data'), ignore: null, home: path.join(base, 'home') });
const oldFormula = (root: string) =>
	`proj_${path
		.basename(root)
		.replace(/[^a-zA-Z0-9_-]/g, '-')
		.toLowerCase()}_${crypto.createHash('sha256').update(root).digest('hex').slice(0, 6)}`;

test('normalizeRemote gives one string for every spelling of a remote', () => {
	const want = 'repo.example/team/app';
	for (const url of [
		'https://repo.example/team/app.git',
		'https://user:token@Repo.Example/team/app.git',
		'https://repo.example/team/app/',
		'ssh://git@repo.example:22/team/app',
		'git@repo.example:team/app.git',
		'  git@REPO.example:team/app  ',
	]) {
		expect(normalizeRemote(url)).toBe(want);
	}
	expect(normalizeRemote('')).toBeNull();
	expect(normalizeRemote('/some/local/path')).toBeNull();
	expect(normalizeRemote('https://repo.example/')).toBeNull();
});

test('legacyTag is exactly the tag the project always had', () => {
	expect(legacyTag('/Users/me/dev/My App')).toBe(oldFormula('/Users/me/dev/My App'));
});

test('a repository without a remote keeps its old tag and writes no registry', () => {
	const o = opts();
	const dir = repo('plain');
	const p = resolveProject(dir, o)!;
	expect(p.containerTag).toBe(oldFormula(dir));
	expect(p.readTags).toEqual([p.containerTag]);
	expect(p.rootDir).toBe(dir);
	expect(fs.existsSync(registryFile(o.dataDir))).toBe(false);
});

test('a single clone with a remote keeps its old tag and registers itself', () => {
	const o = opts();
	const dir = repo('app', 'https://repo.example/team/app.git');
	const p = resolveProject(dir, o)!;
	expect(p.containerTag).toBe(oldFormula(dir));
	expect(p.readTags).toEqual([p.containerTag]);
	expect(readRegistry(o.dataDir)).toEqual({ 'repo.example/team/app': { tag: p.containerTag, also: [] } });
	// resolving again changes nothing
	expect(resolveProject(dir, o)).toEqual(p);
});

test('two clones of one remote write to one tag and both read both tags', () => {
	const o = opts();
	const a = repo('app', 'https://repo.example/team/app.git');
	const b = repo('app', 'ssh://git@Repo.example:22/team/app'); // same name, other path, other spelling
	const pa = resolveProject(a, o)!;
	const pb = resolveProject(b, o)!;
	expect(pb.containerTag).toBe(pa.containerTag);
	expect(pa.containerTag).toBe(oldFormula(a));
	expect(pb.readTags).toEqual([oldFormula(a), oldFormula(b)]);
	// the first clone learns about the second one the next time it is resolved
	expect(resolveProject(a, o)!.readTags).toEqual([oldFormula(a), oldFormula(b)]);
	expect(pb.rootDir).toBe(b);
});

test('a subdirectory of a repository uses the repository', () => {
	const o = opts();
	const dir = repo('app');
	fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'src', 'a.ts'), '');
	expect(resolveProject(path.join(dir, 'src', 'deep'), o)!.rootDir).toBe(dir);
	expect(resolveProject(path.join(dir, 'src', 'a.ts'), o)!.rootDir).toBe(dir);
});

test('a plain folder (no git, no repositories inside) is its own project', () => {
	const o = opts();
	const dir = fresh('docs');
	fs.mkdirSync(path.join(dir, 'chapter-1'));
	const p = resolveProject(dir, o)!;
	expect(p.containerTag).toBe(oldFormula(dir));
	expect(p.projectName).toBe(path.basename(dir));
});

test('a folder that holds repositories, and $HOME, are workspace containers', () => {
	const o = opts();
	const parent = fresh('workspace');
	for (const name of ['one', 'two']) {
		fs.mkdirSync(path.join(parent, name));
		sh(path.join(parent, name), 'init', '-q');
	}
	expect(resolveProject(parent, o)).toBeNull();
	expect(containerReason(parent, o)).toMatchObject({ kind: 'repos', message: expect.stringContaining('one, two') });
	// repositories one level further down still count (depth two), three levels down do not
	const deep = fresh('deep');
	fs.mkdirSync(path.join(deep, 'a', 'b'), { recursive: true });
	sh(path.join(deep, 'a', 'b'), 'init', '-q');
	expect(resolveProject(deep, o)).toBeNull();
	const tooDeep = fresh('toodeep');
	fs.mkdirSync(path.join(tooDeep, 'a', 'b', 'c'), { recursive: true });
	sh(path.join(tooDeep, 'a', 'b', 'c'), 'init', '-q');
	expect(resolveProject(tooDeep, o)).not.toBeNull();
	// $HOME
	fs.mkdirSync(o.home, { recursive: true });
	expect(resolveProject(o.home, o)).toBeNull();
	expect(containerReason(o.home, o)?.kind).toBe('home');
	// but a repository inside the container is a project
	expect(resolveProject(path.join(parent, 'one'), o)!.rootDir).toBe(path.join(parent, 'one'));
});

test('dot-directories and node_modules do not make a folder a container', () => {
	const dir = fresh('hidden');
	for (const hidden of ['.cache/x', 'node_modules/pkg']) {
		fs.mkdirSync(path.join(dir, hidden), { recursive: true });
		fs.mkdirSync(path.join(dir, hidden, '.git'));
	}
	expect(findRepos(dir)).toEqual([]);
});

test('ignored directories have no project', () => {
	const o = { ...opts(), ignore: /Application Support|scratch/ };
	const dir = path.join(fresh('x'), 'Application Support', 'tool');
	fs.mkdirSync(dir, { recursive: true });
	expect(resolveProject(dir, o)).toBeNull();
	expect(containerReason(dir, o)?.kind).toBe('ignored');
	expect(resolveProject(repo('fine'), o)).not.toBeNull();
});

test('a corrupt or unwritable registry only costs sharing, never the project', () => {
	const o = opts();
	fs.writeFileSync(registryFile(o.dataDir), '{ not json');
	const dir = repo('app', 'https://repo.example/team/app.git');
	expect(resolveProject(dir, o)!.containerTag).toBe(oldFormula(dir));
	// data dir that cannot be created: still resolves
	const blocked = { ...o, dataDir: path.join(fresh('f'), 'file', 'sub') };
	fs.writeFileSync(path.dirname(blocked.dataDir), '');
	expect(resolveProject(dir, blocked)!.readTags).toEqual([oldFormula(dir)]);
});

test('link keeps the first tag as the write tag and never duplicates', () => {
	const reg = {};
	expect(link(reg, 'r', 'a').changed).toBe(true);
	expect(link(reg, 'r', 'a').changed).toBe(false);
	expect(link(reg, 'r', 'b')).toMatchObject({ changed: true, entry: { tag: 'a', also: ['b'] } });
	expect(link(reg, 'r', 'b').changed).toBe(false);
	expect(link(reg, 'r', 'a').changed).toBe(false);
});
