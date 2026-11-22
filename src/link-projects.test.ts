import { expect, test } from 'bun:test';
import { planLinks, type RemoteLookup } from './link-projects.ts';

const remotes: Record<string, RemoteLookup> = {
	'/dev/a/app': { remote: 'repo/x/app' },
	'/dev/b/app': { remote: 'repo/x/app' },
	'/dev/solo': { remote: 'repo/x/solo' },
	'/dev/old/app': { remote: 'repo/x/app' },
	'/dev/gone': { skip: 'missing' },
	'/dev/plain': { skip: 'no-remote' },
};
const lookup = (dir: string): RemoteLookup => remotes[dir] ?? { skip: 'missing' };
const docs = (rootDir: string | undefined, tag: string, n: number) => Array.from({ length: n }, () => ({ rootDir, tag }));

test('clones of one remote are linked, the tag with the most documents is the write tag', () => {
	const plan = planLinks(
		[...docs('/dev/a/app', 'tag_a', 3), ...docs('/dev/b/app', 'tag_b', 10), ...docs('/dev/solo', 'tag_solo', 5)],
		lookup,
	);
	expect(plan.groups).toEqual([
		{ remote: 'repo/x/app', tag: 'tag_b', also: ['tag_a'], counts: { tag_a: 3, tag_b: 10 }, extended: false },
	]);
	expect(plan.registry).toEqual({ 'repo/x/app': { tag: 'tag_b', also: ['tag_a'] } });
	expect(plan.changed).toBe(true);
});

test('a remote with one tag needs no entry, and unplaceable documents are counted', () => {
	const plan = planLinks(
		[
			...docs('/dev/solo', 'tag_solo', 2),
			...docs(undefined, 'tag_x', 4),
			...docs('/dev/gone', 'tag_g', 3),
			...docs('/dev/plain', 'tag_p', 1),
		],
		lookup,
	);
	expect(plan.groups).toEqual([]);
	expect(plan.changed).toBe(false);
	expect(plan.skipped).toEqual({ noRootDir: 4, missing: 3, noRemote: 1 });
});

test('an existing entry keeps its write tag and only gains tags; rerunning over its own output changes nothing', () => {
	const rows = [...docs('/dev/a/app', 'tag_a', 3), ...docs('/dev/b/app', 'tag_b', 10), ...docs('/dev/old/app', 'tag_old', 1)];
	const existing = { 'repo/x/app': { tag: 'tag_a', also: ['tag_b'] } };
	const plan = planLinks(rows, lookup, existing);
	expect(plan.registry['repo/x/app']).toEqual({ tag: 'tag_a', also: ['tag_b', 'tag_old'] });
	expect(plan.groups[0]).toMatchObject({ extended: true, tag: 'tag_a' });
	expect(existing['repo/x/app']!.also).toEqual(['tag_b']); // input untouched

	const again = planLinks(rows, lookup, plan.registry);
	expect(again.groups).toEqual([]);
	expect(again.changed).toBe(false);
});

test('equal counts are broken by tag name so the plan is stable', () => {
	const plan = planLinks([...docs('/dev/b/app', 'tag_b', 2), ...docs('/dev/a/app', 'tag_a', 2)], lookup);
	expect(plan.registry['repo/x/app']).toEqual({ tag: 'tag_a', also: ['tag_b'] });
});
