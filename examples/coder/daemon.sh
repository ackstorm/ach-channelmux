#!/usr/bin/env bash
# The workspace owner's coding agent in Slack: the ach-channelmux daemon running
# `opencode acp`. Run by a coder_script on every workspace start (see README.md here).
# Needs CODER_AGENT_TOKEN (set by Coder) and ACH_CHANNELMUX_URL in the agent env.
# Log: /tmp/ach-channelmux-daemon.log
set -euo pipefail

VERSION=v0.2.52
BASE_DIR=${AGENT_BASE_DIR:-/workspace}

: "${CODER_AGENT_TOKEN:?}" "${ACH_CHANNELMUX_URL:?}"
bin=$HOME/.local/bin/ach-channelmux-daemon
log=/tmp/ach-channelmux-daemon.log

case $(uname -m) in
  x86_64) arch=amd64 ;;
  aarch64) arch=arm64 ;;
  *) echo "ach-channelmux-daemon: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

if [ "$(cat "$bin.version" 2>/dev/null)" != "$VERSION" ]; then
  name=ach-channelmux-daemon-linux-$arch
  url=https://github.com/ackstorm/ach-channelmux/releases/download/$VERSION
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/$name" "$url/$name"
  curl -fsSL --retry 3 -o "$tmp/checksums.txt" "$url/checksums.txt"
  (cd "$tmp" && grep " $name\$" checksums.txt | sha256sum -c --quiet -)
  mkdir -p "$(dirname "$bin")"
  install -m 0755 "$tmp/$name" "$bin"
  echo "$VERSION" > "$bin.version"
  rm -rf "$tmp"
fi

# The token stays in the env; nothing is written to disk but the thread -> session map.
# Restart on exit with a growing pause; give up after 10 quick failures in a
# row (about 27 minutes of retries). A run longer than 5 minutes resets the count.
RELAY_URL=$ACH_CHANNELMUX_URL RELAY_TOKEN=$CODER_AGENT_TOKEN BASE_DIR=$BASE_DIR \
nohup bash -c '
  fails=0
  while [ "$fails" -lt 10 ]; do
    start=$(date +%s)
    "$0" || echo "ach-channelmux-daemon exited with $?"
    if [ $(( $(date +%s) - start )) -gt 300 ]; then fails=0; else fails=$((fails + 1)); fi
    sleep $(( fails * 30 ))
  done
  echo "ach-channelmux-daemon: 10 quick failures in a row, giving up; restart the workspace to retry"
' "$bin" >>"$log" 2>&1 &
echo "ach-channelmux-daemon $VERSION started in background, log: $log"
