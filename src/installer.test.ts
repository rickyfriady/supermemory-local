import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { antigravityHooks, pluginSource } from './installer.ts';

const cmd = (agent: string, action: string) => ({ type: 'command', command: `hook ${agent} ${action}` });

test('agy hooks: session start recall once, per-turn sync, change and stop', () => {
	const hooks = antigravityHooks(cmd);
	expect(hooks.enabled).toBe(true);
	expect(hooks.SessionStart).toEqual([cmd('antigravity', 'start')]);
	expect(hooks.PreInvocation).toEqual([cmd('antigravity', 'sync')]);
	expect(hooks.PostToolUse[0].hooks).toEqual([cmd('antigravity', 'change')]);
	expect(hooks.Stop).toEqual([cmd('antigravity', 'stop')]);
});

const template = fs.readFileSync(path.join(import.meta.dir, 'opencode-plugin.ts'), 'utf-8');

test('plugin installer rewrites HOOK_CMD with absolute paths and nothing else', () => {
	const out = pluginSource(template, ['/opt/homebrew/bin/bun', '--env-file=/r/.env', '/r/bin/supermemory-hook.ts']);
	expect(out).toContain('const HOOK_CMD = ["/opt/homebrew/bin/bun","--env-file=/r/.env","/r/bin/supermemory-hook.ts"];');
	expect(out.replace(/const HOOK_CMD = [^;]*;/, '')).toBe(template.replace(/const HOOK_CMD = [^;]*;/, ''));
});

test('plugin has the v2 shape: default export with id and setup, no package import', () => {
	expect(template).toMatch(/export default \{\s*id: 'supermemory-local',\s*async setup\(/);
	expect(template).not.toMatch(/^import /m);
	expect(template).toContain("ctx.session.hook('prompt'");
	expect(template).toContain("ctx.session.hook('context'");
	expect(template).toContain("ctx.tool.hook('execute.after'");
});
