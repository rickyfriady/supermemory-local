// HTTP side of the sessions UI. It can read the catalog and create *pending* actions; there is deliberately no route that
// approves or runs one (that only happens at the terminal prompt, see sessions-actions.ts).
import crypto from 'node:crypto';
import {
	ActionError,
	SessionActions,
	listOpenCodeTrash,
	listTrash,
	metaKey,
	newSessionCommand,
	readMeta,
	resumeCommand,
	type ActionRequest,
	type Deps,
} from './sessions-actions.ts';
import type { OpenCodeCli } from './opencode-cli.ts';
import { listOthers, otherPaths, type OtherPaths } from './sessions-other.ts';
import { pageHtml } from './sessions-page.ts';
import {
	buildCatalog,
	filterCatalog,
	linkMemories,
	memoryExcerpts,
	SESSION_ID,
	type Cache,
	type MemoryLinks,
	type Roots,
	type SessionInfo,
} from './sessions-scan.ts';
import type { SupermemoryClient } from './supermemory-client.ts';

const MEMORY_TTL_MS = 30_000;
const MAX_BODY = 10_000;

export interface AppOptions {
	port: number;
	roots: Roots;
	dataDir: string;
	prompt: Deps['prompt'];
	client: Pick<SupermemoryClient, 'isHealthy' | 'listDocuments' | 'getDocument' | 'request'>;
	/** OpenCode and agy databases (read-only); the real ones under the home directory by default */
	others?: OtherPaths;
	/** the OpenCode CLI behind delete/restore of OpenCode sessions; the real one on PATH by default */
	opencode?: OpenCodeCli;
	/** fixed token for tests; a random one per run otherwise */
	token?: string;
	isLive?: Deps['isLive'];
	now?: () => number;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (message: string, status: number) => json({ error: message }, status);

function sameToken(a: string | null, b: string): boolean {
	if (!a) return false;
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function createApp(opts: AppOptions) {
	const token = opts.token ?? crypto.randomBytes(32).toString('hex');
	const hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
	const cache: Cache = new Map();
	const now = opts.now ?? Date.now;

	let links: { at: number; value: MemoryLinks } | undefined;
	const memoryLinks = async (force = false): Promise<MemoryLinks> => {
		if (!force && links && now() - links.at < MEMORY_TTL_MS) return links.value;
		const value = await linkMemories(buildCatalog(opts.roots, cache), opts.client);
		links = { at: now(), value };
		return value;
	};

	const find = (id: string): SessionInfo | undefined =>
		buildCatalog(opts.roots, cache)
			.flatMap((g) => g.sessions)
			.find((s) => s.id === id);

	const actions = new SessionActions({
		roots: opts.roots,
		dataDir: opts.dataDir,
		prompt: opts.prompt,
		isLive: opts.isLive,
		now: opts.now,
		client: opts.client,
		others: opts.others,
		opencode: opts.opencode,
		describe: (id) => {
			const s = find(id);
			return s ? `"${s.title}" (${s.project})` : '';
		},
		memoryIds: async (id) => (await memoryLinks(true)).bySession[id]?.map((m) => m.id) ?? [],
	});

	/** Claude entries first-class as before, OpenCode backups next to them; `agent` tells the page which restore/purge to request */
	const allTrash = () =>
		[...listTrash(opts.dataDir).map((t) => ({ ...t, agent: 'claude' as const })), ...listOpenCodeTrash(opts.dataDir)].sort(
			(a, b) => b.deletedAt.localeCompare(a.deletedAt),
		);

	async function route(req: Request, url: URL): Promise<Response> {
		const { pathname: p } = url;
		if (req.method === 'GET' && p === '/') {
			const nonce = crypto.randomBytes(16).toString('base64');
			return new Response(pageHtml(token, nonce), {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
					'Cache-Control': 'no-store',
					'X-Content-Type-Options': 'nosniff',
					'Referrer-Policy': 'no-referrer',
				},
			});
		}

		if (req.method === 'GET' && p === '/api/sessions') {
			const q = url.searchParams;
			const meta = readMeta(opts.dataDir);
			const mem = await memoryLinks();
			const groups = filterCatalog(
				buildCatalog(opts.roots, cache),
				{
					q: q.get('q') ?? undefined,
					project: q.get('project') || undefined,
					live: q.get('live') === '1' ? true : undefined,
					sort: q.get('sort') === 'size' ? 'size' : 'recent',
				},
				meta,
			).map((g) => ({
				project: g.project,
				lastAt: g.lastAt,
				newCommand: newSessionCommand(g.project),
				sessions: g.sessions.map(({ file: _file, ...s }) => ({ ...s, memoryCount: mem.bySession[s.id]?.length ?? 0 })),
			}));
			return json({
				groups,
				meta,
				memories: { available: mem.available, incomplete: mem.incomplete },
				trashCount: allTrash().length,
			});
		}

		const detail = p.match(/^\/api\/sessions\/([^/]+)$/);
		if (req.method === 'GET' && detail) {
			const id = detail[1]!;
			const s = SESSION_ID.test(id) ? find(id) : undefined;
			if (!s) return fail('session not found', 404);
			const mem = await memoryLinks();
			const refs = (mem.bySession[id] ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
			const { file: _file, ...info } = s;
			return json({
				session: info,
				resume: resumeCommand(s.project, id),
				memories: mem.available ? await memoryExcerpts(opts.client, refs) : null,
			});
		}

		if (req.method === 'GET' && p === '/api/other') {
			const meta = readMeta(opts.dataDir);
			const named = (agent: 'opencode' | 'antigravity', list: ReturnType<typeof listOthers>['opencode']) => ({
				...list,
				sessions: list.sessions.map((s) => ({ ...s, ...meta[metaKey(agent, s.id)] })),
			});
			const all = listOthers(opts.others ?? otherPaths());
			return json({ opencode: named('opencode', all.opencode), antigravity: named('antigravity', all.antigravity) });
		}

		if (req.method === 'GET' && p === '/api/trash') return json({ trash: allTrash() });
		if (req.method === 'GET' && p === '/api/actions') return json({ actions: actions.list() });
		const one = p.match(/^\/api\/actions\/([^/]+)$/);
		if (req.method === 'GET' && one) {
			const a = actions.get(one[1]!);
			return a ? json({ action: a }) : fail('action not found', 404);
		}

		if (req.method === 'POST' && p === '/api/actions') {
			if (!req.headers.get('content-type')?.startsWith('application/json')) return fail('JSON body required', 415);
			const text = await req.text();
			if (text.length > MAX_BODY) return fail('body too large', 413);
			let body: ActionRequest;
			try {
				body = JSON.parse(text);
			} catch {
				return fail('invalid JSON', 400);
			}
			try {
				const action = actions.create(body);
				if (body.kind === 'delete' && 'deleteMemories' in body && body.deleteMemories) links = undefined;
				return json({ action }, 202);
			} catch (err) {
				if (err instanceof ActionError) return fail(err.message, err.status);
				throw err;
			}
		}

		return fail('not found', 404);
	}

	/** Guards first (Host, Origin, token), then the route. Exported as `fetch` for Bun.serve and for tests. */
	async function fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (!hosts.has(url.host)) return fail('bad host', 403); // blocks DNS rebinding
		const readOnly = req.method === 'GET' || req.method === 'HEAD';
		if (!readOnly && ![...hosts].some((h) => req.headers.get('origin') === `http://${h}`)) return fail('bad origin', 403);
		if (url.pathname.startsWith('/api/') && !sameToken(req.headers.get('x-token'), token)) return fail('bad token', 401);
		try {
			return await route(req, url);
		} catch (err) {
			return fail(`server error: ${(err as Error).message}`, 500);
		}
	}

	return { fetch, actions, token };
}

export function startServer(opts: AppOptions) {
	const app = createApp(opts);
	// 127.0.0.1 only: nothing else on the network can connect
	const server = Bun.serve({ hostname: '127.0.0.1', port: opts.port, fetch: app.fetch });
	return { server, app };
}
