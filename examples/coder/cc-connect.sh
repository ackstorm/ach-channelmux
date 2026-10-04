#!/usr/bin/env bash
# The workspace owner's coding agent in Slack: cc-connect behind ach-channelmux.
# Run by a coder_script on every workspace start (see README.md here). Needs
# CODER_AGENT_TOKEN (set by Coder), ACH_CHANNELMUX_URL and CC_CONNECT_MODEL
# (OpenCode model id, provider/model) in the agent env. Log: /tmp/cc-connect.log
set -euo pipefail

VERSION=v1.5.1-beta.1-ackstorm.1
WORKSPACE_DIR=${CC_CONNECT_WORKSPACE:-/workspace}

: "${CODER_AGENT_TOKEN:?}" "${ACH_CHANNELMUX_URL:?}" "${CC_CONNECT_MODEL:?}"
bin=$HOME/.local/bin/cc-connect
conf=$HOME/.cc-connect/config.toml
log=/tmp/cc-connect.log

case $(uname -m) in
  x86_64) arch=amd64 ;;
  aarch64) arch=arm64 ;;
  *) echo "cc-connect: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

if [ "$("$bin" --version 2>/dev/null | head -1)" != "cc-connect $VERSION" ]; then
  name=cc-connect-$VERSION-linux-$arch
  url=https://github.com/ackstorm/cc-connect/releases/download/$VERSION
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/$name" "$url/$name"
  curl -fsSL --retry 3 -o "$tmp/checksums.txt" "$url/checksums.txt"
  (cd "$tmp" && grep " $name\$" checksums.txt | sha256sum -c --quiet -)
  mkdir -p "$(dirname "$bin")"
  install -m 0755 "$tmp/$name" "$bin"
  rm -rf "$tmp"
fi

# Rewritten on every start. The tokens stay ${...} placeholders that
# cc-connect expands from the env, so they never touch the disk.
mkdir -p "$(dirname "$conf")"
cat > "$conf" <<EOF
data_dir = "$HOME/.local/state/cc-connect"

[display]
# Hide thinking and tool messages; each text segment is its own message.
mode = "compact"

[[projects]]
name = "workspace"
# ach-channelmux only delivers the token owner's own DMs here, so "*" is that user.
admin_from = "*"
# Multi-workspace keeps /dir per thread; DMs bind to default_workspace.
mode = "multi-workspace"
base_dir = "$WORKSPACE_DIR"
default_workspace = "$WORKSPACE_DIR"
# A thread resumes its agent session however long it has been quiet.
reset_on_idle_mins = 0
# Stop a thread's agent process after 15 idle minutes; the next message resumes it.
agent_session_idle_timeout_mins = 15

[projects.agent]
type = "acp"

[projects.agent.options]
cmd = "opencode"
args = ["acp"]
env = { OPENCODE_CONFIG_CONTENT = '{"model":"$CC_CONNECT_MODEL"}' }

[[projects.platforms]]
type = "slack"

[projects.platforms.options]
base_url = "\${ACH_CHANNELMUX_URL}/api/"
bot_token = "\${CODER_AGENT_TOKEN}"
app_token = "\${CODER_AGENT_TOKEN}"
allow_from = "*"
session_scope = "thread"
EOF

# Restart on exit with a growing pause; give up after 10 quick failures in a
# row (about 27 minutes of retries). A run longer than 5 minutes resets the count.
nohup bash -c '
  fails=0
  while [ "$fails" -lt 10 ]; do
    start=$(date +%s)
    "$0" --config "$1" --force || echo "cc-connect exited with $?"
    if [ $(( $(date +%s) - start )) -gt 300 ]; then fails=0; else fails=$((fails + 1)); fi
    sleep $(( fails * 30 ))
  done
  echo "cc-connect: 10 quick failures in a row, giving up; restart the workspace to retry"
' "$bin" "$conf" >>"$log" 2>&1 &
echo "cc-connect $VERSION started in background, log: $log"
