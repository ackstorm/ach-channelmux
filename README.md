# ach-channelmux

One Slack app for a whole team, a personal coding agent per user. Each user's agent
daemon (ours, below, running OpenCode in their own workspace; or any Slack bot that can
change its API base URL) connects to the relay **as if it were Slack**, by pointing its
Slack API base URL here. The relay holds the real Slack tokens; daemons never see them and can only act on
their owner's DM and channels.

```
Slack ──Socket Mode──▶ ach-channelmux ──"Socket Mode"──▶ daemon (pepe's workspace) ──▶ agent
                          ▲               └─────────────────▶ daemon (xavi's workspace)
                          └── Web API calls (allowlisted, scoped to the owner's DM and channels)
```

## How it works

| Concern | Behaviour |
|---|---|
| Inbound | Routes 1:1 DMs from humans (`channel_type=im`, no `bot_id`, no subtype except `file_share`, plus their own edits as `message_changed` when the text changed), interactive payloads and `app_home_opened` events for the Home tab, by Slack user id; messages and clicks in a `CHANNELS` channel (`channel_type=channel` or `group`, same filters) or a code channel opened from one go to that channel's owner, whoever wrote or clicked. A top-level message in a `CODE_CHANNELS` channel carries `code_channel_origin: true`, the daemon's only hint. Other channels, group DMs and bot messages are dropped. |
| Identity | A daemon presents a token as its Slack token. The relay resolves it with a configurable endpoint: `GET $AUTH_RESOLVER_URL` with the token in header `$AUTH_RESOLVER_HEADER`; the owner's email is read from the JSON reply at `$AUTH_RESOLVER_EMAIL_FIELD` (dotted path). 401/403 or no email: rejected; other errors: HTTP 500, the daemon retries. Cached 5 min, keyed by a hash; tokens are never logged. Email → Slack user (`users.lookupByEmail`) → DM (`conversations.open`). |
| Shared agents | A token whose email has no Slack user connects only when that email owns a channel in `CHANNELS` (a service account); its daemon serves just those channels, with no DM or Home tab. |
| Exclusivity | One daemon per user: while one is connected, a new one is refused (`already_connected`) and exits with code 3, which the Coder example's restart loop takes as final. A dropped daemon's slot frees when its socket closes, or within about 20 s when it stops answering pings; a daemon reconnecting meanwhile waits for it. |
| Outbound | Web API facade at `/api/<method>`. `auth.test`, `team.info`, `files.getUploadURLExternal` pass through; `chat.*` (incl. `chat.getPermalink`), `chat.startStream`/`appendStream`/`stopStream`, `reactions.*`, `conversations.replies/info`, `assistant.threads.setStatus`, `agents.sessions.setStatus`/`rename`, `agents.conversations.setProperties`/`setView`/`archive`, `files.completeUploadExternal` must target the owner's DM, one of its `CHANNELS` or a code channel it opened; `agents.conversations.create` only from one of its `CODE_CHANNELS`; in a channel only the owner's `!` shell commands reach the daemon (others get an ephemeral note); `users.info` only the owner (anyone once the owner serves a channel); `views.open` needs a `trigger_id` delivered to that owner; `views.update` a known `view_id`; `views.publish` only the owner's Home; `conversations.list` returns empty. Everything else: `restricted_action`. |
| Rate limits | All daemons share the app's per-method limits. Upstream calls queue per method at the tier rate (`RATES` in `relay/src/limiter.ts`); a 429 waits Retry-After and retries; queued edits and appends of one message merge; `chat.startStream` is refused with `ratelimited` when it would wait over 2 s, so daemons fall back to plain messages. |
| Interactivity | Interactive envelopes wait up to 2.5 s for the daemon's ack and relay its payload. Message events are acked to Slack at once. |
| Files | `url_private*` (and a voice clip's `vtt` transcript) in delivered events and `conversations.replies` are rewritten to `/files/<id>/<name>`; only the owner's daemon can fetch them. Uploads go straight to Slack's presigned URL (daemons need egress to `files.slack.com`). |
| Session preamble | A top-level DM starts a thread and a new agent session; the relay appends a context block with the user's name, email and local time, plus `SESSION_PREAMBLE` (default in `relay/src/main.ts`: the user sees only reply text, so acknowledge before using tools and quote tool output). Thread replies, edits and daemon commands (`/cmd`, `$cmd`, `!shell`) pass untouched. |
| Offline | No daemon connected: every message for the agent gets `OFFLINE_MESSAGE` as a reply where it was written (top level or its thread; in a channel only in a code channel, a message that mentions the bot, or a reply in the thread of one the relay forwarded since it started, and always in the thread); the Home tab shows 🔴 Offline with it. Nothing is held or replayed. |
| State | In memory. One replica. Slack redelivers unacked envelopes (deduplicated by `event_id`); daemons reconnect on their own. |

## Configuration

| Env | |
|---|---|
| `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN` | The Slack app's credentials (`xapp-…`, `xoxb-…`). |
| `PUBLIC_URL` | URL daemons use to reach the relay (handed back for the WebSocket). |
| `AUTH_RESOLVER_URL`, `AUTH_RESOLVER_HEADER` | Token resolver endpoint and the header that carries the token. |
| `AUTH_RESOLVER_EMAIL_FIELD` | Dotted path to the email in its reply. Default `email`. |
| `SESSION_PREAMBLE` | Optional; `""` disables the context block. |
| `OFFLINE_MESSAGE` | Optional reply while the user's daemon is not connected, e.g. how to start their workspace (Slack mrkdwn, `<url\|text>` links). Default: "Your workspace is offline. Start it and try again." |
| `CHANNELS` | Optional; `name=owner email,…` or `id=owner email,…` (chart `channels`): channels whose mentions go to that owner's daemon. An id (`C0123ABCD`) survives renames and cannot be taken by a new channel of that name. Default: DMs only. |
| `CODE_CHANNELS` | Optional; `name,…` or ids, as written in `CHANNELS` (chart `codeChannels`): of those, the channels where a mention opens a Slack code channel. |
| `PORT` | Default `8080`. |

Slack app: create it from `slack-app-manifest.json` (Socket Mode, `message.im`, `message.channels`,
`message.groups` and `app_home_opened` events, interactivity, App Home Home and
Messages tabs, the `agent_view` feature with `assistant:write`, the `code_channels` feature with
`code_channels:manage`, and `channels:history`/`read`, `groups:history`/`read`). Invite the bot to each
`CHANNELS` channel. After updating an existing app's manifest, reinstall it. The manifest can't carry an icon:
upload `slack-app-icon.png` under the app's **Basic Information → Display Information → App icon**.

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
| New DM | The picker answers in the DM's main view, under the message (in a channel, in its thread): a greeting whose **📂 Choose folder** opens a two-step modal. **Step 1, the folder:** in `BASE_DIR`, first **Suggested and recent**, one list with the first ticked: the folders the message names (marked 🪄, explained once under the list; a whole folder name, any case, ignoring `-` `_` `.`; only names of 6+ characters or with `-` `_` `.` or a digit, as a short plain one is often just a word; last used first, then 3 levels under `BASE_DIR`; up to 3), then the recent ones (from the agent's `session/list`), 5 at most, one line each: its full path (a long one keeps its start and the folder's name, the middle cut to `[...]`). Then, in `BASE_DIR` only, **Search** (paths up to 3 levels under `BASE_DIR`), and browsing: the folder with Back beside it, its subfolders (`📁 name ›`; hidden folders and `node_modules` skipped, symlinks followed) and **➕ New folder**, which shows a name box. **Use <folder>** takes the searched, else the ticked, else the browsed folder, and always names it. **Step 2, the session** (Slack's back arrow returns to step 1): **🆕 New session**, or one of the folder's last 10 (one open in another thread moves here); a folder without sessions says so. **Start** runs it; the greeting says `⏳ Starting…` at once. The message waits until then, and the picker survives a daemon restart. At start the greeting leaves the main view and the thread opens with its header (in a channel, the greeting becomes it): 📁 the folder, 💬 the session's title and id (to resume it elsewhere, e.g. `opencode -s <id>` in that folder) and, for a continued session, ↩️ its previous thread followed by a **Session recap** of its last 3 exchanges (code blocks shown as `[code]`) (each turn's final text; the agent keeps the whole history). Then the message goes to the agent. |
| Send to agent | A message shortcut (⋯ on any message → **Send to agent**, manifest `send_to_agent`, needs the `commands` scope) starts a new DM thread with that message's text and a link back, at the folder picker. The relay adds its context block, as for a top-level DM. |
| Channels | A message that mentions the bot in a `CHANNELS` channel gets the picker in its thread, then the session there; the mention is not sent to the agent. Replies in that thread need no mention. Other messages, and threads with no session, are ignored. The relay's context block names who wrote each message. |
| Code channels | A mention in a `CODE_CHANNELS` channel opens a private Slack code channel named after the message, its author invited, with `🧑‍💻 Working in #…` in the message's thread (if Slack refuses, the session runs in that thread instead). The session lives in the code channel, top-level: picker, replies and commands need no thread or mention. Its context bar shows folder · branch · model; after a turn with edits in a git repo its **Changes** tab shows `git diff` against the commit the session's first turn there began on (the agent may commit as it goes), else `HEAD` (the whole working tree, up to 200 KB). `$done` posts a summary and archives the channel; the session stays, to continue from any new message's Previous session. A relay restart keeps it: the relay finds a code channel's owner through Slack's origin link. |
| Thread replies | Prompts to the thread's session, one turn at a time; queued if a turn is already running. Text reaches the agent (and `!` commands the shell) as typed: Slack's `&amp;` `&lt;` `&gt;` are decoded. |
| Replies | Native stream (`chat.startStream`/`appendStream`/`stopStream`) with one task card per stretch: the model's thinking and the tools it calls between two texts (or up to a question). It shows once the model stops thinking: `Thought for 10s · 2 tools used` (`· 1 failed` when a tool failed; the card stays green); it never spins, and each finished tool joins its details as it ends. The tool running now shows above the reply box, in the thread's status line (`Tool: <the agent's description of the call, else the tool>` up to Slack's 50 characters, `Thinking · <heading>…`, or a working phrase such as `Baking…` that changes every 15 s; each line stays at least 2 s), until the reply's text starts; then Slack shows its own "<app> is working" (subagents' tools nested as `↳`, fetched URLs in the title). Once the message stops it is rewritten with one card per stretch: opened, it shows the thinking (headings in bold, `code` as code), a rule, then **Used tools:** and their list, not their results; a message that reaches Slack's size limit (`msg_too_long`) or about 4 minutes goes on in a new one, and a code fence open at the cut is closed and reopened, and a stretch cut there keeps its card in the first message, updated in place. Falls back to one plain message per finished text segment (cut at tool calls) when streaming is off or refused. A turn that ends with no reply (after its tools, or with nothing at all) gets one nudge; if that gets none either, the thread says so. The agent's own commands (`$compact`, `$review`) are not nudged. |
| Status/Stop | `agents.sessions.setStatus` brackets each turn; before the first message, and once a stream starts, the session goes `active` so the status line (`assistant.threads.setStatus`) can show what runs, else Slack shows "<app> is working" above the reply box. `$stop` (or `/stop`) in the thread cancels the running turn. The app does not subscribe to `agent_session_stopped`, so Slack shows no stop button of its own. |
| Retry | A failed turn (e.g. a model gateway error) ends with ⚠️ and a **Retry** button that sends the same message again. |
| Home tab | Shows the agent (🟢 online, command, host, `BASE_DIR`), **Defaults for new sessions** (the agent's settings, e.g. model, as its latest session reported them; a choice is saved in `STATE_FILE` and applied to every new session) and the 5 most recent threads with links. When a session reports settings that change those menus, the open Home tab is redrawn. |
| Changes | Every reply ends with a rule and one line: `📁 folder · 🌿 branch · model · N files changed +A −R · Context 24k / 200k (12%) · Cost $0.012` (the branch only in a git repo; the counts only after edits, from the edits the agent reported: shell-made changes are not counted; context and cost once the agent reports them, as in `$model`). In a code channel the context bar shows folder, branch and model: the line has the rest. Each edit counts and shows only the lines it changed (a line diff, 3 lines of context around each change), even when the agent reports the whole file before and after. A turn that edits also posts its changes as a `changes.diff` snippet. |
| Commands | In a thread: `$model` (each setting, e.g. model and effort, with its own menu that changes it at once; then the context window use and cost so far), `$compact`, `$clear` (new session, same folder), `$fork` (a copy of the session in a new thread), `$stop`, `$done` (closes a code channel), `$help`, `! <cmd>` (runs in the session folder; the agent sees it with the next message). The agent's own commands (`session/available_commands`, e.g. opencode's `$review branch`) are sent to it as `/<name> <args>`. Slack swallows unregistered `/` commands, hence `$`. |
| Edits | An edited message never reaches the agent; its author gets an ephemeral notice in the thread to send a new message instead. |
| Queued | A message sent while a turn is running gets a "📬 Queued" notice and runs after; its **Send now** button stops the running turn so it runs at once. When it starts, the notice loses its button. Queued messages are kept in `STATE_FILE`: after a daemon restart they still run (the turn cut short by the restart does not run again). |
| Files in | Fetched through the relay's proxy and saved to a temp folder; the prompt gets their paths, so the agent opens a file (image or not) only when it needs it. A voice clip comes as Slack's own transcript (its preview, or the whole WebVTT, waiting up to 15 s while Slack transcribes); without one, the `AUDIO_STT_*` model transcribes it when set, else (or when it fails) the audio is saved like any file. |
| Questions | An `ask_user(question, options?)` tool on the same MCP server: the question shows with up to 5 answer buttons; a tap or the user's next message in the thread is the answer the tool returns. `$stop` answers it as stopped. While a question or permission prompt waits, the session shows as suspended and card updates are held until the answer, so nothing below it looks busy. |
| Files out | Each session gets a `send_file(path, comment?)` tool from a small MCP server the daemon runs on `127.0.0.1` (per-process secret in the URL); it uploads the file (≤ 50 MB) to the thread. Needs an agent with HTTP MCP support (`opencode acp` has it). opencode keeps one MCP server per folder, so a call (`send_file`, `ask_user`, `send_voice`) goes to the thread whose turn is running in that folder; two turns at once in one folder go to the thread in the URL. opencode connects a folder's servers as it first uses the folder, which can be after a session has opened: the first session in a folder after a start waits (up to 5 s) until the agent lists these tools, plus 0.5 s for opencode to refresh its tool catalog, so its turn starts with them. |
| Voice out | With `AUDIO_TTS_BASE_URL` set, the agent also gets `send_voice(text)`: the text goes to the TTS model (with `AUDIO_TTS_PROMPT` before it) and the audio is uploaded to the thread as `voice-note.m4a`: a WAV loses its last 200 ms (Gemini's speech ends with a burst of noise) and is encoded to AAC with `ffmpeg` (a tenth of the size); without `ffmpeg` it goes as `voice-note.wav`, an mp3 as it came. The tool tells the agent the clip is its reply, so it does not write the same as text. |
| Permissions | The agent's permission requests become buttons with its options: what it wants to do (run, read, edit, access…) and to what, with the command or the new content. A click leaves the choice under it (`→ Allow once`). opencode asks only when its `permission` config says `ask`; by default it allows everything. |
| Restarts | Thread → session map in `STATE_FILE`; after a restart a thread reloads its session (`session/load`) without re-posting the history. |

| Env | |
|---|---|
| `RELAY_URL`, `RELAY_TOKEN` | The relay and the token it resolves to this daemon's owner. |
| `BASE_DIR` | Root of the picker; folders below it can be chosen. Default: current directory. |
| `AGENT_CMD` | ACP agent command. Default `opencode acp`. |
| `STATE_FILE` | Default `~/.local/state/ach-channelmux/threads.json`. |
| `AUDIO_STT_BASE_URL` | OpenAI-compatible API (e.g. `https://llm.example.com/v1`) that transcribes voice clips Slack did not. Unset: off. |
| `AUDIO_STT_MODEL` | Default `whisper-1`. `AUDIO_STT_LANGUAGE` (e.g. `es`) and `AUDIO_STT_PROMPT` (names and terms to spell right) are optional. |
| `AUDIO_STT_HEADER` | Header carrying the key. Default `Authorization`, sent as `Bearer <key>`. |
| `AUDIO_STT_KEY`, `AUDIO_STT_KEY_COMMAND` | The key, or a shell command printing it, run for each clip (for short-lived tokens). |
| `AUDIO_TTS_BASE_URL` | OpenAI-compatible API (its `/audio/speech`) for the `send_voice` tool. Unset: no tool. |
| `AUDIO_TTS_MODEL`, `AUDIO_TTS_VOICE` | Default `tts-1` and `alloy`. Gemini models take voices like `Kore` or `Puck`. |
| `AUDIO_TTS_PROMPT` | How to speak, put before the text (`"<prompt>: <text>"`), which Gemini models follow; OpenAI's `instructions` field is not sent. |
| `AUDIO_TTS_HEADER`, `AUDIO_TTS_KEY`, `AUDIO_TTS_KEY_COMMAND` | As for STT. |

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
