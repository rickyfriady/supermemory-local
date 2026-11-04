// Unit checks for the MCP server: protocol handling, input validation, and API failures as tool errors: bun test
import { expect, test } from 'bun:test';
import { handleLine, handleMessage } from './mcp-server.ts';
import { resolveProject } from './project-resolver.ts';
import { SupermemoryClient } from './supermemory-client.ts';

const call = (name: string, args: unknown, makeClient?: () => SupermemoryClient) =>
	handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, makeClient) as Promise<any>;

/** Client whose request() is scripted, recording what was sent */
function fakeClient(data: unknown) {
	const client = new SupermemoryClient({ baseUrl: 'http://fake', apiKey: 'k' });
	const sent: any[] = [];
	client.request = (async (method: string, urlPath: string, body: unknown) => {
		sent.push({ method, urlPath, body });
		return { success: true, data };
	}) as typeof client.request;
	return { client, sent };
}

test('initialize echoes the protocol version and advertises tools', async () => {
	const res: any = await handleMessage({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: { protocolVersion: '2025-03-26' },
	});
	expect(res.result.protocolVersion).toBe('2025-03-26');
	expect(res.result.capabilities.tools).toEqual({});
});

test('tools/list has exactly search, add and profile, each with a schema', async () => {
	const res: any = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
	expect(res.result.tools.map((t: any) => t.name)).toEqual(['search', 'add', 'profile']);
	for (const tool of res.result.tools) expect(tool.inputSchema.required).toContain('project_path');
});

test('unknown method and unknown tool are JSON-RPC errors', async () => {
	const method: any = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'nope' });
	expect(method.error.code).toBe(-32601);
	const tool: any = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'constructor' } });
	expect(tool.error.code).toBe(-32602);
});

test('notifications and replies get no answer; bad input gets an error', async () => {
	expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
	expect(await handleMessage({ jsonrpc: '2.0', id: 9, result: {} })).toBeNull();
	expect(((await handleLine('{not json')) as any).error.code).toBe(-32700);
	expect(((await handleLine('[1]')) as any).error.code).toBe(-32600);
});

test('project_path must be absolute and exist', async () => {
	for (const project_path of ['relative/path', '/no/such/dir', undefined]) {
		const { client, sent } = fakeClient({});
		const res = await call('search', { project_path, query: 'q' }, () => client);
		expect(res.result.isError).toBe(true);
		expect(res.result.content[0].text).toContain('project_path');
		expect(sent).toEqual([]);
	}
});

test('search uses the hooks container tag and renders hits', async () => {
	const { client, sent } = fakeClient({ results: [{ id: 'a', memory: 'gateway port is 6276', similarity: 0.9 }] });
	const res = await call('search', { project_path: import.meta.dir, query: 'what is the gateway port', limit: 3 }, () => client);
	expect(res.result.isError).toBeUndefined();
	expect(res.result.content[0].text).toContain('gateway port is 6276');
	expect(sent[0].urlPath).toBe('/v4/search');
	expect(sent[0].body).toMatchObject({
		containerTag: resolveProject(import.meta.dir).containerTag,
		limit: 3,
		searchMode: 'hybrid',
	});
});

test('add tags the document and returns its ID', async () => {
	const { client, sent } = fakeClient({ id: 'doc1', status: 'queued' });
	const res = await call(
		'add',
		{ project_path: import.meta.dir, content: 'the gateway uses port 6276 on this machine' },
		() => client,
	);
	expect(res.result.content[0].text).toContain('doc1');
	expect(sent[0].body.containerTags).toEqual([resolveProject(import.meta.dir).containerTag]);
	expect(sent[0].body.metadata).toMatchObject({ type: 'note', agent: 'MCP' });
});

test('add rejects empty and oversized content', async () => {
	const { client, sent } = fakeClient({});
	for (const content of ['  ', 'x'.repeat(40_001)]) {
		const res = await call('add', { project_path: import.meta.dir, content }, () => client);
		expect(res.result.isError).toBe(true);
	}
	expect(sent).toEqual([]);
});

test('profile lists long-lived and recent facts in two groups', async () => {
	const { client } = fakeClient({ profile: { static: ['uses bun'], dynamic: [] } });
	const text = (await call('profile', { project_path: import.meta.dir }, () => client)).result.content[0].text;
	expect(text).toContain('## Long-lived facts\n- uses bun');
	expect(text).toContain('## Recent facts\n(none)');
});

test('memory server down is a tool error, not a crash or an empty result', async () => {
	const down = () => new SupermemoryClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' });
	for (const [name, args] of [
		['search', { project_path: import.meta.dir, query: 'an english query about the gateway' }],
		['add', { project_path: import.meta.dir, content: 'this is the content of a note' }],
		['profile', { project_path: import.meta.dir }],
	] as const) {
		const res = await call(name, args, down);
		expect(res.result.isError).toBe(true);
		expect(res.result.content[0].text).toContain('Memory server');
	}
});
