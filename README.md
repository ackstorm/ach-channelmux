# ach-channelmux

One Slack app for a whole team, a personal coding agent per user. Each user's agent
daemon (ours, below, running OpenCode in their own workspace; or any Slack bot that can
change its API base URL) connects to the relay **as if it were Slack**, by pointing its
Slack API base URL here. The relay holds the real Slack tokens; daemons never see them and can only act on
their owner's DM.

```
Slack ──Socket Mode──▶ ach-channelmux ──"Socket Mode"──▶ daemon (pepe's workspace) ──▶ agent
                          ▲               └─────────────────▶ daemon (xavi's workspace)
                          └── Web API calls (allowlisted, scoped to the owner's DM)
```

## How it works

| Concern | Behaviour |
|---|---|
| Inbound | Routes only 1:1 DMs from humans (`channel_type=im`, no `bot_id`, no subtype except `file_share`, plus their own edits as `message_changed` when the text changed), interactive payloads and `agent_session_stopped` events, by Slack user id. Channels, group DMs and bot messages are dropped. |
| Identity | A daemon presents a token as its Slack token. The relay resolves it with a configurable endpoint: `GET $AUTH_RESOLVER_URL` with the token in header `$AUTH_RESOLVER_HEADER`; the owner's email is read from the JSON reply at `$AUTH_RESOLVER_EMAIL_FIELD` (dotted path). 401/403 or no email: rejected; other errors: HTTP 500, the daemon retries. Cached 5 min, keyed by a hash; tokens are never logged. Email → Slack user (`users.lookupByEmail`) → DM (`conversations.open`). |
| Exclusivity | First connection per user is primary. Further connections are parked as hot standby; the oldest is promoted when the primary drops. |
| Outbound | Web API facade at `/api/<method>`. `auth.test`, `team.info`, `files.getUploadURLExternal` pass through; `chat.*` (incl. `chat.getPermalink`), `chat.startStream`/`appendStream`/`stopStream`, `reactions.*`, `conversations.replies/info`, `assistant.threads.setStatus`, `agents.sessions.setStatus`/`rename`, `files.completeUploadExternal` must target the owner's DM; `users.info` only the owner; `views.open` needs a `trigger_id` delivered to that owner; `views.update` a known `view_id`; `conversations.list` returns empty. Everything else: `restricted_action`. |
| Rate limits | All daemons share the app's per-method limits. Upstream calls queue per method at the tier rate (`RATES` in `relay/src/limiter.ts`); a 429 waits Retry-After and retries; queued edits and appends of one message merge; `chat.startStream` is refused with `ratelimited` when it would wait over 2 s, so daemons fall back to plain messages. |
| Interactivity | Interactive envelopes wait up to 2.5 s for the daemon's ack and relay its payload. Message events are acked to Slack at once. |
| Files | `url_private*` (and a voice clip's `vtt` transcript) in delivered events and `conversations.replies` are rewritten to `/files/<id>/<name>`; only the owner's daemon can fetch them. Uploads go straight to Slack's presigned URL (daemons need egress to `files.slack.com`). |
| Working notice | While 👀 is on a message (the daemon's "turn running" reaction), posts a rotating status line (`🥧 *Baking…*`) in its thread, then "taking a while" lines with the elapsed time; deletes it when 👀 goes. |
| Session preamble | A top-level DM starts a thread and a new agent session; the relay appends a context block with the user's name, email and local time, plus `SESSION_PREAMBLE` (default in `relay/src/main.ts`: the user sees only reply text, so acknowledge before using tools and quote tool output). Thread replies, edits and daemon commands (`/cmd`, `$cmd`, `!shell`) pass untouched. |
| Offline | No daemon connected: every message gets a "not connected" notice in its thread. Nothing is held or replayed. |
| State | In memory. One replica. Slack redelivers unacked envelopes (deduplicated by `event_id`); daemons reconnect on their own. |

## Configuration

| Env | |
|---|---|
| `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN` | The Slack app's credentials (`xapp-…`, `xoxb-…`). |
| `PUBLIC_URL` | URL daemons use to reach the relay (handed back for the WebSocket). |
| `AUTH_RESOLVER_URL`, `AUTH_RESOLVER_HEADER` | Token resolver endpoint and the header that carries the token. |
| `AUTH_RESOLVER_EMAIL_FIELD` | Dotted path to the email in its reply. Default `email`. |
| `SESSION_PREAMBLE` | Optional; `""` disables the context block. |
| `PORT` | Default `8080`. |

Slack app: create it from `slack-app-manifest.json` (Socket Mode, `message.im` and
`agent_session_stopped` events, interactivity, App Home messages tab, the `agent_view`
feature with `assistant:write`). After updating an existing app's manifest, reinstall it.

## Deploy

```sh
helm install ach-channelmux oci://ghcr.io/ackstorm/charts/ach-channelmux -n ach \
  --set publicUrl=http://ach-channelmux.ach.svc \
  --set authResolver.url=https://idp.example.com/whoami \
  --set authResolver.header=Authorization
```

The chart expects a secret `ach-channelmux-slack` with keys `app-token` and `bot-token`
(see `chart/values.yaml`). Image: `ghcr.io/ackstorm/ach-channelmux`.

## Daemon

`daemon/` bridges the relay to any [ACP](https://agentclientprotocol.com) agent (default
`opencode acp`), one agent process per daemon, one session per thread:

| | |
|---|---|
| New DM | Replies in its thread with **📂 Choose folder**, which opens a picker modal. Folder screen: the last-used folders (from the agent's `session/list`) and `BASE_DIR`'s folders, browsed in place (Open ›, Back; hidden folders and `node_modules` skipped, symlinks followed), then **Use**. Session screen: a new session or an existing one in that folder (one open in another thread moves here), then **Start**. The message becomes the session's first prompt; a continued session's last reply is quoted, not its history, and the thread shows `opencode -s <id>` to resume it in a terminal. |
| Thread replies | Prompts to the thread's session, one turn at a time; queued if a turn is already running. |
| Replies | Native stream (`chat.startStream`/`appendStream`/`stopStream`) with tool calls as task cards (subagents' tools nested as `↳`, fetched URLs as links) and the model's thinking as a folded **Thinking** card; falls back to one plain message per finished text segment (cut at tool calls) when streaming is off or refused. |
| Status/Stop | `agents.sessions.setStatus` brackets each turn (Slack's "Working…" and native stop button); Slack's stop button and `/stop` in the thread both cancel the running turn. |
| Done notice | A turn of 60 s or more ends with a short `✅ Done · 3m 12s` message (or ❌ Failed, ⏹️ Stopped): it notifies, where the end of a stream does not. Every turn also gets ✅/❌/⏹️ on the message that asked for it. |
| Commands | In a thread: `$model` (model and effort, with the context window use and cost so far; **Change** opens a modal), `$compact`, `$clear` (new session, same folder), `$fork` (a copy of the session in a new thread), `$stop`, `$help`, `! <cmd>` (runs in the session folder; the agent sees it with the next message). The agent's own commands (`session/available_commands`, e.g. opencode's `$review branch`) are sent to it as `/<name> <args>`. Slack swallows unregistered `/` commands, hence `$`. |
| Edits | Editing the first message before the picker is done changes the first prompt; editing a message in a session sends the new text as a correction (`edited="true"` in its `<slack>` envelope). Edited `$`/`!` commands do not run again. |
| Queued | A message sent while a turn is running gets a "📬 Queued" notice and runs after; its **Send now** button stops the running turn so it runs at once. |
| Files in | Fetched through the relay's proxy and saved to a temp folder; the prompt gets their paths, so the agent opens a file (image or not) only when it needs it. A voice clip comes as Slack's own transcript (its preview, or the whole WebVTT, waiting up to 15 s while Slack transcribes); without one, the audio is saved like any file. |
| Questions | An `ask_user(question, options?)` tool on the same MCP server: the question shows with up to 5 answer buttons; a tap or the user's next message in the thread is the answer the tool returns. `$stop` answers it as stopped. |
| Files out | Each session gets a `send_file(path, comment?)` tool from a small MCP server the daemon runs on `127.0.0.1` (per-process secret in the URL); it uploads the file (≤ 50 MB) to the thread. Needs an agent with HTTP MCP support (`opencode acp` has it). |
| Permissions | The agent's permission requests become buttons with its options, showing the command or path it wants to run. |
| Restarts | Thread → session map in `STATE_FILE`; after a restart a thread reloads its session (`session/load`) without re-posting the history. |

| Env | |
|---|---|
| `RELAY_URL`, `RELAY_TOKEN` | The relay and the token it resolves to this daemon's owner. |
| `BASE_DIR` | Root of the picker; folders below it can be chosen. Default: current directory. |
| `AGENT_CMD` | ACP agent command. Default `opencode acp`. |
| `STATE_FILE` | Default `~/.local/state/ach-channelmux/threads.json`. |

Each release ships `ach-channelmux-daemon-linux-{amd64,arm64}` (glibc) and `checksums.txt`.
`examples/coder/` is a complete example for Coder workspaces, including how to resolve
Coder agent tokens.

## Develop

Node ≥ 22.18 runs the TypeScript sources directly; there is no build step.

```sh
npm ci
make test        # relay and daemon tests (mock Slack, real Bolt clients, mock ACP agent) and helm lint
make daemon-bin  # daemon binaries into dist/ (needs bun)
./run-local.sh   # relay against real Slack plus one local daemon (see its header)
```

Release: `make release-cut VERSION=X.Y.Z` pushes an empty `chore(release): vX.Y.Z`
commit; CI tests, bumps the manifests, tags, and publishes the image, chart and GitHub
release with the daemon binaries.
