# ach-channelmux

One Slack app for a whole team, a personal coding agent per user. Each user's agent
daemon (e.g. [cc-connect](https://github.com/chenhg5/cc-connect) next to OpenCode in their
own workspace) connects to the relay **as if it were Slack**, by pointing its Slack API base
URL here. The relay holds the real Slack tokens; daemons never see them and can only act on
their owner's DM.

```
Slack ──Socket Mode──▶ ach-channelmux ──"Socket Mode"──▶ daemon (pepe's workspace) ──▶ agent
                          ▲               └─────────────────▶ daemon (xavi's workspace)
                          └── Web API calls (allowlisted, scoped to the owner's DM)
```

## How it works

| Concern | Behaviour |
|---|---|
| Inbound | Routes only 1:1 DMs from humans (`channel_type=im`, no `bot_id`, no subtype except `file_share`) and interactive payloads, by Slack user id. Channels, group DMs and bot messages are dropped. |
| Identity | A daemon presents a token as its Slack token. The relay resolves it with a configurable endpoint: `GET $AUTH_RESOLVER_URL` with the token in header `$AUTH_RESOLVER_HEADER`; the owner's email is read from the JSON reply at `$AUTH_RESOLVER_EMAIL_FIELD` (dotted path). 401/403 or no email: rejected; other errors: HTTP 500, the daemon retries. Cached 5 min, keyed by a hash; tokens are never logged. Email → Slack user (`users.lookupByEmail`) → DM (`conversations.open`). |
| Exclusivity | First connection per user is primary. Further connections are parked as hot standby; the oldest is promoted when the primary drops. |
| Outbound | Web API facade at `/api/<method>`. `auth.test`, `team.info`, `files.getUploadURLExternal` pass through; `chat.*`, `reactions.*`, `conversations.replies/info`, `assistant.threads.setStatus`, `files.completeUploadExternal` must target the owner's DM; `users.info` only the owner; `views.open` needs a `trigger_id` delivered to that owner; `views.update` a known `view_id`; `conversations.list` returns empty. Everything else: `restricted_action`. |
| Interactivity | Interactive envelopes wait up to 2.5 s for the daemon's ack and relay its payload. Message events are acked to Slack at once. |
| Files | `url_private*` in delivered events are rewritten to `/files/<id>/<name>`; only the owner's daemon can fetch them. Uploads go straight to Slack's presigned URL (daemons need egress to `files.slack.com`). |
| Working notice | While 👀 is on a message (cc-connect's "turn running" reaction), posts a rotating status line (`🥧 *Baking…*`) in its thread, then "taking a while" lines with the elapsed time; deletes it when 👀 goes. |
| Session preamble | A top-level DM starts a thread and a new agent session; the relay appends a context block with the user's name, email and local time, plus `SESSION_PREAMBLE` (default in `src/main.ts`: the user sees only reply text, so acknowledge before using tools and quote tool output). Thread replies, edits and daemon commands (`/cmd`, `!shell`) pass untouched. |
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

Slack app: create it from `slack-app-manifest.json` (Socket Mode, `message.im`,
interactivity, App Home messages tab).

## Deploy

```sh
helm install ach-channelmux oci://ghcr.io/ackstorm/charts/ach-channelmux -n ach \
  --set publicUrl=http://ach-channelmux.ach.svc \
  --set authResolver.url=https://idp.example.com/whoami \
  --set authResolver.header=Authorization
```

The chart expects a secret `ach-channelmux-slack` with keys `app-token` and `bot-token`
(see `chart/values.yaml`). Image: `ghcr.io/ackstorm/ach-channelmux`.

Daemon side, cc-connect's Slack platform:

```toml
[projects.platforms.options]
base_url  = "http://ach-channelmux.ach.svc/api/"
bot_token = "${DAEMON_TOKEN}"
app_token = "${DAEMON_TOKEN}"
```

cc-connect needs a few patches for this (Slack base URL, DM thread scope); the pinned
build is in `examples/coder/cc-connect.sh`. That directory is a complete example for Coder
workspaces, including how to resolve Coder agent tokens.

## Develop

Node ≥ 22.18 runs the TypeScript sources directly; there is no build step.

```sh
npm ci
make test        # unit + end-to-end tests (mock Slack, real Bolt clients) and helm lint
./run-local.sh   # relay against real Slack plus one local cc-connect (see its header)
```

Release: `make release-cut VERSION=X.Y.Z` pushes an empty `chore(release): vX.Y.Z`
commit; CI tests, bumps the manifests, tags, and publishes the image, chart and GitHub
release.
