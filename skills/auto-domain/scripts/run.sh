#!/usr/bin/env bash
# auto-domain unified runner

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CACHE_DIR="$HOME/.auto-domain"
CONFIG_FILE="$CACHE_DIR/config"
LOG_FILE="$CACHE_DIR/agent.log"
PID_FILE="$CACHE_DIR/agent.pid"
AUTO_DOMAIN_SERVER="${AUTO_DOMAIN_SERVER:-wss://tunnel-api.chxyka.ccwu.cc}"
AGENT_URL="${AGENT_URL:-https://skill.vyibc.com/agent.js}"

if [[ -f "$SKILL_DIR/agent/agent.js" ]]; then
  AGENT_DIR="$SKILL_DIR/agent"
  AGENT_JS="$AGENT_DIR/agent.js"
  AGENT_PKG="$AGENT_DIR/package.json"
  AGENT_MODE="installed-skill"
else
  AGENT_DIR="$CACHE_DIR"
  AGENT_JS="$CACHE_DIR/agent.js"
  AGENT_PKG="$CACHE_DIR/package.json"
  AGENT_MODE="direct-cli"
fi

mkdir -p "$CACHE_DIR"

PORT=""
NAME=""
TOKEN=""
METADATA=""
RESET=0
DAEMON=0
STOP=0
REPLACE=0
AUTO_NAME=0

for arg in "$@"; do
  case "$arg" in
    --port=*) PORT="${arg#--port=}" ;;
    --name=*) NAME="${arg#--name=}" ;;
    --token=*) TOKEN="${arg#--token=}" ;;
    --metadata=*) METADATA="${arg#--metadata=}" ;;
    -m=*) METADATA="${arg#-m=}" ;;
    --reset) RESET=1 ;;
    --daemon|-d) DAEMON=1 ;;
    --stop) STOP=1 ;;
    --replace) REPLACE=1 ;;
    --auto-name) AUTO_NAME=1 ;;
    -h|--help)
      echo "Usage: $0 --port=3000 [--name=myapp] [--token=xxx] [--metadata=json] [--daemon] [--stop] [--reset] [--replace] [--auto-name]"
      echo "  --token       optional; kept for compatibility when a server token is issued"
      echo "  --metadata    optional JSON metadata stored in tunnel-admin"
      echo "  --replace     replace existing tunnel for the same name (server-side)"
      echo "  --auto-name   server appends a random 4-digit suffix to --name (guarantees uniqueness)"
      exit 0
      ;;
  esac
done

if [[ "$STOP" == "1" ]]; then
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")"
    rm -f "$PID_FILE"
    echo "auto-domain agent stopped."
  else
    echo "No running agent found."
  fi
  exit 0
fi

if [[ "$RESET" == "1" ]]; then
  rm -rf "$CACHE_DIR"
  mkdir -p "$CACHE_DIR"
fi

[[ -f "$CONFIG_FILE" ]] && source "$CONFIG_FILE" 2>/dev/null || true

if [[ -z "$TOKEN" ]]; then
  TOKEN="${AUTO_DOMAIN_TOKEN:-}"
fi

# Token is optional for the current tunnel service. If one is provided, keep it
# in local config so older deployments and future token-enabled servers still work.
if [[ -n "$TOKEN" ]]; then
  echo "AUTO_DOMAIN_TOKEN=$TOKEN" > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
fi

if [[ -z "$PORT" ]]; then
  read -rp "Local port (default 3000): " PORT
  PORT="${PORT:-3000}"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >= 18 is required" >&2; exit 1
fi

NODE_VER=$(node -e "process.stdout.write(process.version.replace('v','').split('.')[0])")
if [[ "$NODE_VER" -lt 18 ]]; then
  echo "Node.js >= 18 is required" >&2; exit 1
fi

if [[ "$AGENT_MODE" == "direct-cli" ]]; then
  curl -fsSL "${AGENT_URL}?v=$(date +%s)" -o "$AGENT_JS"
fi

if [[ ! -f "$AGENT_PKG" ]]; then
  cat > "$AGENT_PKG" <<'EOF'
{"name":"auto-domain-agent","private":true,"dependencies":{"ws":"^8.18.0"}}
EOF
fi

if [[ ! -d "$AGENT_DIR/node_modules/ws" ]]; then
  echo "Installing auto-domain agent dependencies..."
  (cd "$AGENT_DIR" && npm install --silent --prefer-offline)
fi

ARGS=("--port=$PORT")
[[ -n "$TOKEN" ]] && ARGS+=("--token=$TOKEN")
[[ -n "$NAME" ]] && ARGS+=("--name=$NAME")
[[ -n "$METADATA" ]] && ARGS+=("--metadata=$METADATA")
[[ "$REPLACE" == "1" ]] && ARGS+=("--replace")
[[ "$AUTO_NAME" == "1" ]] && ARGS+=("--auto-name")
[[ -n "${AUTO_DOMAIN_SERVER:-}" ]] && ARGS+=("--server=$AUTO_DOMAIN_SERVER")

if [[ "$DAEMON" == "1" ]]; then
  # ── 幂等检查：同名 tunnel 已在运行，直接返回 URL ──────────────────────────
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    EXPECTED_URL="https://${NAME}.chxyka.ccwu.cc"
    if [[ -n "$NAME" ]] && grep -q "$EXPECTED_URL" "$LOG_FILE" 2>/dev/null; then
      URL=$(grep "Public URL" "$LOG_FILE" | tail -1 | sed 's/.*Public URL[[:space:]]*:[[:space:]]*//')
      echo ""
      echo "Tunnel already running!"
      echo "   Public URL : $URL"
      echo "   Forwarding : $URL -> http://localhost:$PORT"
      echo "   Logs       : tail -f $LOG_FILE"
      echo "   Stop       : bash <(curl -fsSL https://skill.vyibc.com/auto-domain.sh) --stop"
      exit 0
    fi

    echo "Stopping existing agent (PID: $(cat "$PID_FILE"))..."
    kill "$(cat "$PID_FILE")"
    sleep 1
  fi

  > "$LOG_FILE"
  setsid node "$AGENT_JS" "${ARGS[@]}" >> "$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$PID_FILE"

  echo "Agent started in background (PID: $(cat "$PID_FILE"))..."
  echo "Waiting for tunnel to come online..."

  for i in $(seq 1 40); do
    if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo ""
      echo "Error: auto-domain agent exited before tunnel came online."
      echo "Log: $LOG_FILE"
      tail -n 80 "$LOG_FILE" 2>/dev/null || true
      rm -f "$PID_FILE"
      exit 1
    fi

    # 成功：打印 URL
    if grep -q "Public URL" "$LOG_FILE" 2>/dev/null; then
      sleep 1
      if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo ""
        echo "Error: auto-domain agent exited after reporting a public URL."
        echo "Log: $LOG_FILE"
        tail -n 80 "$LOG_FILE" 2>/dev/null || true
        rm -f "$PID_FILE"
        exit 1
      fi
      URL=$(grep "Public URL" "$LOG_FILE" | tail -1 | sed 's/.*Public URL[[:space:]]*:[[:space:]]*//')
      echo ""
      echo "Tunnel is live!"
      echo "   Public URL : $URL"
      echo "   Forwarding : $URL -> http://localhost:$PORT"
      echo "   Logs       : tail -f $LOG_FILE"
      echo "   Stop       : bash <(curl -fsSL https://skill.vyibc.com/auto-domain.sh) --stop"
      exit 0
    fi
    # 失败：域名被占用（409）
    if grep -q "response: 409\|already in use\|Name Conflict" "$LOG_FILE" 2>/dev/null; then
      echo ""
      echo "Error: subdomain '$NAME' is already in use by another agent."
      echo "   Use a different --name, or pass --auto-name to get a random suffix appended."
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
      rm -f "$PID_FILE"
      exit 2
    fi
    # 失败：token 无效（401）
    if grep -q "response: 401\|Unauthorized" "$LOG_FILE" 2>/dev/null; then
      echo ""
      echo "Error: invalid token. Check your --token value."
      kill "$(cat "$PID_FILE")" 2>/dev/null
      rm -f "$PID_FILE"
      exit 1
    fi
    sleep 0.5
  done

  echo "Timed out waiting for tunnel. Check: tail -f $LOG_FILE"
  exit 1
else
  echo "Connecting auto-domain..."
  exec node "$AGENT_JS" "${ARGS[@]}"
fi
