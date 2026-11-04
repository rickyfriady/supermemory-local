// MCP server over stdio: newline-delimited JSON-RPC, hand-written so the runtime stays dependency-free.
// Gives any MCP client on-demand access to the same per-project memory the hooks use (same container tags).
import fs from 'node:fs';
import path from 'node:path';
import { log, renderHits, stripContext, toEnglish } from './hook-handler.ts';
import { resolveProject } from './project-resolver.ts';
import { type Result, type SearchHit, SupermemoryClient } from './supermemory-client.ts';

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 50;
const MAX_CONTENT = 40_000;
const PROJECT_PATH = {
	type: 'string',
	description: 'Absolute path of the project, or of any directory inside its repository. Selects whose memory is used.',
};

export const TOOLS = [
	{
		name: 'search',
		description: "Search a project's shared memory (extracted memories and document excerpts) for what is relevant to a query.",
		inputSchema: {
			type: 'object',
			properties: {
				project_path: PROJECT_PATH,
				query: { type: 'string', description: 'What to look for' },
				limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum results (default ${DEFAULT_LIMIT})` },
			},
			required: ['project_path', 'query'],
		},
	},
	{
		name: 'add',
		description: "Store a fact or note in a project's shared memory, available to every agent working on that project.",
		inputSchema: {
			type: 'object',
			properties: {
				project_path: PROJECT_PATH,
				content: { type: 'string', description: 'The text to remember' },
			},
			required: ['project_path', 'content'],
		},
	},
	{
		name: 'profile',
		description: 'Get the long-lived and recent facts the memory server extracted for a project.',
		inputSchema: { type: 'object', properties: { project_path: PROJECT_PATH }, required: ['project_path'] },
	},
];

type Args = Record<string, unknown>;

function project(args: Args) {
	const p = args.project_path;
	if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(p)) {
		throw new Error('project_path must be an absolute path that exists');
	}
	return resolveProject(p);
}

function requiredText(args: Args, name: string): string {
	const value = args[name];
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return value;
}

function unwrap<T>(res: Result<T>, client: SupermemoryClient): T {
	if (res.success) return res.data;
	throw new Error(
		`Memory server error at ${client.baseUrl}: ${res.error}. If it is down, run "bun run start" in supermemory-local.`,
	);
}

const bullets = (facts: string[] = []) => (facts.length ? facts.map((f) => `- ${f}`).join('\n') : '(none)');

const HANDLERS: Record<string, (args: Args, client: SupermemoryClient) => Promise<string>> = {
	async search(args, client) {
		const { containerTag } = project(args);
		const q = await toEnglish(requiredText(args, 'query').slice(0, 1000));
		const wanted = Number.isInteger(args.limit) ? (args.limit as number) : DEFAULT_LIMIT;
		const limit = Math.min(Math.max(wanted, 1), MAX_LIMIT);
		// client.request, not client.search: search() turns failures into an empty result, which reads as "no memories"
		const res = await client.request<{ results?: SearchHit[] }>('POST', '/v4/search', {
			q,
			containerTag,
			searchMode: 'hybrid',
			limit,
		});
		const lines = renderHits(unwrap(res, client).results ?? []);
		return lines.length ? lines.join('\n').trim() : 'No memories found for this project.';
	},

	async add(args, client) {
		const { containerTag, projectName, rootDir } = project(args);
		const content = stripContext(requiredText(args, 'content'));
		if (content.length > MAX_CONTENT) throw new Error(`content is too long (${content.length} chars, limit ${MAX_CONTENT})`);
		const res = await client.addDocument({
			content: await toEnglish(content, 12_000),
			containerTags: [containerTag],
			metadata: { type: 'note', agent: 'MCP', project: projectName, rootDir },
		});
		const { id, status } = unwrap(res, client);
		return `Stored document ${id} (status: ${status}) for project ${projectName}.`;
	},

	async profile(args, client) {
		const { containerTag } = project(args);
		const res = await client.request<{ profile?: { static?: string[]; dynamic?: string[] } }>('POST', '/v4/profile', {
			containerTag,
		});
		const { static: longLived, dynamic: recent } = unwrap(res, client).profile ?? {};
		return `## Long-lived facts\n${bullets(longLived)}\n\n## Recent facts\n${bullets(recent)}`;
	},
};

// Client per call: this process outlives server restarts, and switching embedding model switches the store's api-key
type MakeClient = () => SupermemoryClient;

async function callTool(params: any, makeClient: MakeClient) {
	const handler = HANDLERS[params.name];
	try {
		return { content: [{ type: 'text', text: await handler!(params.arguments ?? {}, makeClient()) }] };
	} catch (err) {
		log(`MCP ${params.name} failed: ${(err as Error).message}`);
		return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
	}
}

/**
 * JSON-RPC reply for one parsed message, or null when none is due (notifications, replies to us)
 */
export async function handleMessage(msg: any, makeClient: MakeClient = () => new SupermemoryClient()) {
	if (typeof msg !== 'object' || msg === null || Array.isArray(msg) || typeof msg.method !== 'string') {
		if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return null;
		return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
	}
	if (msg.id === undefined) return null;

	const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
	const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

	switch (msg.method) {
		case 'initialize':
			// ponytail: echoes the client's version; only core methods that are unchanged across versions are implemented
			return reply({
				protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
				capabilities: { tools: {} },
				serverInfo: { name: 'supermemory-local', version: '1.0.0' },
			});
		case 'ping':
			return reply({});
		case 'tools/list':
			return reply({ tools: TOOLS });
		case 'tools/call':
			if (!Object.hasOwn(HANDLERS, msg.params?.name)) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
			return reply(await callTool(msg.params, makeClient));
		default:
			return fail(-32601, `Method not found: ${msg.method}`);
	}
}

export async function handleLine(line: string, makeClient?: MakeClient) {
	let msg: unknown;
	try {
		msg = JSON.parse(line);
	} catch {
		return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
	}
	return handleMessage(msg, makeClient);
}
