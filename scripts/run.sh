#!/usr/bin/env bash
# ========================================================
# Run one component in the foreground: scripts/run.sh <server|llm-proxy|zed-adapter>
# The LaunchAgents (scripts/service.sh) start components through here too, so debugging uses the same config.
# ========================================================
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$PROJECT_ROOT"
mkdir -p "$DATA_DIR"

case "${1:-}" in
  llm-proxy)
    # Forces "stream": false; 9router answers SSE otherwise and supermemory can't parse it
    export OPENAI_BASE_URL="$LLM_UPSTREAM" LLM_PROXY_PORT
    export SUPERMEMORY_EMBEDDING_DIMENSIONS="${SUPERMEMORY_EMBEDDING_DIMENSIONS:-768}"
    exec bun src/llm-proxy.ts
    ;;
  zed-adapter)
    # Zed edit-prediction adapter (/v1/completions -> 9router /chat/completions, key from .env)
    export OPENAI_BASE_URL="$LLM_UPSTREAM" ZED_ADAPTER_PORT
    exec bun src/zed-adapter.ts
    ;;
  server)
    if [ -z "${OPENAI_API_KEY:-}" ]; then
      echo "❌ OPENAI_API_KEY is not set (copy .env.example to .env)" >&2
      exit 1
    fi

    SM_BIN=""
    if [ -x "$HOME/.supermemory/bin/supermemory-server" ]; then
      SM_BIN="$HOME/.supermemory/bin/supermemory-server"
    elif [ -x "$HOME/.local/bin/supermemory-server" ]; then
      SM_BIN="$HOME/.local/bin/supermemory-server"
    elif command -v supermemory-server >/dev/null 2>&1; then
      SM_BIN="$(command -v supermemory-server)"
    else
      echo "❌ supermemory-server binary not found! Please run: curl -fsSL https://supermemory.ai/install | bash" >&2
      exit 1
    fi

    export SUPERMEMORY_EMBEDDING_PROVIDER="${SUPERMEMORY_EMBEDDING_PROVIDER:-local}"
    export SUPERMEMORY_EMBEDDING_MODEL="${SUPERMEMORY_EMBEDDING_MODEL:-Xenova/bge-base-en-v1.5}"
    export SUPERMEMORY_EMBEDDING_DIMENSIONS="${SUPERMEMORY_EMBEDDING_DIMENSIONS:-768}"
    # One store per embedding model: the server locks a data dir to the model that first embedded into it, so switching
    # SUPERMEMORY_EMBEDDING_MODEL/DIMENSIONS opens (or creates) that model's own store instead of failing on boot.
    # data/current points at the active store; hooks read its api-key.
    STORE_NAME="$(printf '%s-%sd' "$SUPERMEMORY_EMBEDDING_MODEL" "$SUPERMEMORY_EMBEDDING_DIMENSIONS" | tr -c 'A-Za-z0-9._-' '_')"
    STORE_DIR="$DATA_DIR/stores/$STORE_NAME"
    mkdir -p "$STORE_DIR"
    ln -sfn "stores/$STORE_NAME" "$DATA_DIR/current"
    export WORKFLOW_ENGINE="${WORKFLOW_ENGINE:-direct}"
    export PORT="$SM_PORT"
    export SUPERMEMORY_PORT="$SM_PORT"
    export SUPERMEMORY_DATA_DIR="$STORE_DIR"
    export OPENAI_BASE_URL="http://127.0.0.1:$LLM_PROXY_PORT"
    export OPENAI_MODEL="${OPENAI_MODEL:-ag/gemini-3.8-flash-low}"
    exec "$SM_BIN"
    ;;
  *)
    echo "Usage: $0 <server|llm-proxy|zed-adapter>" >&2
    exit 2
    ;;
esac
