#!/usr/bin/env bash
# Runs the gateway against real Slack plus one local cc-connect behind it.
#
#   SLACK_APP_TOKEN=xapp-... SLACK_BOT_TOKEN=xoxb-... \
#   CODER_URL=https://coder.example.com CODER_SESSION_TOKEN=$(coder tokens create) \
#   OPENCODE_MODEL=provider/model ./run-local.sh
#
# CODER_SESSION_TOKEN identifies you (resolved with Coder's GET /api/v2/users/me), as
# CODER_AGENT_TOKEN does in a workspace: your DMs (by your Coder email) reach this cc-connect. Optional:
# DEFAULT_WORKSPACE (agent's starting directory, default $HOME),
# CC_CONNECT (cc-connect binary, default: cc-connect on PATH),
# PORT (default 18080).
# Thread sessions persist per workspace under ~/.local/state/ach-channelmux/.
# Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")"

: "${SLACK_APP_TOKEN:?}" "${SLACK_BOT_TOKEN:?}" "${CODER_URL:?}" "${CODER_SESSION_TOKEN:?}" "${OPENCODE_MODEL:?}"
work_dir=$(realpath "${DEFAULT_WORKSPACE:-$HOME}")
# One state dir per workspace, so changing DEFAULT_WORKSPACE never reuses a
# binding to another directory.
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/ach-channelmux/$(printf %s "$work_dir" | sha256sum | cut -c1-12)"
port=${PORT:-18080}
cc_bin=$(command -v "${CC_CONNECT:-cc-connect}")
run=$(mktemp -d)
trap 'kill 0' EXIT

cat > "$run/config.toml" <<EOF
data_dir = "$state_dir"
[log]
level = "info"

[display]
# Hide thinking and tool messages; each text segment is its own message.
mode = "compact"

[[projects]]
name = "local"
# The gateway only delivers the token owner's own DMs here, so "*" means that user.
admin_from = "*"
# Multi-workspace keeps /dir per thread; single-workspace (agent work_dir) makes it global.
mode = "multi-workspace"
base_dir = "$work_dir"
# DMs have no channel name to match a folder, so bind them here.
default_workspace = "$work_dir"
# Never rotate a thread to a fresh session after idle: a thread resumes its
# agent session (ACP session/load) however long it has been quiet.
reset_on_idle_mins = 0
# Close a thread's agent process (opencode acp + serve, ~350 MB) after 15 idle
# minutes; the next message in the thread restarts it and resumes the session.
agent_session_idle_timeout_mins = 15

[projects.agent]
type = "acp"

[projects.agent.options]
cmd = "opencode"
args = ["acp"]
env = { OPENCODE_CONFIG_CONTENT = '{"model":"${OPENCODE_MODEL}"}' }

[[projects.platforms]]
type = "slack"

[projects.platforms.options]
bot_token = "\${CODER_SESSION_TOKEN}"
app_token = "\${CODER_SESSION_TOKEN}"
base_url = "http://127.0.0.1:$port/api/"
allow_from = "*"
session_scope = "thread"
EOF

AUTH_RESOLVER_URL="${CODER_URL%/}/api/v2/users/me" AUTH_RESOLVER_HEADER=Coder-Session-Token \
  PORT=$port PUBLIC_URL="http://127.0.0.1:$port" node src/main.ts &

# Wait (max 15 s) for the gateway before starting the daemon.
for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$port/healthz" >/dev/null && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$port/healthz" >/dev/null || { echo "gateway did not start" >&2; exit 1; }

"$cc_bin" -config "$run/config.toml" &
echo "gateway :$port, cc-connect in $work_dir — DM the app in Slack. Ctrl-C to stop."
wait
