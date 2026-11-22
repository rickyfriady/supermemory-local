// The one place that knows every setting and its default. Values come from the process environment, which carries `.env`
// (hooks and scripts run with --env-file / `source .env`). Every component reads this instead of `process.env.X || literal`.
// `bun src/config.ts --shell` prints the shell exports scripts/env.sh evals, so bash never repeats a default.
import os from 'node:os';
import path from 'node:path';

type Env = Record<string, string | undefined>;

export const PROJECT_ROOT = path.resolve(import.meta.dir, '..');

export const DEFAULTS = {
	NINEROUTER_PORT: '20128',
	PORT: '6767',
	LLM_PROXY_PORT: '20129',
	ZED_ADAPTER_PORT: '20130',
	SESSIONS_UI_PORT: '20131',
	SUPERMEMORY_DATA_DIR: './data',
	MCPM_GATEWAY_DIR: '../mcpm-gateway',
	SUPERMEMORY_API_KEY: 'sm_local_key',
	OPENAI_MODEL: 'ag/gemini-3.8-flash-low',
	SUPERMEMORY_EMBEDDING_PROVIDER: 'local',
	SUPERMEMORY_EMBEDDING_MODEL: 'Xenova/bge-base-en-v1.5',
	SUPERMEMORY_EMBEDDING_DIMENSIONS: '768',
	WORKFLOW_ENGINE: 'direct',
	ZED_ADAPTER_REASONING_EFFORT: 'none',
} as const;

// Settings without a default: unset means "off" or "derived", see loadConfig.
export const OPTIONAL = [
	'SUPERMEMORY_API_URL',
	'OPENAI_BASE_URL',
	'OPENAI_API_KEY',
	'TRANSLATE_MODEL',
	'SUPERMEMORY_IGNORE',
	'SUPERMEMORY_PORT',
] as const;

export interface Config {
	projectRoot: string;
	home: string;
	ninerouterPort: number;
	ninerouterUrl: string;
	smPort: number;
	smUrl: string;
	smApiKey: string;
	llmProxyPort: number;
	/** 9router (or any OpenAI-compatible) endpoint the proxy, the Zed adapter and translation call */
	llmUpstream: string;
	llmApiKey: string;
	llmModel: string;
	/** Empty = translation off */
	translateModel: string;
	zedAdapterPort: number;
	zedReasoningEffort: string;
	sessionsUiPort: number;
	embedding: { provider: string; model: string; dimensions: number };
	workflowEngine: string;
	dataDir: string;
	gatewayDir: string;
	/** Directories no hook may recall from or store to */
	ignore: RegExp | null;
	warnings: string[];
}

// Empty means default, like ${VAR:-default} in bash
const pick = (env: Env, key: keyof typeof DEFAULTS) => env[key] || DEFAULTS[key];

export function loadConfig(env: Env, projectRoot = PROJECT_ROOT, home = os.homedir()): Config {
	const warnings: string[] = [];
	const ninerouterPort = Number(pick(env, 'NINEROUTER_PORT'));
	const ninerouterUrl = `http://127.0.0.1:${ninerouterPort}/v1`;
	const smPort = Number(pick(env, 'PORT'));

	let ignore: RegExp | null = null;
	if (env.SUPERMEMORY_IGNORE?.trim()) {
		try {
			ignore = new RegExp(env.SUPERMEMORY_IGNORE.trim());
		} catch (err) {
			warnings.push(`SUPERMEMORY_IGNORE is not a valid regex, ignoring it: ${(err as Error).message}`);
		}
	}

	return {
		projectRoot,
		home,
		ninerouterPort,
		ninerouterUrl,
		smPort,
		smUrl: env.SUPERMEMORY_API_URL || `http://127.0.0.1:${smPort}`,
		smApiKey: pick(env, 'SUPERMEMORY_API_KEY'),
		llmProxyPort: Number(pick(env, 'LLM_PROXY_PORT')),
		llmUpstream: (env.OPENAI_BASE_URL || ninerouterUrl).replace(/\/$/, ''),
		llmApiKey: env.OPENAI_API_KEY ?? '',
		llmModel: pick(env, 'OPENAI_MODEL'),
		translateModel: env.TRANSLATE_MODEL?.trim() ?? '',
		zedAdapterPort: Number(pick(env, 'ZED_ADAPTER_PORT')),
		zedReasoningEffort: pick(env, 'ZED_ADAPTER_REASONING_EFFORT'),
		sessionsUiPort: Number(pick(env, 'SESSIONS_UI_PORT')),
		embedding: {
			provider: pick(env, 'SUPERMEMORY_EMBEDDING_PROVIDER'),
			model: pick(env, 'SUPERMEMORY_EMBEDDING_MODEL'),
			dimensions: Number(pick(env, 'SUPERMEMORY_EMBEDDING_DIMENSIONS')),
		},
		workflowEngine: pick(env, 'WORKFLOW_ENGINE'),
		dataDir: path.resolve(projectRoot, pick(env, 'SUPERMEMORY_DATA_DIR')),
		gatewayDir: path.resolve(projectRoot, pick(env, 'MCPM_GATEWAY_DIR')),
		ignore,
		warnings,
	};
}

/** Config of the running process: what hooks and services use */
export const currentConfig = () => loadConfig(process.env);

const quote = (v: string | number) => `'${String(v).replaceAll("'", `'\\''`)}'`;

/** `export NAME='value'` lines for the names scripts/env.sh and run.sh use (never the API key) */
export function shellExports(cfg: Config): string {
	const vars: Record<string, string | number> = {
		NINEROUTER_PORT: cfg.ninerouterPort,
		NINEROUTER_URL: cfg.ninerouterUrl,
		SM_PORT: cfg.smPort,
		LLM_PROXY_PORT: cfg.llmProxyPort,
		ZED_ADAPTER_PORT: cfg.zedAdapterPort,
		LLM_UPSTREAM: cfg.llmUpstream,
		DATA_DIR: cfg.dataDir,
		OPENAI_MODEL: cfg.llmModel,
		WORKFLOW_ENGINE: cfg.workflowEngine,
		SUPERMEMORY_EMBEDDING_PROVIDER: cfg.embedding.provider,
		SUPERMEMORY_EMBEDDING_MODEL: cfg.embedding.model,
		SUPERMEMORY_EMBEDDING_DIMENSIONS: cfg.embedding.dimensions,
	};
	return Object.entries(vars)
		.map(([k, v]) => `export ${k}=${quote(v)}`)
		.join('\n');
}

if (import.meta.main && process.argv[2] === '--shell') {
	const cfg = currentConfig();
	for (const w of cfg.warnings) console.error(`config: ${w}`);
	console.log(shellExports(cfg));
}
