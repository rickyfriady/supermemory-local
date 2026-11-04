# Shared config for run.sh, service.sh and status.sh: loads .env and derives ports and paths. Source it, don't run it.
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

NINEROUTER_PORT="${NINEROUTER_PORT:-20128}"
NINEROUTER_URL="http://127.0.0.1:${NINEROUTER_PORT}/v1"
SM_PORT="${PORT:-6767}"
LLM_PROXY_PORT="${LLM_PROXY_PORT:-20129}"
ZED_ADAPTER_PORT="${ZED_ADAPTER_PORT:-20130}"
LLM_UPSTREAM="${OPENAI_BASE_URL:-$NINEROUTER_URL}"
DATA_DIR="${SUPERMEMORY_DATA_DIR:-./data}"
[[ "$DATA_DIR" = /* ]] || DATA_DIR="$PROJECT_ROOT/${DATA_DIR#./}"
