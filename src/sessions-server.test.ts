// Unit checks for the sessions UI server: request guards, routes, and "HTTP can never approve": bun test
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './sessions-server.ts';
import type { Roots } from './sessions-scan.ts';

const ID_A = '11111111-1111-4111-8111-111111111111';
const PORT = 20131;
const TOKEN = 'test-token';
const ORIGIN = `http://127.0.0.1:${PORT}`;

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(over: { prompt?: () => Promise<boolean>; healthy?: boolean } = {}) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-server-'));
	tmpDirs.push(home);
	const roots: Roots = {
		projectsDir: path.join(home, 'claude', 'projects'),
		sessionsDir: path.join(home, 'claude', 'sessions'),
		fileHistoryDir: path.join(home, 'claude', 'file-history'),
	};
	const slug = path.join(roots.projectsDir, '-work-app');
	fs.mkdirSync(slug, { recursive: true });
	fs.mkdirSync(roots.sessionsDir, { recursive: true });
	const transcript = path.join(slug, `${ID_A}.jsonl`);
	fs.writeFileSync(
		transcript,
		`${JSON.stringify({ type: 'user', cwd: '/work/app', timestamp: '2026-10-01T10:00:00.000Z', message: { content: '<img src=x onerror=alert(1)>' } })}\n`,
	);
	const app = createApp({
		port: PORT,
		roots,
		dataDir: path.join(home, 'data'),
		token: TOKEN,
		others: { opencodeDb: path.join(home, 'no-opencode.db'), agyDb: path.join(home, 'no-agy.db') },
		isLive: () => false,
		prompt: over.prompt ?? (async () => true),
		client: {
			isHealthy: async () => over.healthy ?? true,
			listDocuments: async () => [],
			getDocument: async () => null,
			request: (async () => ({ success: true, data: {} })) as never,
		},
	});
	return { app, transcript, home };
}

const call = (app: ReturnType<typeof setup>['app'], url: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
	app.fetch(new Request(url, init));
const authed = (extra: Record<string, string> = {}) => ({ 'x-token': TOKEN, ...extra });
const post = (body: unknown, headers: Record<string, string> = {}) => ({
	method: 'POST',
	headers: authed({ 'content-type': 'application/json', origin: ORIGIN, ...headers }),
	body: JSON.stringify(body),
});

test('the page is served with a nonce-based CSP, the token, and no external resources', async () => {
	const { app } = setup();
	const res = await call(app, `${ORIGIN}/`);
	expect(res.status).toBe(200);
	const csp = res.headers.get('content-security-policy')!;
	const nonce = csp.match(/script-src 'nonce-([^']+)'/)![1]!;
	expect(csp).toContain("default-src 'none'");
	const html = await res.text();
	expect(html).toContain(`<meta name="token" content="${TOKEN}">`);
	expect(html).toContain(`<script nonce="${nonce}">`);
	expect(html).not.toMatch(/(src|href)=["']?https?:/i);
	expect(html).not.toMatch(/@import|url\(\s*["']?https?:/i);
	expect(html).not.toContain('innerHTML');
});

test('a request for another Host (DNS rebinding) is rejected', async () => {
	const { app } = setup();
	expect((await call(app, `http://evil.test:${PORT}/api/sessions`, { headers: authed() })).status).toBe(403);
	expect((await call(app, `http://127.0.0.1:9999/`)).status).toBe(403);
	expect((await call(app, `http://localhost:${PORT}/`)).status).toBe(200);
});

test('API calls need the token', async () => {
	const { app } = setup();
	expect((await call(app, `${ORIGIN}/api/sessions`)).status).toBe(401);
	expect((await call(app, `${ORIGIN}/api/sessions`, { headers: { 'x-token': 'wrong' } })).status).toBe(401);
	expect((await call(app, `${ORIGIN}/api/sessions`, { headers: authed() })).status).toBe(200);
});

test('a state-changing request from a foreign or missing Origin is rejected and creates no pending action', async () => {
	const { app, transcript } = setup();
	for (const headers of [{ origin: 'https://evil.example' }, { origin: 'http://127.0.0.1:9999' }, { origin: '' }]) {
		const res = await call(app, `${ORIGIN}/api/actions`, post({ kind: 'delete', sessionId: ID_A }, headers));
		expect(res.status).toBe(403);
	}
	await app.actions.idle();
	expect(app.actions.list()).toEqual([]);
	expect(fs.existsSync(transcript)).toBe(true);
});

test('POST needs a JSON content type and a sane body', async () => {
	const { app } = setup();
	expect((await call(app, `${ORIGIN}/api/actions`, post({}, { 'content-type': 'text/plain' }))).status).toBe(415);
	const bad = await call(app, `${ORIGIN}/api/actions`, { ...post({}), body: '{nope' });
	expect(bad.status).toBe(400);
	expect((await call(app, `${ORIGIN}/api/actions`, post({ kind: 'delete', sessionId: '../../x' }))).status).toBe(400);
	expect((await call(app, `${ORIGIN}/api/actions`, post({ kind: 'explode' }))).status).toBe(400);
});

test('a valid request only creates a pending action; the file moves after the terminal approves', async () => {
	let answer!: (ok: boolean) => void;
	const { app, transcript } = setup({ prompt: () => new Promise((r) => (answer = r)) });
	const res = await call(app, `${ORIGIN}/api/actions`, post({ kind: 'delete', sessionId: ID_A }));
	expect(res.status).toBe(202);
	const { action } = (await res.json()) as { action: { id: string; status: string } };
	expect(action.status).toBe('pending');
	await new Promise((r) => setTimeout(r, 10));
	expect(fs.existsSync(transcript)).toBe(true);
	answer(true);
	await app.actions.idle();
	const done = (await (await call(app, `${ORIGIN}/api/actions/${action.id}`, { headers: authed() })).json()) as {
		action: { status: string };
	};
	expect(done.action.status).toBe('done');
	expect(fs.existsSync(transcript)).toBe(false);
});

test('no HTTP route can approve or run a pending action', async () => {
	let answer!: (ok: boolean) => void;
	const { app, transcript } = setup({ prompt: () => new Promise((r) => (answer = r)) });
	const created = (await (await call(app, `${ORIGIN}/api/actions`, post({ kind: 'delete', sessionId: ID_A }))).json()) as {
		action: { id: string };
	};
	const id = created.action.id;
	const attempts: [string, string, unknown][] = [];
	for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
		for (const p of [
			`/api/actions/${id}`,
			`/api/actions/${id}/approve`,
			`/api/actions/${id}/run`,
			'/api/approve',
			`/api/actions/approve`,
			`/api/sessions/${ID_A}`,
			'/api/trash',
		])
			attempts.push([method, p, { status: 'approved', approve: true }]);
	for (const [method, p, body] of attempts) {
		const res = await call(app, `${ORIGIN}${p}`, { ...post(body), method });
		expect([404, 405, 415]).toContain(res.status);
	}
	expect(app.actions.get(id)!.status).toBe('pending');
	expect(fs.existsSync(transcript)).toBe(true);
	answer(false);
	await app.actions.idle();
	expect(app.actions.get(id)!.status).toBe('rejected');
});

test('the session list hides file-system paths of transcripts and keeps hostile text as plain data', async () => {
	const { app, home } = setup();
	const res = await call(app, `${ORIGIN}/api/sessions`, { headers: authed() });
	const body = await res.text();
	expect(body).not.toContain(home);
	const data = JSON.parse(body);
	expect(data.groups[0].project).toBe('/work/app');
	expect(data.groups[0].sessions[0].firstPrompt).toBe('<img src=x onerror=alert(1)>');
	expect(data.groups[0].newCommand).toBe("cd '/work/app' && claude");
});

test('session detail returns the resume command; unknown or malformed ids give 404', async () => {
	const { app } = setup();
	const ok = (await (await call(app, `${ORIGIN}/api/sessions/${ID_A}`, { headers: authed() })).json()) as any;
	expect(ok.resume).toBe(`cd '/work/app' && claude --resume ${ID_A}`);
	expect(ok.memories).toEqual([]);
	expect((await call(app, `${ORIGIN}/api/sessions/99999999-9999-4999-8999-999999999999`, { headers: authed() })).status).toBe(
		404,
	);
	expect((await call(app, `${ORIGIN}/api/sessions/not-an-id`, { headers: authed() })).status).toBe(404);
});

test('with the memory server down the list still loads and says memories are unavailable', async () => {
	const { app } = setup({ healthy: false });
	const data = (await (await call(app, `${ORIGIN}/api/sessions`, { headers: authed() })).json()) as any;
	expect(data.memories.available).toBe(false);
	expect(data.groups).toHaveLength(1);
	const detail = (await (await call(app, `${ORIGIN}/api/sessions/${ID_A}`, { headers: authed() })).json()) as any;
	expect(detail.memories).toBeNull();
});

test('/api/other needs the token, is GET only, and reports agents that are not installed', async () => {
	const { app } = setup();
	expect((await call(app, `${ORIGIN}/api/other`)).status).toBe(401);
	const data = (await (await call(app, `${ORIGIN}/api/other`, { headers: authed() })).json()) as any;
	expect(data.opencode).toEqual({ available: false, sessions: [], hidden: 0 });
	expect(data.antigravity.available).toBe(false);
	expect((await call(app, `${ORIGIN}/api/other`, post({}))).status).toBe(404);
});
