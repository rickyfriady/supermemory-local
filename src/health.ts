// Read-only health signals for `bun run status`, parsed from log text. Pure functions plus a tail reader; no side effects.
// They exist because OpenCode's plugin failed to load for a month and agy stored no summaries for months, silently.
import fs from 'node:fs';

export const AGENTS = ['claude-code', 'antigravity', 'opencode'] as const;
export type AgentName = (typeof AGENTS)[number];

/** Last `bytes` of a file as text ('' when unreadable): logs grow without bound, a status check must not read them whole */
export function readTail(file: string, bytes = 2_000_000): string {
	try {
		const fd = fs.openSync(file, 'r');
		try {
			const { size } = fs.fstatSync(fd);
			const start = Math.max(0, size - bytes);
			const buf = Buffer.alloc(size - start);
			fs.readSync(fd, buf, 0, buf.length, start);
			return buf.toString('utf-8');
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return '';
	}
}

/** When each agent's hook last ran, from ~/.supermemory-hook.log lines like `[2026-11-16T07:48:37.529Z] Invoked: agent=antigravity, action=start` */
export function lastHookRuns(hookLog: string): Record<AgentName, Date | null> {
	const last: Record<AgentName, Date | null> = { 'claude-code': null, antigravity: null, opencode: null };
	for (const m of hookLog.matchAll(/^\[([^\]]+)\] Invoked: agent=([\w-]+)/gm)) {
		const agent = m[2] as AgentName;
		if (!(agent in last)) continue;
		const at = new Date(m[1]!);
		if (!Number.isNaN(at.getTime()) && (!last[agent] || at > last[agent]!)) last[agent] = at;
	}
	return last;
}

export function ago(at: Date | null, now = new Date()): string {
	if (!at) return 'never';
	const s = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
	if (s < 90) return `${s}s ago`;
	if (s < 5400) return `${Math.round(s / 60)}m ago`;
	if (s < 129_600) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86_400)}d ago`;
}

/**
 * The newest "failed to load plugin" line for the memory plugin in OpenCode's log that is newer than the installed plugin
 * file (older failures belong to a previous version of it). Returns the cause, or null when the plugin loads.
 */
export function openCodeLoadFailure(openCodeLog: string, installedAt: Date | null): string | null {
	let failure: string | null = null;
	for (const line of openCodeLog.split('\n')) {
		if (!line.includes('failed to load plugin') || !line.includes('supermemory-local.')) continue;
		const at = new Date(line.match(/timestamp=(\S+)/)?.[1] ?? '');
		if (installedAt && !(at > installedAt)) continue;
		failure = line.match(/cause="(.*?)"(?: |$)/)?.[1]?.replace(/\\n/g, ' ') ?? 'unknown cause';
	}
	return failure;
}

/** Failure share of the newest `limit` chat calls in data/llm-proxy.log (lines: `<iso> POST /chat/completions 200 3292ms`) */
export function extractionHealth(proxyLog: string, limit = 200): { total: number; failed: number; rate: number } {
	const statuses = [...proxyLog.matchAll(/^\S+ POST \S*\/chat\/completions (\d{3}) /gm)].map((m) => Number(m[1])).slice(-limit);
	const failed = statuses.filter((s) => s < 200 || s >= 300).length;
	return { total: statuses.length, failed, rate: statuses.length ? failed / statuses.length : 0 };
}

/** More than one in ten of the recent calls failed */
export const extractionUnhealthy = (h: { total: number; rate: number }) => h.total >= 10 && h.rate > 0.1;
