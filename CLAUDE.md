# ach-channelmux

Chat relay: one Slack app for everyone; each user's agent daemon connects to it as if it were Slack.
`README.md` has the behaviour and configuration.

## Layout

- `src/gateway.ts`: the relay (upstream Socket Mode, downstream Socket Mode facade, Web API allowlist, files, working notice, preamble).
- `src/resolver.ts`: token → owner email through the configured endpoint.
- `src/main.ts`: env config and the default session preamble.
- `test/`: `e2e.test.ts` (mock Slack + real Bolt clients as daemons), `resolver.test.ts`, `mock-slack.ts`.
- `chart/`: Helm chart. `examples/coder/`: cc-connect in Coder workspaces.

## Rules

- Stay platform-agnostic: nothing Coder- or company-specific in `src/` or `chart/`; it goes in `examples/`.
- Every behaviour change comes with a test; `make test` must pass (tests + helm lint).
- No build step: Node runs the `.ts` sources (type stripping), so use only erasable TypeScript.
- Never log or store daemon tokens in clear.
- Conventional commits. Release with `make release-cut VERSION=X.Y.Z`; CI bumps the manifests.
