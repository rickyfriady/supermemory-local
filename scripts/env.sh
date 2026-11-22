# Shared config for run.sh: loads .env, then evals the exports from src/config.ts (the one place that knows every default).
# Source it, don't run it. Needs bun on PATH (the LaunchAgents put its directory there).
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

# Defines NINEROUTER_PORT/URL, SM_PORT, LLM_PROXY_PORT, ZED_ADAPTER_PORT, LLM_UPSTREAM, DATA_DIR, OPENAI_MODEL,
# WORKFLOW_ENGINE and SUPERMEMORY_EMBEDDING_PROVIDER/MODEL/DIMENSIONS
CONFIG_EXPORTS="$(bun "$PROJECT_ROOT/src/config.ts" --shell)" || {
  echo "❌ could not read the configuration (is bun on PATH?)" >&2
  return 1
}
eval "$CONFIG_EXPORTS"
unset CONFIG_EXPORTS
