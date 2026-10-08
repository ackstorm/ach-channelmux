# ach-channelmux

Chat relay: one Slack app for everyone; each user's agent daemon connects to it as if it were Slack.
Two npm workspaces: the relay and the daemon (Slack ↔ ACP agent, e.g. `opencode acp`).
`README.md` has the behaviour and configuration.

## Layout

- `relay/src/gateway.ts`: the relay (upstream Socket Mode, downstream Socket Mode facade, Web API allowlist, files, working notice, preamble).
- `relay/src/resolver.ts`: token → owner email through the configured endpoint.
- `relay/src/main.ts`: env config and the default session preamble.
- `relay/test/`: `e2e.test.ts` (mock Slack + real Bolt clients as daemons), `resolver.test.ts`, `mock-slack.ts`.
- `daemon/src/daemon.ts`: the daemon (folder picker, thread = ACP session, text segments, permission buttons, session reload).
- `daemon/src/main.ts`: env config. `daemon/test/`: `e2e.test.ts` (mock Slack + real relay + daemon), `mock-agent.ts` (ACP).
- `chart/`: the relay's Helm chart. `examples/coder/`: the daemon in Coder workspaces.

## Rules

- Stay platform-agnostic: nothing Coder- or company-specific in `relay/`, `daemon/` or `chart/`; it goes in `examples/`.
- Every behaviour change comes with a test; `make test` must pass (tests + helm lint).
- No build step: Node runs the `.ts` sources (type stripping), so use only erasable TypeScript.
  The daemon's release binaries are compiled with Bun (`make daemon-bin`); the sources must run under both.
- Never log or store daemon tokens in clear.
- Conventional commits. Release with `make release-cut VERSION=X.Y.Z`; CI bumps the manifests.
