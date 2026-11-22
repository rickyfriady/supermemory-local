#!/usr/bin/env bun
// Links clones of one git remote that already hold memories: bun --env-file=.env bin/link-projects.ts [--apply]
// Reads every document's recorded root directory and writes only <dataDir>/projects.json. Dry run unless --apply.
// It never writes to the memory server and can be rerun or undone by deleting that file.
import fs from 'node:fs';
import { currentConfig } from '../src/config.ts';
import { type DocRow, planLinks, type RemoteLookup } from '../src/link-projects.ts';
import { normalizeRemote, readRegistry, registryFile, writeRegistry } from '../src/project-resolver.ts';
import { SupermemoryClient } from '../src/supermemory-client.ts';

const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some((a) => a !== '--apply')) {
	console.error('Usage: bun run link-projects [--apply]');
	process.exit(2);
}

const config = currentConfig();
const client = new SupermemoryClient();
if (!(await client.isHealthy())) {
	console.error(`Memory server is not answering at ${client.baseUrl}. Run "bun run start" first.`);
	process.exit(1);
}

const PAGE = 100;
const rows: DocRow[] = [];
for (let page = 1, pages = 1; page <= pages; page++) {
	const res = await client.request<{
		memories?: { containerTags?: string[]; metadata?: { rootDir?: unknown } | null }[];
		pagination?: { totalPages?: number };
	}>('POST', '/v3/documents/list', { limit: PAGE, page, sort: 'createdAt', order: 'desc' });
	if (!res.success) {
		console.error(`Listing documents failed (page ${page}): ${res.error}`);
		process.exit(1);
	}
	pages = res.data.pagination?.totalPages ?? 1;
	for (const d of res.data.memories ?? []) {
		const tag = d.containerTags?.[0];
		if (tag) rows.push({ tag, rootDir: typeof d.metadata?.rootDir === 'string' ? d.metadata.rootDir : undefined });
	}
}

const lookup = (rootDir: string): RemoteLookup => {
	if (!fs.existsSync(rootDir)) return { skip: 'missing' };
	const r = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], { cwd: rootDir, stderr: 'ignore' });
	const remote = r.success ? normalizeRemote(r.stdout.toString()) : null;
	return remote ? { remote } : { skip: 'no-remote' };
};

const plan = planLinks(rows, lookup, readRegistry(config.dataDir));

console.log(`${rows.length} documents read, registry: ${registryFile(config.dataDir)}`);
for (const g of plan.groups) {
	const line = (t: string) => `${t} (${g.counts[t] ?? 0} docs)`;
	console.log(`\n${g.extended ? 'extend' : 'link'}  ${g.remote}`);
	console.log(`  writes to  ${line(g.tag)}`);
	for (const t of g.also) console.log(`  also reads ${line(t)}`);
}
const { noRootDir, missing, noRemote } = plan.skipped;
console.log(
	`\nSkipped documents: ${noRootDir} without a recorded directory, ${missing} whose directory is gone, ${noRemote} without an origin remote.`,
);

if (!plan.groups.length) {
	console.log('Nothing new to link.');
} else if (!apply) {
	console.log(
		`\nDry run: ${plan.groups.length} group(s) would be linked. Run "bun run link-projects --apply" to write the registry.`,
	);
} else if (writeRegistry(config.dataDir, plan.registry)) {
	console.log(`\nLinked ${plan.groups.length} group(s). Registry written.`);
} else {
	console.error('\nCould not write the registry.');
	process.exit(1);
}
