// OpenCode sessions are changed only through OpenCode's own CLI (`opencode session export|delete|import`), never with SQL:
// its database holds two generations of tables (session and session_v2 with their messages and events) that only the app keeps consistent.
// `--standalone` uses a private server instead of the background service, so nothing is left running afterwards.
import fs from 'node:fs';
import path from 'node:path';

export interface OpenCodeCli {
	/** true while any OpenCode process (TUI or background service) is alive; also true when that cannot be determined */
	running(): boolean;
	/** `session export`: one session as JSON text */
	exportSession(id: string): Promise<string>;
	/** `session delete`: the session and its child sessions */
	deleteSession(id: string): Promise<void>;
	/** `session import`: recreates a session (same id) under `directory` */
	importSession(file: string, directory: string): Promise<void>;
}

const TIMEOUT_MS = 120_000;

/**
 * First `opencode` on PATH that is a real binary. Zentty puts a shell-script wrapper first that launches through zentty,
 * which is not what we want to run for maintenance. OPENCODE_BIN overrides the search.
 */
export function findOpenCode(pathEnv = process.env.PATH ?? '', override = process.env.OPENCODE_BIN): string | undefined {
	if (override) return fs.existsSync(override) ? override : undefined;
	for (const dir of pathEnv.split(path.delimiter)) {
		if (!dir) continue;
		const file = path.join(dir, 'opencode');
		try {
			fs.accessSync(file, fs.constants.X_OK);
			if (!fs.statSync(file).isFile()) continue;
			const fd = fs.openSync(file, 'r');
			const head = Buffer.alloc(2);
			fs.readSync(fd, head, 0, 2, 0);
			fs.closeSync(fd);
			if (head.toString() !== '#!') return file;
		} catch {}
	}
	return undefined;
}

/** `ps -axo comm=` output: one executable path per line */
export const hasOpenCodeProcess = (psOutput: string) => psOutput.split('\n').some((l) => path.basename(l.trim()) === 'opencode');

function opencodeRunning(): boolean {
	try {
		const ps = Bun.spawnSync(['ps', '-axo', 'comm=']);
		return !ps.success || hasOpenCodeProcess(ps.stdout.toString());
	} catch {
		return true; // cannot tell: assume it is running, the safe answer
	}
}

export function realOpenCode(bin: string, env: Record<string, string> = {}): OpenCodeCli {
	async function run(args: string[]): Promise<string> {
		const p = Bun.spawn([bin, ...args], {
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, ...env },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		if (code !== 0)
			throw new Error(`opencode ${args.slice(0, 2).join(' ')} failed (exit ${code}): ${(err || out).trim().slice(0, 300)}`);
		return out;
	}
	return {
		running: opencodeRunning,
		exportSession: (id) => run(['session', 'export', '--standalone', id]),
		deleteSession: async (id) => void (await run(['session', 'delete', '--standalone', id])),
		importSession: async (file, directory) =>
			void (await run(['session', 'import', '--standalone', '--directory', directory, file])),
	};
}
