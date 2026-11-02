# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Prometheus usage metrics in the relay, per owner email, on `METRICS_PORT` (default 9090,
  kept off the ingress): messages, threads, commands and clicks, files, Slack calls,
  daemon connections and relay log events. Counts only, no message text.
- Chart: `metrics.serviceMonitor` (metrics-only Service and ServiceMonitor) and
  `metrics.dashboards` (Grafana dashboard ConfigMap; LLM spend per user from LiteLLM).

### Removed

- The relay's working notice (`🥧 *Baking…*` while 👀 is on a message) and its
  `workingNoticeMs`, `slowWorkingAfterMs` and `slowWorkingNoticeMs` options: only
  cc-connect set 👀, and the daemon shows Slack's own status instead.
- Examples no longer set the OpenCode model (`CC_CONNECT_MODEL`, `OPENCODE_MODEL`):
  the agent's default model is its own configuration.

## [0.1.0] - 2026-10-04

First public release: Socket Mode facade with hot standby, Web API allowlist scoped to
the owner's DM, file proxy, interactivity relay, working notice, session preamble,
offline notice, and token resolution through a configurable endpoint.
