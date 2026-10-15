# ach-channelmux

Chat relay: one Slack app for everyone; each user's agent daemon connects to it as if it were Slack.
Two npm workspaces: the relay and the daemon (Slack ↔ ACP agent, e.g. `opencode acp`).
`README.md` has the behaviour and configuration.

```
Slack ⇄ relay (one bot token: the trust boundary) ⇄ N daemons (one active per owner email) ⇄ ACP agent (opencode acp)
         routes: DM → its author's owner · CHANNELS id/name → configured owner · code channel → owner of its origin
```

## Read first

| Working on | Read first |
|---|---|
| Relay routing or Web API rules | `README.md` relay table, then `relay/src/gateway.ts` (`routeKey`, `onUpstream`, `mayWrite`, `apiCall`) |
| How a turn renders in Slack | `daemon/src/output.ts` header, `README.md` Replies/Changes rows |
| Channels, code channels | `docs/plans/2026-10-12-channels-and-code-channels.md` (decisions, verified Slack API shapes) |

## Layout

- `relay/src/gateway.ts`: the relay (upstream Socket Mode, downstream Socket Mode facade, DM, channel and code channel routing, Web API allowlist, files, preamble).
- `relay/src/limiter.ts`: paces and retries upstream Slack calls, shared across every daemon.
- `relay/src/resolver.ts`: token → owner email through the configured endpoint.
- `relay/src/main.ts`: env config and the default session preamble.
- `relay/test/`: `e2e.test.ts` (mock Slack + real Bolt clients as daemons), `resolver.test.ts`, `limiter.test.ts`, `load.test.ts`, `mock-slack.ts`.
- `daemon/src/daemon.ts`: the daemon (folder/session picker modal, thread = ACP session in a DM or a channel thread, code channel = ACP session with context bar, Changes tab and `$done`, `$` commands, stop/queued/Send now, permission buttons, files and voice clips in, `send_file`, `ask_user` and `send_voice` MCP tools, fork, Retry, Send to agent shortcut, session reload).
- `daemon/src/output.ts`: renders one agent turn into Slack (native stream with task cards, plain-message fallback).
- `daemon/src/main.ts`: env config. `daemon/test/`: `e2e.test.ts` (mock Slack + real relay + daemon), `output.test.ts`, `mock-agent.ts` (ACP).
- `chart/`: the relay's Helm chart. `examples/coder/`: the daemon in Coder workspaces.

## Rules

- Stay platform-agnostic: nothing Coder- or company-specific in `relay/`, `daemon/` or `chart/`; it goes in `examples/`.
- Every behaviour change comes with a test; `make test` must pass (tests + helm lint).
- No build step: Node runs the `.ts` sources (type stripping), so use only erasable TypeScript.
  The daemon's release binaries are compiled with Bun (`make daemon-bin`); the sources must run under both.
- Never log or store daemon tokens in clear.
- Conventional commits. Release with `make release-cut VERSION=X.Y.Z`; CI bumps the manifests.
  A release publishes the daemon binaries and the chart; the relay rolls out through GitOps downstream
  (outside this repo), and daemons are updated separately.

## Gotchas

- ❌ Daemon calls a Slack method the relay doesn't know → silent `restricted_action`.
  ✅ Every daemon call passes the relay's `CHANNEL_SCOPED`/`apiCall` rules: add the method there, with a relay test.
- ❌ Channel or permission policy in the daemon. ✅ Policy lives only in relay config (`CHANNELS`, `CODE_CHANNELS`);
  the daemon reacts to what the relay forwards (e.g. `code_channel_origin`).
- ❌ One MCP server per session. ✅ opencode registers MCP per folder, last registration wins: a tool call goes to
  the folder's running turn; a cold folder's first turn waits for the agent to list our tools, plus 0.5 s.
- ❌ `thread_ts: t.thread`. ✅ `inThread(t)`: a code channel session (`top`) posts in the channel; its key is the channel id.
- ❌ Stream updates while a question or permission prompt waits. ✅ `pause()` holds card updates until `resume()`;
  otherwise a new stream opens under the question.
- ❌ `chat.postMessage` with both `text` and `markdown_text`: Slack refuses it. ✅ One of them.
- ❌ e2e tests waiting on the mock agent's log before the next command. ✅ Wait for the daemon's own signal (its post,
  or `turnEnded`: the `turn_ended` log line comes last). Tests run in sequence and share state.
- ❌ Reading or printing the bot token to test against real Slack. ✅ Pipe it from the k8s secret into `curl -H @-`.
