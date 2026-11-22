// Stack controller: 9router, the memory components (llm-proxy, zed-adapter, server) and mcpm-gateway. Entry: bin/stack.ts
// launchd stays the supervisor; this only writes/loads LaunchAgents, delegates the gateway to its gateway.sh, and stops
// 9router safely (SIGTERM only, never bootout, only processes descended from its LaunchAgent).
import { $ } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
	AGENTS,
	type AgentName,
	ago,
	extractionHealth,
	extractionUnhealthy,
	lastHookRuns,
	openCodeLoadFailure,
	readTail,
} from './health.ts';
import { type Config as CoreConfig, loadConfig as loadCoreConfig, PROJECT_ROOT as ROOT } from './config.ts';

export type Target = '9router' | 'memory' | 'gateway';
export type Action = 'start' | 'stop' | 'restart' | 'status' | 'logs';
export type Component = 'llm-proxy' | 'zed-adapter' | 'server';
export type Command = { action: Action; targets: Set<Target> };

export const PROJECT_ROOT = ROOT;

// Mirror PORT and SERVICE_LABEL in $MCPM_GATEWAY_DIR/gateway.sh
export const GATEWAY_PORT = 6276;
export const GATEWAY_LABEL = 'com.mcpm.gateway';
// Installed by 9router itself, not by this repo
export const NINEROUTER_LABEL = 'com.9router.autostart';

export const MEMORY_START_ORDER: readonly Component[] = ['llm-proxy', 'zed-adapter', 'server'];
// The server stops before the proxy it calls
export const MEMORY_STOP_ORDER: readonly Component[] = ['server', 'zed-adapter', 'llm-proxy'];

const ACTIONS: readonly Action[] = ['start', 'stop', 'restart', 'status', 'logs'];
const ALL_TARGETS: readonly Target[] = ['9router', 'memory', 'gateway'];
const DEFAULT_TARGETS: Record<'start' | 'stop' | 'restart', readonly Target[]> = {
	start: ALL_TARGETS,
	stop: ['gateway', 'memory'],
	restart: ['memory'],
};

export const USAGE = `Usage: bun run <start|stop|restart> [--memory] [--gateway] [--9router] [--all]
       bun run <status|logs>

  start     default: 9router (if not answering), memory components, gateway
  stop      default: gateway, memory components (9router keeps running)
  restart   default: memory components only (the gateway is left alone)
  --all     9router + memory + gateway; selectors combine`;

// Settings and defaults live in src/config.ts; this only adds the launchd paths.
export interface Config extends CoreConfig {
	launchAgentsDir: string;
	ninerouterPlist: string;
	env: Record<string, string | undefined>;
}

export function loadConfig(env: Record<string, string | undefined>, projectRoot: string, home = os.homedir()): Config {
	const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
	return {
		...loadCoreConfig(env, projectRoot, home),
		launchAgentsDir,
		ninerouterPlist: path.join(launchAgentsDir, `${NINEROUTER_LABEL}.plist`),
		env,
	};
}

export function parseCommand(argv: string[]): { ok: true; command: Command } | { ok: false; error: string } {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			strict: true,
			options: {
				memory: { type: 'boolean' },
				gateway: { type: 'boolean' },
				'9router': { type: 'boolean' },
				all: { type: 'boolean' },
			},
		});
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
	const { values, positionals } = parsed;
	if (positionals.length === 0) return { ok: false, error: 'Missing action' };
	if (positionals.length > 1) return { ok: false, error: `Unexpected argument: ${positionals[1]}` };
	const action = positionals[0] as Action;
	if (!ACTIONS.includes(action)) return { ok: false, error: `Unknown action: ${positionals[0]}` };

	const selected = new Set<Target>(values.all ? ALL_TARGETS : []);
	if (values.memory) selected.add('memory');
	if (values.gateway) selected.add('gateway');
	if (values['9router']) selected.add('9router');

	if (action === 'status' || action === 'logs') {
		if (selected.size > 0) return { ok: false, error: `${action} takes no component selector` };
		return { ok: true, command: { action, targets: selected } };
	}
	return { ok: true, command: { action, targets: selected.size > 0 ? selected : new Set(DEFAULT_TARGETS[action]) } };
}

export function orderTargets(op: 'start' | 'stop', targets: Set<Target>): Target[] {
	const order: Target[] = op === 'start' ? ['9router', 'memory', 'gateway'] : ['gateway', 'memory', '9router'];
	return order.filter((t) => targets.has(t));
}

// First `pid = N` line of `launchctl print`; null when the job has no running process
export function parseLaunchdPid(text: string): number | null {
	const m = /^\s*pid = (\d+)$/m.exec(text);
	return m ? Number(m[1]) : null;
}

// "COMMAND (PID: n)" from the first data line of `lsof -nP -iTCP:<port> -sTCP:LISTEN`
export function parseLsofHolder(text: string): string | null {
	const line = text.split('\n')[1]?.trim();
	if (!line) return null;
	const [command, pid] = line.split(/\s+/);
	return command && pid ? `${command} (PID: ${pid})` : null;
}

// Every descendant of rootPid (root excluded) from `ps -axo pid=,ppid=` output, breadth-first
export function descendants(rootPid: number, psText: string): number[] {
	const children = new Map<number, number[]>();
	for (const line of psText.split('\n')) {
		const [pid, ppid] = line.trim().split(/\s+/).map(Number);
		if (!pid || ppid === undefined || Number.isNaN(ppid)) continue;
		const list = children.get(ppid) ?? [];
		list.push(pid);
		children.set(ppid, list);
	}
	const out: number[] = [];
	const seen = new Set<number>([rootPid]);
	const queue = [rootPid];
	while (queue.length > 0) {
		for (const child of children.get(queue.shift()!) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			out.push(child);
			queue.push(child);
		}
	}
	return out;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface PlistOptions {
	label: string;
	runSh: string;
	component: Component;
	pathEnv: string;
	home: string;
	projectRoot: string;
	logFile: string;
}

// Same text the old bash controller's write_plist produced, so loaded agents need no migration
export function renderPlist(o: PlistOptions): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xml(o.label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xml(o.runSh)}</string>
        <string>${xml(o.component)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${xml(o.pathEnv)}</string>
        <key>HOME</key>
        <string>${xml(o.home)}</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>${xml(o.projectRoot)}</string>
    <key>StandardOutPath</key>
    <string>${xml(o.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(o.logFile)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
`;
}

// Profile and server names from the gateway's servers.yaml; throws on invalid YAML or an unexpected shape
export function summarizeServers(yamlText: string): { profile: string | null; servers: string[] } {
	const doc = Bun.YAML.parse(yamlText) as unknown;
	if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('servers.yaml is not a mapping');
	const { profile, servers } = doc as { profile?: unknown; servers?: unknown };
	const names = servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : [];
	return { profile: typeof profile === 'string' ? profile : null, servers: names };
}

// ---------------------------------------------------------------------------------------------------------------------
// Side effects (launchctl, lsof, ps, HTTP). Verified on the real machine, not in unit tests.

const domain = () => `gui/${process.getuid?.() ?? 0}`;
const service = (label: string) => `${domain()}/${label}`;
const memoryLabel = (c: Component) => `com.supermemory-local.${c}`;
const memoryPlist = (cfg: Config, c: Component) => path.join(cfg.launchAgentsDir, `${memoryLabel(c)}.plist`);
const gatewaySh = (cfg: Config) => path.join(cfg.gatewayDir, 'gateway.sh');
const gatewayPresent = (cfg: Config) => fs.existsSync(gatewaySh(cfg));

function portOf(cfg: Config, c: Component): number {
	return c === 'server' ? cfg.smPort : c === 'llm-proxy' ? cfg.llmProxyPort : cfg.zedAdapterPort;
}
function logOf(cfg: Config, c: Component): string {
	return path.join(cfg.dataDir, c === 'server' ? 'supermemory.log' : `${c}.log`);
}

export async function launchdInfo(label: string): Promise<string | null> {
	const r = await $`launchctl print ${service(label)}`.nothrow().quiet();
	return r.exitCode === 0 ? r.stdout.toString() : null;
}

export async function isLoaded(label: string): Promise<boolean> {
	return (await launchdInfo(label)) !== null;
}

export async function portHolder(port: number): Promise<string | null> {
	// lsof exits 1 when the port is free
	const r = await $`lsof -nP ${`-iTCP:${port}`} -sTCP:LISTEN`.nothrow().quiet();
	return parseLsofHolder(r.stdout.toString());
}

// Any HTTP response counts; null on connection failure or timeout
export async function fetchText(url: string, init: RequestInit = {}, timeoutMs = 2000): Promise<string | null> {
	try {
		const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
		return await res.text();
	} catch {
		return null;
	}
}

export async function answers(url: string, init?: RequestInit, timeoutMs?: number): Promise<boolean> {
	return (await fetchText(url, init, timeoutMs)) !== null;
}

async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs: number, intervalMs = 500): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return true;
		if (Date.now() >= deadline) return false;
		await Bun.sleep(intervalMs);
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

// Single runtime guard: a second copy could not bind, and KeepAlive would crash-loop it. Checks every selected target
// before anything is started, so a refusal leaves 9router untouched too.
async function preflight(cfg: Config, targets: Set<Target>): Promise<boolean> {
	const checks: { name: string; port: number }[] = [];
	if (targets.has('memory')) {
		for (const c of MEMORY_START_ORDER) if (!(await isLoaded(memoryLabel(c)))) checks.push({ name: c, port: portOf(cfg, c) });
	}
	if (targets.has('gateway') && gatewayPresent(cfg) && !(await isLoaded(GATEWAY_LABEL))) {
		checks.push({ name: 'mcpm-gateway', port: GATEWAY_PORT });
	}
	for (const { name, port } of checks) {
		const holder = await portHolder(port);
		if (holder) {
			console.error(`❌ Port ${port} (${name}) is already in use by: ${holder}`);
			console.error('Stop that process first. No LaunchAgent was loaded.');
			return false;
		}
	}
	return true;
}

async function memoryStart(cfg: Config): Promise<boolean> {
	const bun = Bun.which('bun');
	if (!bun) {
		console.error('❌ bun not found on PATH');
		return false;
	}
	// Never process.execPath: its versioned Cellar path disappears on `brew upgrade bun`
	const pathEnv = `${path.dirname(bun)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
	fs.mkdirSync(cfg.launchAgentsDir, { recursive: true });
	fs.mkdirSync(cfg.dataDir, { recursive: true });

	let ok = true;
	for (const c of MEMORY_START_ORDER) {
		if (await isLoaded(memoryLabel(c))) {
			console.log(`✓ ${c} already loaded`);
			continue;
		}
		const plist = memoryPlist(cfg, c);
		fs.writeFileSync(
			plist,
			renderPlist({
				label: memoryLabel(c),
				runSh: path.join(cfg.projectRoot, 'scripts', 'run.sh'),
				component: c,
				pathEnv,
				home: cfg.home,
				projectRoot: cfg.projectRoot,
				logFile: logOf(cfg, c),
			}),
		);
		const r = await $`launchctl bootstrap ${domain()} ${plist}`.nothrow().quiet();
		if (r.exitCode !== 0) {
			console.error(`❌ launchctl bootstrap ${memoryLabel(c)} failed: ${r.stderr.toString().trim()}`);
			ok = false;
			continue;
		}
		console.log(`→ Loaded ${memoryLabel(c)}`);
	}

	// The server loads its embedding model at boot, so give it a while
	for (const c of MEMORY_START_ORDER) {
		const port = portOf(cfg, c);
		if (await waitUntil(async () => (await portHolder(port)) !== null, 60_000, 1000)) {
			console.log(`✓ ${c} listening on port ${port}`);
		} else {
			console.error(`❌ ${c} did not bind port ${port}. Check: ${logOf(cfg, c)}`);
			ok = false;
		}
	}
	return ok;
}

async function memoryStop(cfg: Config): Promise<boolean> {
	for (const c of MEMORY_STOP_ORDER) {
		if (await isLoaded(memoryLabel(c))) await $`launchctl bootout ${service(memoryLabel(c))}`.nothrow().quiet();
	}
	// bootout returns before the process is gone; a start right after would hit "Input/output error" or a busy port
	let ok = true;
	for (const c of MEMORY_STOP_ORDER) {
		const port = portOf(cfg, c);
		const gone = async () => !(await isLoaded(memoryLabel(c))) && (await portHolder(port)) === null;
		if (await waitUntil(gone, 30_000)) {
			console.log(`✓ ${c} stopped`);
		} else {
			console.error(`⚠ ${c} still running: port ${port} held by ${(await portHolder(port)) ?? '(label still loaded)'}`);
			ok = false;
		}
	}
	return ok;
}

function gatewaySkip(cfg: Config): void {
	console.log(`ℹ mcpm-gateway not found at ${cfg.gatewayDir} (set MCPM_GATEWAY_DIR in .env); skipping`);
}

async function gatewayStart(cfg: Config): Promise<boolean> {
	if (!gatewayPresent(cfg)) {
		gatewaySkip(cfg);
		return true;
	}
	const listening = async () => (await portHolder(GATEWAY_PORT)) !== null;
	if (await isLoaded(GATEWAY_LABEL)) {
		if (await listening()) {
			console.log('✓ mcpm-gateway already running');
			return true;
		}
		// Loaded but not bound: `gateway.sh run` may still be waiting out TIME_WAIT sockets; a second bootstrap would fail
		console.log(`→ mcpm-gateway loaded but not listening yet; waiting up to 90 s for port ${GATEWAY_PORT}`);
	} else {
		await $`${gatewaySh(cfg)} start`.cwd(cfg.gatewayDir).nothrow();
	}
	// gateway.sh's exit code is not trusted (it returns 1 when the port is busy, even by itself); the port decides
	if (await waitUntil(listening, 90_000, 1000)) {
		console.log(`✓ mcpm-gateway listening on port ${GATEWAY_PORT}`);
		return true;
	}
	console.error(`❌ mcpm-gateway did not bind port ${GATEWAY_PORT}. Try: ${gatewaySh(cfg)} restart`);
	return false;
}

async function gatewayStop(cfg: Config): Promise<boolean> {
	if (!gatewayPresent(cfg)) {
		gatewaySkip(cfg);
		return true;
	}
	const loaded = await isLoaded(GATEWAY_LABEL);
	if (!loaded && (await portHolder(GATEWAY_PORT)) === null) {
		console.log('✓ mcpm-gateway already stopped');
		return true;
	}
	console.log('⚠ Stopping mcpm-gateway: open agent sessions lose its MCP tools until they reconnect (/mcp)');
	// Always exits 0, even when the port is still held, so only the check below decides
	await $`${gatewaySh(cfg)} stop`.cwd(cfg.gatewayDir).nothrow();
	const gone = async () => !(await isLoaded(GATEWAY_LABEL)) && (await portHolder(GATEWAY_PORT)) === null;
	if (await waitUntil(gone, 30_000)) {
		console.log('✓ mcpm-gateway stopped');
		return true;
	}
	console.error(
		`⚠ mcpm-gateway still running: port ${GATEWAY_PORT} held by ${(await portHolder(GATEWAY_PORT)) ?? '(label still loaded)'}`,
	);
	return false;
}

// Never affects the exit code: the memory server boots without 9router, only extraction fails until it answers
async function ninerouterStart(cfg: Config): Promise<boolean> {
	const modelsUrl = `${cfg.ninerouterUrl}/models`;
	if (await answers(modelsUrl)) {
		console.log(`✓ 9router answering at ${cfg.ninerouterUrl}`);
		return true;
	}
	if (await isLoaded(NINEROUTER_LABEL)) {
		// Never -k: that would kill a running instance
		console.log(`→ Starting 9router (launchctl kickstart ${service(NINEROUTER_LABEL)})`);
		await $`launchctl kickstart ${service(NINEROUTER_LABEL)}`.nothrow().quiet();
	} else if (fs.existsSync(cfg.ninerouterPlist)) {
		console.log(`→ Loading ${NINEROUTER_LABEL}`);
		await $`launchctl bootstrap ${domain()} ${cfg.ninerouterPlist}`.nothrow().quiet();
	} else {
		console.log(
			`⚠ 9router LaunchAgent ${NINEROUTER_LABEL} is not installed; start 9router yourself. Memory extraction fails until it answers.`,
		);
		return true;
	}
	if (await waitUntil(() => answers(modelsUrl), 30_000, 1000)) {
		console.log(`✓ 9router answering at ${cfg.ninerouterUrl}`);
	} else {
		console.log(`⚠ 9router is not answering at ${cfg.ninerouterUrl}; memory extraction fails until it is up`);
	}
	return true;
}

// Safety-critical: SIGTERM only, only the LaunchAgent's process and its descendants captured before the kill, never
// bootout (that would drop 9router from login startup). next-server runs in its own process group, so launchd's kill
// alone can leave it holding the port.
async function ninerouterStop(cfg: Config): Promise<boolean> {
	const port = cfg.ninerouterPort;
	const pid = parseLaunchdPid((await launchdInfo(NINEROUTER_LABEL)) ?? '');
	if (pid === null) {
		const holder = await portHolder(port);
		if (!holder) {
			console.log('✓ 9router already stopped');
			return true;
		}
		console.error(`❌ Port ${port} is held by ${holder}, which is not run by ${NINEROUTER_LABEL}; not stopping it`);
		return false;
	}
	const ps = await $`ps -axo pid=,ppid=`.nothrow().quiet();
	const tree = descendants(pid, ps.stdout.toString());
	console.log(`→ Stopping 9router (pid ${pid}${tree.length > 0 ? `, descendants ${tree.join(', ')}` : ''})`);
	await $`launchctl kill SIGTERM ${service(NINEROUTER_LABEL)}`.nothrow().quiet();
	await waitUntil(() => !alive(pid), 10_000);
	for (const p of tree) {
		if (!alive(p)) continue;
		try {
			process.kill(p, 'SIGTERM');
		} catch {
			// already gone (ESRCH)
		}
	}
	const done = async () => tree.every((p) => !alive(p)) && (await portHolder(port)) === null;
	if (await waitUntil(done, 15_000)) {
		console.log('✓ 9router stopped (LaunchAgent stays installed; starts again at login or with: bun run start --9router)');
		return true;
	}
	console.error(`❌ 9router still running: port ${port} held by ${(await portHolder(port)) ?? '(a descendant is still alive)'}`);
	return false;
}

const STEPS: Record<Target, { start: (cfg: Config) => Promise<boolean>; stop: (cfg: Config) => Promise<boolean> }> = {
	'9router': { start: ninerouterStart, stop: ninerouterStop },
	memory: { start: memoryStart, stop: memoryStop },
	gateway: { start: gatewayStart, stop: gatewayStop },
};

async function start(cfg: Config, targets: Set<Target>): Promise<boolean> {
	if (!(await preflight(cfg, targets))) return false;
	let ok = true;
	for (const t of orderTargets('start', targets)) ok = (await STEPS[t].start(cfg)) && ok;
	return ok;
}

// Every selected target is attempted even when an earlier one fails
async function stop(cfg: Config, targets: Set<Target>): Promise<boolean> {
	let ok = true;
	for (const t of orderTargets('stop', targets)) ok = (await STEPS[t].stop(cfg)) && ok;
	return ok;
}

function launchdLine(label: string, info: string | null, hint: string): string {
	if (info === null) return `   ○ ${label}: not loaded (${hint})`;
	const pid = parseLaunchdPid(info);
	return `   ● ${label}: loaded (${pid === null ? 'not running' : `PID ${pid}`})`;
}

// Exit code 0 only when the memory API and the LLM proxy both answer (usable as a health check)
async function status(cfg: Config): Promise<boolean> {
	let healthy = true;
	console.log('========================================================');
	console.log(' Supermemory Local Stack Status');
	console.log('========================================================');

	console.log('1. 9router Status:');
	const models = await fetchText(`${cfg.ninerouterUrl}/models`);
	if (models !== null) {
		console.log(`   ● Gateway: Running on http://127.0.0.1:${cfg.ninerouterPort}`);
		console.log(`   ● Available Models: ${(models.match(/"id":/g) ?? []).length} models detected`);
		console.log(`   ● Configured Model: ${cfg.llmModel}`);
	} else {
		console.log(`   ○ Gateway: NOT running (Expected port ${cfg.ninerouterPort})`);
	}
	if (await answers(`http://127.0.0.1:${cfg.llmProxyPort}/models`)) {
		console.log(`   ● LLM proxy: Running on http://127.0.0.1:${cfg.llmProxyPort} (stream:false + embedding dimensions)`);
	} else {
		console.log('   ○ LLM proxy: NOT running (supermemory memory generation will fail)');
		healthy = false;
	}
	if (await answers(`http://127.0.0.1:${cfg.zedAdapterPort}/v1/completions`)) {
		console.log(`   ● Zed adapter: Running on http://127.0.0.1:${cfg.zedAdapterPort}/v1/completions`);
	} else {
		console.log('   ○ Zed adapter: NOT running (Zed edit predictions will fail)');
	}
	console.log('');

	console.log('2. Supermemory Status:');
	// A search embeds the query, which can take longer than a plain probe on a cold server
	const search = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"q":"ping","limit":1}' };
	if (await answers(`http://127.0.0.1:${cfg.smPort}/v4/search`, search, 10_000)) {
		let current = '?';
		let stores = '';
		try {
			current = fs.readlinkSync(path.join(cfg.dataDir, 'current'));
		} catch {}
		try {
			stores = fs.readdirSync(path.join(cfg.dataDir, 'stores')).sort().join(' ');
		} catch {}
		console.log(`   ● HTTP API: Healthy on http://127.0.0.1:${cfg.smPort}`);
		console.log(`   ● Storage:  ${path.join(cfg.dataDir, current)}`);
		console.log(`   ● Stores:   ${stores}`);
		console.log(`   ● Embeddings: ${cfg.embedding.model} (${cfg.embedding.provider}), translate: ${cfg.translateModel || 'off'}`);
	} else {
		console.log(`   ○ HTTP API: Not responding on port ${cfg.smPort}`);
		healthy = false;
	}
	console.log('');

	console.log('3. LaunchAgents:');
	for (const c of ['server', 'llm-proxy', 'zed-adapter'] as const) {
		console.log(launchdLine(memoryLabel(c), await launchdInfo(memoryLabel(c)), 'start with: bun run start'));
	}
	console.log('');

	console.log('4. mcpm-gateway:');
	if (!gatewayPresent(cfg)) {
		console.log(`   ℹ mcpm-gateway not found at ${cfg.gatewayDir} (set MCPM_GATEWAY_DIR in .env); skipping`);
	} else {
		const holder = await portHolder(GATEWAY_PORT);
		console.log(holder ? `   ● Port ${GATEWAY_PORT}: listening (${holder})` : `   ○ Port ${GATEWAY_PORT}: not listening`);
		console.log(launchdLine(GATEWAY_LABEL, await launchdInfo(GATEWAY_LABEL), 'start with: bun run start --gateway'));
		const yamlFile = path.join(cfg.gatewayDir, 'servers.yaml');
		try {
			const { profile, servers } = summarizeServers(fs.readFileSync(yamlFile, 'utf8'));
			console.log(`   ● Profile: ${profile ?? '(none)'}`);
			console.log(`   ● Servers (${servers.length}): ${servers.join(', ')}`);
		} catch (err) {
			console.log(`   ○ servers.yaml: ${(err as Error).message}`);
		}
		console.log(`   ● Endpoint: http://127.0.0.1:${GATEWAY_PORT}/mcp/`);
		console.log(`   ● Full tool check: ${path.join(cfg.gatewayDir, 'health.sh')}`);
	}
	console.log('');

	console.log('5. Agent integrations:');
	agentIntegrations(cfg);
	console.log('');

	console.log('6. Effective configuration (from .env, secrets omitted):');
	console.log(
		`   Ports: memory API ${cfg.smPort}, LLM proxy ${cfg.llmProxyPort}, Zed adapter ${cfg.zedAdapterPort}, Sessions UI ${cfg.sessionsUiPort}, 9router ${cfg.ninerouterPort}`,
	);
	console.log(`   Extraction model: ${cfg.llmModel} via ${cfg.llmUpstream}`);
	console.log(`   Translation model: ${cfg.translateModel || 'off'}`);
	console.log(`   Embeddings: ${cfg.embedding.model} (${cfg.embedding.provider}, ${cfg.embedding.dimensions}d)`);
	console.log(`   Ignored folders: ${cfg.ignore ?? 'none'}`);
	for (const w of cfg.warnings) console.log(`   ⚠ ${w}`);
	console.log('========================================================');
	return healthy;
}

/** Per-agent hook activity, whether OpenCode loads the plugin, and how often memory extraction fails (see src/health.ts) */
function agentIntegrations(cfg: Config) {
	const now = new Date();
	const runs = lastHookRuns(readTail(path.join(cfg.home, '.supermemory-hook.log')));
	const labels: Record<AgentName, string> = { 'claude-code': 'Claude Code', antigravity: 'Antigravity', opencode: 'OpenCode' };
	for (const agent of AGENTS) {
		const at = runs[agent];
		console.log(`   ${at ? '●' : '○'} ${labels[agent]}: hook last ran ${ago(at, now)}`);
	}

	const configHome = process.env.XDG_CONFIG_HOME || path.join(cfg.home, '.config');
	const dataHome = process.env.XDG_DATA_HOME || path.join(cfg.home, '.local', 'share');
	const plugin = path.join(configHome, 'opencode', 'plugins', 'supermemory-local.ts');
	let installedAt: Date | null = null;
	try {
		installedAt = fs.statSync(plugin).mtime;
	} catch {}
	if (!installedAt) {
		console.log('   ○ OpenCode plugin: not installed (bun run install-hooks opencode)');
	} else {
		const failure = openCodeLoadFailure(readTail(path.join(dataHome, 'opencode', 'log', 'opencode.log')), installedAt);
		console.log(
			failure
				? `   ✗ OpenCode plugin: FAILED to load after it was installed: ${failure}`
				: '   ● OpenCode plugin: installed, no load failure logged',
		);
	}

	const health = extractionHealth(readTail(path.join(cfg.dataDir, 'llm-proxy.log'), 400_000));
	if (health.total === 0) {
		console.log('   ○ Memory extraction: no recent LLM calls');
	} else {
		const pct = Math.round(health.rate * 100);
		const detail = `${health.failed} of the last ${health.total} LLM calls failed (${pct}%)`;
		console.log(
			extractionUnhealthy(health)
				? `   ⚠ Memory extraction: ${detail}. Check OPENAI_MODEL (${cfg.llmModel}): documents without extracted facts stay retryable`
				: `   ● Memory extraction: ${detail}`,
		);
	}
}

async function logs(cfg: Config): Promise<boolean> {
	const files = [
		logOf(cfg, 'server'),
		logOf(cfg, 'llm-proxy'),
		logOf(cfg, 'zed-adapter'),
		path.join(cfg.gatewayDir, 'logs', 'gateway.stdout.log'),
		path.join(cfg.gatewayDir, 'logs', 'gateway.stderr.log'),
	];
	for (const key of ['StandardOutPath', 'StandardErrorPath']) {
		const r = await $`plutil -extract ${key} raw -o - ${cfg.ninerouterPlist}`.nothrow().quiet();
		if (r.exitCode === 0) files.push(r.stdout.toString().trim());
	}
	const existing = [...new Set(files)].filter((f) => f && fs.existsSync(f));
	if (existing.length === 0) {
		console.log('No log files found.');
		return true;
	}
	const proc = Bun.spawn(['tail', '-n', '50', '-f', ...existing], { stdio: ['inherit', 'inherit', 'inherit'] });
	await proc.exited;
	return true;
}

// Exit code: 0 success, 1 any selected step failed
export async function run(command: Command, cfg: Config): Promise<number> {
	const { action, targets } = command;
	let ok: boolean;
	switch (action) {
		case 'start':
			ok = await start(cfg, targets);
			break;
		case 'stop':
			ok = await stop(cfg, targets);
			break;
		case 'restart':
			// Same as the old `stop && start`: starting over a component that would not stop only trips the guard
			ok = (await stop(cfg, targets)) && (await start(cfg, targets));
			break;
		case 'status':
			ok = await status(cfg);
			break;
		case 'logs':
			ok = await logs(cfg);
			break;
	}
	return ok ? 0 : 1;
}
