#!/usr/bin/env bash
# ========================================================
# Check Status of Supermemory Local & 9router
# Exit code: 0 only when the memory API and the LLM proxy both answer (usable as a health check)
# ========================================================
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

HEALTHY=1

echo "========================================================"
echo " Supermemory Local & 9router Status"
echo "========================================================"

# 1. 9router Status
echo "1. 9router Status:"
if curl -s --connect-timeout 2 "$NINEROUTER_URL/models" >/dev/null 2>&1; then
  echo "   ● Gateway: Running on http://127.0.0.1:${NINEROUTER_PORT}"
  MODEL_COUNT=$(curl -s "$NINEROUTER_URL/models" | grep -o '"id":' | wc -l | tr -d ' ' || echo "0")
  echo "   ● Available Models: $MODEL_COUNT models detected"
  echo "   ● Configured Model: ${OPENAI_MODEL:-ag/gemini-3.8-flash-low}"
else
  echo "   ○ Gateway: NOT running (Expected port $NINEROUTER_PORT)"
fi

if curl -s --connect-timeout 2 "http://127.0.0.1:$LLM_PROXY_PORT/models" >/dev/null 2>&1; then
  echo "   ● LLM proxy: Running on http://127.0.0.1:$LLM_PROXY_PORT (stream:false + embedding dimensions)"
else
  echo "   ○ LLM proxy: NOT running (supermemory memory generation will fail)"
  HEALTHY=0
fi
if curl -s --connect-timeout 2 "http://127.0.0.1:$ZED_ADAPTER_PORT/v1/completions" >/dev/null 2>&1; then
  echo "   ● Zed adapter: Running on http://127.0.0.1:$ZED_ADAPTER_PORT/v1/completions"
else
  echo "   ○ Zed adapter: NOT running (Zed edit predictions will fail)"
fi
echo ""

# 2. Supermemory Status
echo "2. Supermemory Status:"
if curl -s --connect-timeout 2 "http://localhost:$SM_PORT/v4/search" \
  -H "Content-Type: application/json" \
  -d '{"q":"ping","limit":1}' >/dev/null 2>&1; then
  echo "   ● HTTP API: Healthy on http://localhost:$SM_PORT"
  echo "   ● Storage:  $DATA_DIR/$(readlink "$DATA_DIR/current" 2>/dev/null || echo "?")"
  echo "   ● Stores:   $(ls "$DATA_DIR/stores" 2>/dev/null | tr '\n' ' ')"
  echo "   ● Embeddings: ${SUPERMEMORY_EMBEDDING_MODEL:-Xenova/bge-base-en-v1.5} (${SUPERMEMORY_EMBEDDING_PROVIDER:-local}), translate: ${TRANSLATE_MODEL:-off}"
else
  echo "   ○ HTTP API: Not responding on port $SM_PORT"
  HEALTHY=0
fi
echo ""

# 3. LaunchAgents
echo "3. LaunchAgents:"
for c in server llm-proxy zed-adapter; do
  LABEL="com.supermemory-local.$c"
  if INFO="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null)"; then
    echo "   ● $LABEL: loaded ($(echo "$INFO" | awk '/^[[:space:]]+pid = / {print "PID " $3; exit}'))"
  else
    echo "   ○ $LABEL: not loaded (start with: bun run start)"
  fi
done

echo "========================================================"
[ "$HEALTHY" -eq 1 ]
