#!/usr/bin/env bash
# Runs the relay against real Slack plus one local daemon (from source) behind it.
#
#   SLACK_APP_TOKEN=xapp-... SLACK_BOT_TOKEN=xoxb-... \
#   CODER_URL=https://coder.example.com CODER_SESSION_TOKEN=$(coder tokens create) \
#   ./run-local.sh
#
# CODER_SESSION_TOKEN identifies you (resolved with Coder's GET /api/v2/users/me), as
# CODER_AGENT_TOKEN does in a workspace: your DMs (by your Coder email) reach this daemon.
# Optional: BASE_DIR (folders offered by the picker, default $HOME), AGENT_CMD (default
# "opencode acp"), PORT (default 18080).
# Thread sessions persist in ~/.local/state/ach-channelmux/threads.json.
# Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")"

: "${SLACK_APP_TOKEN:?}" "${SLACK_BOT_TOKEN:?}" "${CODER_URL:?}" "${CODER_SESSION_TOKEN:?}"
port=${PORT:-18080}
trap 'kill 0' EXIT

AUTH_RESOLVER_URL="${CODER_URL%/}/api/v2/users/me" AUTH_RESOLVER_HEADER=Coder-Session-Token \
  PORT=$port PUBLIC_URL="http://127.0.0.1:$port" node relay/src/main.ts &

# Wait (max 15 s) for the relay before starting the daemon.
for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$port/healthz" >/dev/null && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$port/healthz" >/dev/null || { echo "relay did not start" >&2; exit 1; }

RELAY_URL="http://127.0.0.1:$port" RELAY_TOKEN=$CODER_SESSION_TOKEN BASE_DIR=${BASE_DIR:-$HOME} \
  node daemon/src/main.ts &
echo "relay :$port, daemon on ${BASE_DIR:-$HOME} — DM the app in Slack. Ctrl-C to stop."
wait
