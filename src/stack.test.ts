// Unit checks for the stack controller's pure core (no launchctl, lsof or network): bun test
import { expect, test } from 'bun:test';
import {
	descendants,
	loadConfig,
	orderTargets,
	parseCommand,
	parseLaunchdPid,
	parseLsofHolder,
	renderPlist,
	summarizeServers,
} from './stack.ts';

const targetsOf = (argv: string[]) => {
	const r = parseCommand(argv);
	if (!r.ok) throw new Error(r.error);
	return [...r.command.targets].sort();
};
const usageError = (argv: string[]) => {
	const r = parseCommand(argv);
	return r.ok ? null : r.error;
};

test('loadConfig defaults', () => {
	const cfg = loadConfig({}, '/repo/supermemory-local', '/home/me');
	expect(cfg.ninerouterPort).toBe(20128);
	expect(cfg.ninerouterUrl).toBe('http://127.0.0.1:20128/v1');
	expect(cfg.smPort).toBe(6767);
	expect(cfg.llmProxyPort).toBe(20129);
	expect(cfg.zedAdapterPort).toBe(20130);
	expect(cfg.dataDir).toBe('/repo/supermemory-local/data');
	expect(cfg.gatewayDir).toBe('/repo/mcpm-gateway');
	expect(cfg.ninerouterPlist).toBe('/home/me/Library/LaunchAgents/com.9router.autostart.plist');
});

test('loadConfig resolves relative paths against the repo root and keeps absolute ones', () => {
	const rel = loadConfig({ MCPM_GATEWAY_DIR: '../tools/gw', SUPERMEMORY_DATA_DIR: './var/data', PORT: '7000' }, '/repo/sm', '/h');
	expect(rel.gatewayDir).toBe('/repo/tools/gw');
	expect(rel.dataDir).toBe('/repo/sm/var/data');
	expect(rel.smPort).toBe(7000);
	expect(loadConfig({ MCPM_GATEWAY_DIR: '/opt/gw' }, '/repo/sm', '/h').gatewayDir).toBe('/opt/gw');
	// Empty means default, like ${VAR:-default} in bash
	expect(loadConfig({ NINEROUTER_PORT: '' }, '/repo/sm', '/h').ninerouterPort).toBe(20128);
});

test('parseCommand defaults per action', () => {
	expect(targetsOf(['start'])).toEqual(['9router', 'gateway', 'memory']);
	expect(targetsOf(['stop'])).toEqual(['gateway', 'memory']);
	expect(targetsOf(['restart'])).toEqual(['memory']);
	expect(targetsOf(['status'])).toEqual([]);
	expect(targetsOf(['logs'])).toEqual([]);
});

test('parseCommand selectors: --all and unions', () => {
	expect(targetsOf(['stop', '--all'])).toEqual(['9router', 'gateway', 'memory']);
	expect(targetsOf(['stop', '--gateway', '--9router'])).toEqual(['9router', 'gateway']);
	expect(targetsOf(['restart', '--gateway'])).toEqual(['gateway']);
	expect(targetsOf(['--memory', 'start'])).toEqual(['memory']);
});

test('parseCommand usage errors', () => {
	expect(usageError(['stop', '--9routr'])).not.toBeNull();
	expect(usageError(['status', '--gateway'])).not.toBeNull();
	expect(usageError(['logs', '--all'])).not.toBeNull();
	expect(usageError([])).not.toBeNull();
	expect(usageError(['--memory'])).not.toBeNull();
	expect(usageError(['launch'])).not.toBeNull();
	expect(usageError(['stop', 'now'])).not.toBeNull();
	expect(usageError(['stop', '--memory=yes'])).not.toBeNull();
});

test('orderTargets', () => {
	const all = new Set(['9router', 'memory', 'gateway'] as const);
	expect(orderTargets('start', all)).toEqual(['9router', 'memory', 'gateway']);
	expect(orderTargets('stop', all)).toEqual(['gateway', 'memory', '9router']);
	expect(orderTargets('start', new Set(['gateway', '9router'] as const))).toEqual(['9router', 'gateway']);
	expect(orderTargets('stop', new Set(['memory'] as const))).toEqual(['memory']);
});

test('memory components stop in reverse start order', async () => {
	const { MEMORY_START_ORDER, MEMORY_STOP_ORDER } = await import('./stack.ts');
	expect(MEMORY_START_ORDER).toEqual(['llm-proxy', 'zed-adapter', 'server']);
	expect(MEMORY_STOP_ORDER).toEqual(['server', 'zed-adapter', 'llm-proxy']);
});

test('parseLaunchdPid', () => {
	const print = `gui/501/com.9router.autostart = {
	active count = 1
	path = /Users/me/Library/LaunchAgents/com.9router.autostart.plist
	type = LaunchAgent
	state = running

	program = /opt/homebrew/bin/node
	pid = 845
	immediate reason = speculative
	last exit code = (never exited)
}`;
	expect(parseLaunchdPid(print)).toBe(845);
	expect(parseLaunchdPid(print.replace('\tpid = 845\n', ''))).toBeNull();
	expect(parseLaunchdPid('')).toBeNull();
});

test('parseLsofHolder', () => {
	expect(parseLsofHolder('COMMAND    PID        USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n')).toBeNull();
	expect(parseLsofHolder('')).toBeNull();
	expect(
		parseLsofHolder(
			'COMMAND    PID        USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnext-serv 1380 rickifriadi   14u  IPv4 0x1      0t0  TCP *:20128 (LISTEN)\n',
		),
	).toBe('next-serv (PID: 1380)');
});

test('descendants walks the whole tree and nothing else', () => {
	const ps = `    1     0
  845     1
 1380   845
 1384   845
 1400  1380
 2000     1
 2001  2000
  900   844
`;
	expect(descendants(845, ps).sort((a, b) => a - b)).toEqual([1380, 1384, 1400]);
	expect(descendants(1400, ps)).toEqual([]);
	expect(descendants(9999, ps)).toEqual([]);
});

const PLIST_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.supermemory-local.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/HOME/dev/personal/supermemory-local/scripts/run.sh</string>
        <string>server</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>/HOME</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>/HOME/dev/personal/supermemory-local</string>
    <key>StandardOutPath</key>
    <string>/HOME/dev/personal/supermemory-local/data/supermemory.log</string>
    <key>StandardErrorPath</key>
    <string>/HOME/dev/personal/supermemory-local/data/supermemory.log</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
`;

test('renderPlist matches the LaunchAgent written by the old bash controller', () => {
	const root = '/HOME/dev/personal/supermemory-local';
	const text = renderPlist({
		label: 'com.supermemory-local.server',
		runSh: `${root}/scripts/run.sh`,
		component: 'server',
		pathEnv: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
		home: '/HOME',
		projectRoot: root,
		logFile: `${root}/data/supermemory.log`,
	});
	expect(text).toBe(PLIST_FIXTURE);
});

test('renderPlist escapes XML special characters', () => {
	const text = renderPlist({
		label: 'com.supermemory-local.llm-proxy',
		runSh: '/x/R&D/scripts/run.sh',
		component: 'llm-proxy',
		pathEnv: '/bin',
		home: '/x',
		projectRoot: '/x/R&D',
		logFile: '/x/R&D/data/llm-proxy.log',
	});
	expect(text).toContain('<string>/x/R&amp;D/scripts/run.sh</string>');
	expect(text).not.toContain('R&D');
});

test('summarizeServers', () => {
	const yaml = `profile: core
servers:
  context7:
    command: npx
    args:
    - -y
    - '@upstash/context7-mcp@4.5.0'
    type: stdio
  filesystem:
    command: node
    env:
      npm_config_registry: https://registry.npmjs.org
    type: stdio
  supermemory:
    command: bun
    type: stdio
`;
	expect(summarizeServers(yaml)).toEqual({ profile: 'core', servers: ['context7', 'filesystem', 'supermemory'] });
	expect(() => summarizeServers('profile: [unclosed')).toThrow();
	expect(() => summarizeServers('- just\n- a list\n')).toThrow();
});
