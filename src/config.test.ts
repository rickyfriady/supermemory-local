import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, loadConfig, OPTIONAL, shellExports } from './config.ts';

const load = (env = {}) => loadConfig(env, '/repo/sm', '/home/me');

test('defaults', () => {
	const c = load();
	expect(c.ninerouterUrl).toBe('http://127.0.0.1:20128/v1');
	expect([c.smPort, c.llmProxyPort, c.zedAdapterPort, c.sessionsUiPort]).toEqual([6767, 20129, 20130, 20131]);
	expect(c.smUrl).toBe('http://127.0.0.1:6767');
	expect(c.llmUpstream).toBe('http://127.0.0.1:20128/v1');
	expect(c.llmModel).toBe('ag/gemini-3.8-flash-low');
	expect(c.translateModel).toBe('');
	expect(c.embedding).toEqual({ provider: 'local', model: 'Xenova/bge-base-en-v1.5', dimensions: 768 });
	expect(c.dataDir).toBe('/repo/sm/data');
	expect(c.gatewayDir).toBe('/repo/mcpm-gateway');
	expect(c.ignore).toBeNull();
});

test('overrides, empty means default, trailing slash trimmed', () => {
	const c = load({ PORT: '7000', NINEROUTER_PORT: '', OPENAI_BASE_URL: 'http://x/v1/', TRANSLATE_MODEL: ' m ' });
	expect(c.smPort).toBe(7000);
	expect(c.smUrl).toBe('http://127.0.0.1:7000');
	expect(c.ninerouterPort).toBe(20128);
	expect(c.llmUpstream).toBe('http://x/v1');
	expect(c.translateModel).toBe('m');
});

test('relative paths resolve against the repo root, absolute ones stay', () => {
	const c = load({ SUPERMEMORY_DATA_DIR: './var/data', MCPM_GATEWAY_DIR: '../tools/gw' });
	expect([c.dataDir, c.gatewayDir]).toEqual(['/repo/sm/var/data', '/repo/tools/gw']);
	expect(load({ MCPM_GATEWAY_DIR: '/opt/gw' }).gatewayDir).toBe('/opt/gw');
});

test('SUPERMEMORY_IGNORE compiles; an invalid regex is dropped with a warning', () => {
	expect(load({ SUPERMEMORY_IGNORE: 'Library/Application Support' }).ignore?.test('/h/Library/Application Support/x')).toBe(true);
	const bad = load({ SUPERMEMORY_IGNORE: '(' });
	expect(bad.ignore).toBeNull();
	expect(bad.warnings).toHaveLength(1);
});

test('shell exports quote single quotes and never carry the api key', () => {
	const out = shellExports(load({ OPENAI_API_KEY: 'secret', SUPERMEMORY_DATA_DIR: "/d/it's" }));
	expect(out).toContain(`export DATA_DIR='/d/it'\\''s'`);
	expect(out).toContain("export SM_PORT='6767'");
	expect(out).not.toContain('secret');
});

test('.env.example documents every setting the config reads', () => {
	const keys = new Set(
		fs
			.readFileSync(path.resolve(import.meta.dir, '../.env.example'), 'utf-8')
			.split('\n')
			.map((l) => l.match(/^#?\s*([A-Z][A-Z0-9_]+)=/)?.[1])
			.filter(Boolean),
	);
	for (const k of [...Object.keys(DEFAULTS), ...OPTIONAL]) expect(keys.has(k)).toBe(true);
});
