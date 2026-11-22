import { expect, test } from 'bun:test';
import { ago, extractionHealth, extractionUnhealthy, lastHookRuns, openCodeLoadFailure } from './health.ts';

test('lastHookRuns finds the newest run per agent and ignores other agents', () => {
	const log = [
		'[2026-11-16T07:48:37.529Z] Invoked: agent=antigravity, action=start',
		'[2026-11-16T07:59:37.481Z] Invoked: agent=claude-code, action=change',
		'[2026-11-16T07:49:22.873Z] Invoked: agent=antigravity, action=stop',
		'[2026-10-09T03:00:31.856Z] Invoked: agent=opencode, action=stop',
		'[2026-11-16T07:59:00.000Z] Invoked: agent=zed, action=start',
		'Saving session_summary (Antigravity): [Agent: Antigravity] Invoked: agent=opencode',
	].join('\n');
	const runs = lastHookRuns(log);
	expect(runs.antigravity?.toISOString()).toBe('2026-11-16T07:49:22.873Z');
	expect(runs['claude-code']?.toISOString()).toBe('2026-11-16T07:59:37.481Z');
	expect(runs.opencode?.toISOString()).toBe('2026-10-09T03:00:31.856Z');
	expect(lastHookRuns('')).toEqual({ 'claude-code': null, antigravity: null, opencode: null });
});

test('ago reads naturally and says never for no run', () => {
	const now = new Date('2026-11-16T08:00:00Z');
	expect(ago(null, now)).toBe('never');
	expect(ago(new Date('2026-11-16T07:59:30Z'), now)).toBe('30s ago');
	expect(ago(new Date('2026-11-16T07:48:00Z'), now)).toBe('12m ago');
	expect(ago(new Date('2026-11-16T03:00:00Z'), now)).toBe('5h ago');
	expect(ago(new Date('2026-10-09T08:00:00Z'), now)).toBe('38d ago');
});

const failure = (ts: string, file = 'plugins/supermemory-local.ts') =>
	`timestamp=${ts} level=WARN run=a message="failed to load plugin" target=/x/${file} ref=err_1 cause="Cause([Fail(PluginModule.LoadError: Plugin must export a default definition)])" http.span=1`;

test('openCodeLoadFailure reports only failures newer than the installed plugin', () => {
	const log = [
		failure('2026-10-13T15:22:14.759Z'),
		failure('2026-10-13T15:22:14.763Z', 'plugins/other.js'),
		'timestamp=2026-11-16T07:00:00.000Z level=INFO message="loading plugin"',
	].join('\n');
	// installed before the failure → still failing
	expect(openCodeLoadFailure(log, new Date('2026-10-01T00:00:00Z'))).toContain('Plugin must export a default definition');
	// reinstalled afterwards, no new failure → loads
	expect(openCodeLoadFailure(log, new Date('2026-11-16T06:49:00Z'))).toBeNull();
	// plugin file missing: any failure counts
	expect(openCodeLoadFailure(log, null)).not.toBeNull();
	expect(openCodeLoadFailure('', null)).toBeNull();
});

test('extractionHealth counts non-2xx chat calls among the newest ones', () => {
	const ok = (n: number) => Array.from({ length: n }, () => '2026-11-16T07:19:00.622Z POST /chat/completions 200 10108ms');
	const bad = (n: number) => Array.from({ length: n }, () => '2026-11-16T07:19:01.000Z POST /v1/chat/completions 400 221ms');
	const log = [...bad(50), ...ok(100), ...bad(30), '2026-11-16T07:19:02.000Z GET /models 200 12ms', ...ok(70)].join('\n');
	// newest 200 calls: 30 bad of 200
	const h = extractionHealth(log, 200);
	expect(h).toEqual({ total: 200, failed: 30, rate: 0.15 });
	expect(extractionUnhealthy(h)).toBe(true);
	expect(extractionUnhealthy(extractionHealth(ok(100).join('\n')))).toBe(false);
	// too few calls to judge
	expect(extractionUnhealthy(extractionHealth(bad(3).join('\n')))).toBe(false);
	expect(extractionHealth('')).toEqual({ total: 0, failed: 0, rate: 0 });
});
