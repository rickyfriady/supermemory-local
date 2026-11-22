// Seeds the project registry (<dataDir>/projects.json) from documents already in the store, so clones of one remote that
// stored memories before they were linked share them. Pure planning here; bin/link-projects.ts does the reading and writing.
// Nothing is ever written to the memory server: the registry only decides which existing tags are read together.
import type { Registry } from './project-resolver.ts';

export interface DocRow {
	/** metadata.rootDir of the document, when the hooks recorded one */
	rootDir?: string;
	/** The document's container tag */
	tag: string;
}

/** What is known about a working copy on disk */
export type RemoteLookup = { remote: string } | { skip: 'missing' | 'no-remote' };

export interface LinkGroup {
	remote: string;
	/** Tag new memories are written to */
	tag: string;
	/** Other tags read together with it */
	also: string[];
	counts: Record<string, number>;
	/** The registry already had this remote and only gained tags */
	extended: boolean;
}

export interface LinkPlan {
	groups: LinkGroup[];
	registry: Registry;
	changed: boolean;
	skipped: { noRootDir: number; missing: number; noRemote: number };
}

/**
 * Groups document tags by the remote of the directory they were recorded in. Only remotes with more than one tag need an
 * entry (a single clone registers itself on first use). An existing entry's write tag is never changed, only extended.
 */
export function planLinks(rows: DocRow[], lookup: (rootDir: string) => RemoteLookup, existing: Registry = {}): LinkPlan {
	const skipped = { noRootDir: 0, missing: 0, noRemote: 0 };
	const byRemote = new Map<string, Map<string, number>>();
	const cache = new Map<string, RemoteLookup>();

	for (const { rootDir, tag } of rows) {
		if (!rootDir) {
			skipped.noRootDir++;
			continue;
		}
		let found = cache.get(rootDir);
		if (!found) cache.set(rootDir, (found = lookup(rootDir)));
		if ('skip' in found) {
			if (found.skip === 'missing') skipped.missing++;
			else skipped.noRemote++;
			continue;
		}
		const counts = byRemote.get(found.remote) ?? new Map<string, number>();
		counts.set(tag, (counts.get(tag) ?? 0) + 1);
		byRemote.set(found.remote, counts);
	}

	const registry: Registry = structuredClone(existing);
	const groups: LinkGroup[] = [];
	let changed = false;
	for (const [remote, counts] of [...byRemote].sort(([a], [b]) => a.localeCompare(b))) {
		if (counts.size < 2) continue;
		// most documents first, ties by name so the plan is stable
		const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
		const entry = registry[remote];
		const tag = entry?.tag ?? tags[0]!;
		const known = new Set([tag, ...(entry?.also ?? [])]);
		const added = tags.filter((t) => !known.has(t));
		if (entry && added.length === 0) continue; // already linked
		registry[remote] = { tag, also: [...(entry?.also ?? []), ...added] };
		changed = true;
		groups.push({
			remote,
			tag,
			also: registry[remote].also,
			counts: Object.fromEntries(counts),
			extended: !!entry,
		});
	}
	return { groups, registry, changed, skipped };
}
