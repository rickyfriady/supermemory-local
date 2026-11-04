#!/usr/bin/env bash
# ========================================================
# Controller for the LaunchAgents: scripts/service.sh <start|stop|restart|status|logs>
# launchd keeps each component alive across crashes and logins. stop lasts until the next login or start.
# ========================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/env.sh"

COMPONENTS="llm-proxy zed-adapter server"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

label() { echo "com.supermemory-local.$1"; }
plist() { echo "$LAUNCH_AGENTS_DIR/$(label "$1").plist"; }
is_loaded() { launchctl print "$DOMAIN/$(label "$1")" >/dev/null 2>&1; }

port_of() {
  case "$1" in
    server) echo "$SM_PORT" ;;
    llm-proxy) echo "$LLM_PROXY_PORT" ;;
    zed-adapter) echo "$ZED_ADAPTER_PORT" ;;
  esac
}

log_of() {
  case "$1" in
    server) echo "$DATA_DIR/supermemory.log" ;;
    *) echo "$DATA_DIR/$1.log" ;;
  esac
}

# lsof exits 1 when the port is free, which pipefail + set -e would turn into a silent exit
port_holder() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1 " (PID: " $2 ")"}' || true; }

write_plist() {
  local bun_dir
  bun_dir="$(dirname "$(command -v bun)")"
  cat > "$(plist "$1")" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$(label "$1")</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PROJECT_ROOT/scripts/run.sh</string>
        <string>$1</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$bun_dir:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>$PROJECT_ROOT</string>
    <key>StandardOutPath</key>
    <string>$(log_of "$1")</string>
    <key>StandardErrorPath</key>
    <string>$(log_of "$1")</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
PLIST
}

check_router() {
  if curl -s --connect-timeout 2 "$NINEROUTER_URL/models" >/dev/null 2>&1; then
    echo "✓ 9router answering at $NINEROUTER_URL"
  else
    echo "⚠ 9router is not answering at $NINEROUTER_URL, memory extraction will fail until it is up."
    echo "  Start it with: launchctl kickstart $DOMAIN/com.9router.autostart"
  fi
}

start() {
  command -v bun >/dev/null 2>&1 || { echo "❌ bun not found on PATH" >&2; exit 1; }

  # Single-runtime guard: a second copy could not bind, and KeepAlive would crash-loop it
  local c holder
  for c in $COMPONENTS; do
    is_loaded "$c" && continue
    holder="$(port_holder "$(port_of "$c")")"
    if [ -n "$holder" ]; then
      echo "❌ Port $(port_of "$c") ($c) is already in use by: $holder" >&2
      echo "Stop that process first. No LaunchAgent was loaded." >&2
      exit 1
    fi
  done

  check_router
  mkdir -p "$LAUNCH_AGENTS_DIR" "$DATA_DIR"
  for c in $COMPONENTS; do
    if is_loaded "$c"; then
      echo "✓ $c already loaded"
    else
      write_plist "$c"
      launchctl bootstrap "$DOMAIN" "$(plist "$c")"
      echo "→ Loaded $(label "$c")"
    fi
  done

  # The server loads its embedding model at boot, so give it a while
  local failed=0 i
  for c in $COMPONENTS; do
    for i in {1..60}; do
      [ -n "$(port_holder "$(port_of "$c")")" ] && break
      sleep 1
    done
    if [ -n "$(port_holder "$(port_of "$c")")" ]; then
      echo "✓ $c listening on port $(port_of "$c")"
    else
      echo "❌ $c did not bind port $(port_of "$c"). Check: $(log_of "$c")" >&2
      failed=1
    fi
  done
  return "$failed"
}

stop() {
  local c failed=0 i
  for c in $COMPONENTS; do
    is_loaded "$c" && launchctl bootout "$DOMAIN/$(label "$c")" 2>/dev/null || true
  done
  # bootout returns before the process is gone; a start right after would hit "Input/output error" or a busy port
  for c in $COMPONENTS; do
    for i in {1..60}; do
      ! is_loaded "$c" && [ -z "$(port_holder "$(port_of "$c")")" ] && break
      sleep 0.5
    done
    if is_loaded "$c" || [ -n "$(port_holder "$(port_of "$c")")" ]; then
      echo "⚠ $c still running: port $(port_of "$c") held by $(port_holder "$(port_of "$c")")" >&2
      failed=1
    else
      echo "✓ $c stopped"
    fi
  done
  return "$failed"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop && start ;;
  status) exec "$SCRIPT_DIR/status.sh" ;;
  logs) exec tail -n 50 -f "$(log_of server)" "$(log_of llm-proxy)" "$(log_of zed-adapter)" ;;
  *)
    echo "Usage: $0 <start|stop|restart|status|logs>" >&2
    exit 2
    ;;
esac
