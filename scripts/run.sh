#!/usr/bin/env bash
# ========================================================
# Run one component in the foreground: scripts/run.sh <server|llm-proxy|zed-adapter>
# The LaunchAgents (written by bin/stack.ts / src/stack.ts) start components through here too, so debugging uses the same config.
# ========================================================
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$PROJECT_ROOT"
mkdir -p "$DATA_DIR"

case "${1:-}" in
  llm-proxy)
    # Forces "stream": false; 9router answers SSE otherwise and supermemory can't parse it
    exec bun src/llm-proxy.ts
    ;;
  zed-adapter)
    # Zed edit-prediction adapter (/v1/completions -> 9router /chat/completions, key from .env)
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

    # One store per embedding model: the server locks a data dir to the model that first embedded into it, so switching
    # SUPERMEMORY_EMBEDDING_MODEL/DIMENSIONS opens (or creates) that model's own store instead of failing on boot.
    # data/current points at the active store; hooks read its api-key.
    STORE_NAME="$(printf '%s-%sd' "$SUPERMEMORY_EMBEDDING_MODEL" "$SUPERMEMORY_EMBEDDING_DIMENSIONS" | tr -c 'A-Za-z0-9._-' '_')"
    STORE_DIR="$DATA_DIR/stores/$STORE_NAME"
    mkdir -p "$STORE_DIR"
    ln -sfn "stores/$STORE_NAME" "$DATA_DIR/current"
    # The server talks to the proxy, which forwards to LLM_UPSTREAM; the other values come from env.sh
    export WORKFLOW_ENGINE PORT="$SM_PORT" SUPERMEMORY_PORT="$SM_PORT" SUPERMEMORY_DATA_DIR="$STORE_DIR"
    export SUPERMEMORY_EMBEDDING_PROVIDER SUPERMEMORY_EMBEDDING_MODEL SUPERMEMORY_EMBEDDING_DIMENSIONS OPENAI_MODEL
    export OPENAI_BASE_URL="http://127.0.0.1:$LLM_PROXY_PORT"
    exec "$SM_BIN"
    ;;
  *)
    echo "Usage: $0 <server|llm-proxy|zed-adapter>" >&2
    exit 2
    ;;
esac
