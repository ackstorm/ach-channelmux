# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Removed

- Examples no longer set the OpenCode model (`CC_CONNECT_MODEL`, `OPENCODE_MODEL`):
  the agent's default model is its own configuration.

## [0.1.0] - 2026-10-04

First public release: Socket Mode facade with hot standby, Web API allowlist scoped to
the owner's DM, file proxy, interactivity relay, working notice, session preamble,
offline notice, and token resolution through a configurable endpoint.
