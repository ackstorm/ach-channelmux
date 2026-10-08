# Example: the daemon in Coder workspaces

`daemon.sh` installs the ach-channelmux daemon and keeps it running, so the workspace
owner's coding agent (`opencode acp`) answers their Slack DMs through ach-channelmux. The
daemon authenticates with the workspace agent's own `CODER_AGENT_TOKEN` (set by Coder, valid
while the workspace runs); never pass the owner's session token. The workspace image needs
`opencode` on the PATH and glibc (the binaries are not built for musl/Alpine).

## Template

Agent env:

```hcl
env = {
  "ACH_CHANNELMUX_URL" = "http://ach-channelmux.ach.svc"   # the relay's publicUrl
}
```

Copy `daemon.sh` next to `main.tf` and add:

```hcl
resource "coder_script" "slack_agent" {
  agent_id     = coder_agent.main.id
  display_name = "Slack agent"
  icon         = "/icon/slack.svg"
  run_on_start = true
  script       = file("${path.module}/daemon.sh")
}
```

Optional env: `AGENT_BASE_DIR` (root of the folder picker, default `/workspace`).

## Resolving the agent token

Coder has no API that maps an agent token to its owner, so the relay's `authResolver`
needs a small service next to Coder that does. It runs the lookup Coder itself uses
(`GetAuthenticatedWorkspaceAgentAndBuildByAuthToken`) against Coder's database and answers
`GET /` with header `X-Coder-Agent-Token: <token>` with `{"email", "username", "workspace"}`,
or `null`. Relay values:

```yaml
authResolver:
  url: http://agent-identity.coder.svc/
  header: X-Coder-Agent-Token
  emailField: email
```

The query (Coder v2.37; re-check after upgrades that touch these tables):

```sql
SELECT u.email, u.username, w.name
FROM workspace_agents a
JOIN workspace_resources r ON r.id = a.resource_id
JOIN workspace_builds b ON b.job_id = r.job_id
JOIN workspaces w ON w.id = b.workspace_id
JOIN users u ON u.id = w.owner_id
WHERE a.auth_token = $1
  AND NOT a.deleted AND NOT w.deleted AND NOT u.deleted
  AND u.status <> 'suspended'
  AND b.transition = 'start'
  AND b.build_number = (SELECT max(build_number) FROM workspace_builds WHERE workspace_id = w.id)
```

## Operations

Daemon build: the script pins `VERSION`, an ach-channelmux release; the next workspace
start installs a new one. Logs: `/tmp/ach-channelmux-daemon.log`. The thread → session map
persists in `~/.local/state/ach-channelmux/threads.json` and OpenCode's sessions in its own
data dir, both on the home volume, so threads resume after a workspace restart.
