# Channels and Code Channels Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let an admin open selected Slack channels to selected agents (a thread per session, or a Slack Code
"code channel" per session), keep everyone else DM-only, and show folder · branch · model under every reply.

**Architecture:** The relay owns the policy: `CHANNELS` maps channel names to the owner email whose daemon
serves them, `CODE_CHANNELS` marks which of them open code channels. The relay routes those channels' events
to that owner's daemon, scopes the Web API to them, records the code channels it lets a daemon create, and
refuses `!` shell commands from anyone but the owner. The daemon learns nothing from config: it answers
mentions in any channel the relay forwards, and opens a code channel when the relay marks the mention as a
code-channel origin.

**Tech Stack:** Node 24 type-stripped TypeScript (erasable only), Bolt, ws, node:test; Slack Web API
(`agents.conversations.*`, `agents.sessions.*`, `chat.startStream`); Helm chart.

**Decisions taken with the user (2026-10-12):**
- Default is DM only. Channels are configured in the relay only, never by a daemon.
- `CHANNELS="_tmp_jcm=juancarlos.moreno@ackstorm.com,_shared_sales=sales-agent@ackstorm.com"`,
  `CODE_CHANNELS="_tmp_jcm"` (each must also be in `CHANNELS`).
- A shared agent is a daemon whose token resolves to a service account; it may have no Slack user (no DM).
- In channels, `!command` runs only for the agent's owner (option a); `$` commands stay open.
- Every reply gets a footer `📁 folder · 🌿 branch · model` (plus the change counts); in a code channel the
  context bar shows those, so the footer keeps only the change counts.
- `$done` archives a code channel; nothing archives automatically.

**Verified live (2026-10-12):** `agents.conversations.create` (with and without an origin), `setProperties`,
`setView` (diff), `agents.sessions.setStatus` and `chat.postMessage` work for our app. `setProperties` on a DM or
a normal channel returns `not_authorized`: the context bar exists only in code channels.

---

### Task 0: Spike — Slack app scopes, and how a restarted relay knows a code channel's owner

No code. Decides Task 4's registry.

**Step 1:** In the Slack app config, add bot scopes `channels:history`, `groups:history`, `channels:read`,
`groups:read` and bot events `message.channels`, `message.groups`; reinstall. (`code_channels:manage` and
`features.code_channels.enabled` are already there.)

**Step 2:** With the scratchpad helper (`slack.sh`, token piped from the k8s secret, never printed), form-encoded:
`conversations.info channel=C0C8AH2S8GK` and `conversations.history channel=C0C8AH2S8GK limit=5`.

**Step 3:** Look for anything tying the code channel to its origin channel (an `origin`/`code_channel`
property, the first message's attachment pointing at `C09UV0MCV70`, `creator`).

**Outcome A (origin readable):** the relay maps an unknown code channel to its owner through its origin
channel's `CHANNELS` entry, statelessly.
**Outcome B (not readable):** the relay keeps the code-channel → owner map in memory from the `create`
responses, and the daemon re-announces its code channels after connecting (Task 4, step B). Record the outcome
in the plan before Task 4.

**Result (2026-10-12): Outcome A.** `conversations.info` on a code channel returns
`properties.agent_session.origin_link = { channel_id: "C09UV0MCV70", ts }` (the origin message) and
`properties.record_channel.record_id` ending in our `session_id`. A code channel created without an origin has
no `origin_link` and stays unmapped.

---

### Task 1: Relay config — `CHANNELS` and `CODE_CHANNELS`

**Files:**
- Modify: `relay/src/gateway.ts` (GatewayConfig, new exported `parseChannels`)
- Modify: `relay/src/main.ts` (env)
- Test: `relay/test/e2e.test.ts` (unit test near `addPreamble`'s)

**Step 1: Failing test**

```ts
test("CHANNELS maps channel names to owners; CODE_CHANNELS must be among them", () => {
  assert.deepEqual(parseChannels("#_tmp_jcm = Pepe@Example.com, sales=bot@example.com", "_tmp_jcm"), {
    _tmp_jcm: { email: "pepe@example.com", code: true },
    sales: { email: "bot@example.com", code: false },
  });
  assert.deepEqual(parseChannels("", ""), {});
  assert.throws(() => parseChannels("sales=bot@example.com", "other"), /CODE_CHANNELS: other is not in CHANNELS/);
  assert.throws(() => parseChannels("sales", ""), /CHANNELS: "sales" is not name=email/);
});
```

**Step 2:** `npm test -w relay` → FAIL (`parseChannels` not exported).

**Step 3: Implement**

```ts
/** "name=email,…" and "name,…" (a leading # is dropped) -> channel name -> its owner. */
export function parseChannels(channels: string, code: string): Record<string, { email: string; code: boolean }> {
  const names = (s: string) => s.split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean);
  const out: Record<string, { email: string; code: boolean }> = {};
  for (const entry of channels.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [name, email] = entry.split("=").map((x) => x?.trim());
    if (!name || !email) throw new Error(`CHANNELS: "${entry}" is not name=email`);
    out[name.replace(/^#/, "")] = { email: email.toLowerCase(), code: false };
  }
  for (const name of names(code)) {
    if (!out[name]) throw new Error(`CODE_CHANNELS: ${name} is not in CHANNELS`);
    out[name].code = true;
  }
  return out;
}
```

GatewayConfig gets `channels?: Record<string, { email: string; code: boolean }>`. `main.ts`:
`channels: parseChannels(process.env.CHANNELS ?? "", process.env.CODE_CHANNELS ?? "")`, and the two lines in
its env comment.

**Step 4:** `npm test -w relay` → PASS. **Step 5:** commit `feat(relay): CHANNELS and CODE_CHANNELS config`.

---

### Task 2: Relay — route a configured channel's messages to its owner; owners without a Slack user

**Files:** `relay/src/gateway.ts` (routeKey, onUpstream, createOwner), `relay/test/mock-slack.ts`
(`conversations.info` answers `{ channel: { id, name } }` from a `channels` map given to `createMockSlack`),
`relay/test/e2e.test.ts`.

**Behaviour:**
- `routeKey` also returns `{ channel }` (no user) for `message` events with `channel_type` `channel`/`group`
  (users' messages, `file_share`, and their edits as today), and for `agent_session_stopped` in a channel.
- `onUpstream`: when the key has a non-DM channel, `ownerForChannel(id)` resolves it: a cache
  `channelOwner: Map<id, Owner | null>`; on a miss, `conversations.info` → name → `cfg.channels[name]` →
  `ownerFor(email)`. Unmapped channels cache `null` and the event is dropped (`log("channel_unmapped")`).
- The forwarded event gets `ev.code_channel_origin = true` when the channel is in `CODE_CHANNELS` (the daemon's
  only hint; it never sees the config).
- `createOwner(email)`: when `users.lookupByEmail` fails **and** the email owns a channel in `cfg.channels`, it
  returns an owner with `slackUserId: ""`, `dm: ""` (a service account). Any other email without a Slack user
  stays rejected (today's behaviour).
- Offline (no daemon connected): the notice goes in the message's thread in that channel, as for DMs.

**Tests (write first, see them fail, implement, see them pass):**
1. "a message in a configured channel reaches the channel's owner, with code_channel_origin only in
   CODE_CHANNELS": mock channels `C_DEV`=`dev` (→ PEPE), `C_CODE`=`code` (code), `C_OTHER`=`other` (unmapped);
   assert pepe's daemon gets the first two, the second with the flag, and nothing for `C_OTHER`.
2. "a message in a channel goes to the owner's daemon even when someone else wrote it" (user `UXAVI` in `C_DEV`).
3. "a service account without a Slack user connects when it owns a channel; other unknown emails do not":
   resolver maps a token to `bot@example.com` (no Slack user), `CHANNELS` has `sales=bot@example.com`; its Bolt
   client connects and receives `C_SALES` messages; a token for `nobody@example.com` gets `invalid_auth`.

Commit: `feat(relay): route configured channels to their owner`.

---

### Task 3: Relay — the owner's Web API reaches its channels and code channels

**Files:** `relay/src/gateway.ts` (apiCall, CHANNEL_SCOPED), `relay/test/mock-slack.ts`
(`agents.conversations.create` → `{ ok: true, channel_id: "CCODE" + n }`; `setProperties`, `setView`,
`archive` → ok), `relay/test/e2e.test.ts`.

**Behaviour:**
- Allowed targets for an owner: its DM and user id (today) **plus** every channel id `ownerForChannel` mapped to
  it **plus** its code channels (`codeChannels: Map<id, Owner>`).
- New scoped methods: `agents.conversations.setProperties`, `.setView`, `.archive` (`channel_id`).
- `agents.conversations.create`: allowed only when `origin_channel_id` is a `CODE_CHANNELS` channel of this owner;
  on `ok`, `codeChannels.set(channel_id, owner)`. Without an origin: refused (`restricted_action`).
- `chat.postEphemeral` in a channel of the owner: any `user` (an edit's author); in the DM: only the owner (today).
- `users.info`: any user once the owner has a channel (the daemon names who wrote each message); only the owner
  otherwise (today).
- `conversations.info` stays scoped (the daemon does not need it).

**Tests:**
1. "an owner's daemon posts in its channel and not in another" (`C_DEV` ok, `C_OTHER` `restricted_action`).
2. "a code channel can be created only from a CODE_CHANNELS origin, and is then the owner's":
   from `C_DEV` → refused; from `C_CODE` → ok; then `setProperties` / `chat.postMessage` on the new id → ok;
   another owner's daemon on it → refused.
3. "ephemeral notices in a channel may go to any member; in the DM only to the owner".

Commit: `feat(relay): scope the Web API to an owner's channels and code channels`.

---

### Task 4: Relay — code channel messages, and code channels after a relay restart

**Files:** `relay/src/gateway.ts`, `relay/test/e2e.test.ts`.

- Messages in a code channel route through `codeChannels` (a code channel is never in `CHANNELS`).
- **Outcome A (Task 0):** on a miss, resolve the origin channel from Slack and map through `cfg.channels`.
- **Outcome B:** the daemon calls `agents.conversations.setProperties` with its current context bar for each
  code channel it holds, right after connecting (it does so anyway, Task 9); the relay accepts that first call
  for an unknown code channel only if `conversations.members` shows the owner (or, for a service account, the
  bot alone plus users who wrote in its channels — revisit in Task 0) — keep whichever check Task 0 proves.

**Test:** "after a relay restart a code channel's messages still reach its owner" (restart the gateway in the
test, then emit a message in `CCODE1`).

Commit: `feat(relay): code channel messages reach their owner, also after a restart`.

---

### Task 5: Relay — interactions from a channel go to the channel's owner

**Files:** `relay/src/gateway.ts` (routeKey for `interactive`), `relay/test/e2e.test.ts`.

Today interactive payloads route by the clicking user. In channels anyone may click (New session, answers,
Allow once). Order:
1. `body.channel?.id` (or `body.container?.channel_id`) is a channel or code channel of an owner → that owner;
2. `body.view?.id` is in a new `viewOwner: Map<viewId, Owner>` (filled where `owner.views` is filled) → that
   owner (the picker modal's submit has no channel);
3. else the user, as today.
The `trigger_id`/`view_id` checks stay per owner.

**Test:** "a button in a channel thread clicked by another user reaches the channel owner's daemon, and its
modal's submit too".

Commit: `fix(relay): route channel interactions to the channel's owner`.

---

### Task 6: Relay — `!` only for the owner in channels; the context block names the author

**Files:** `relay/src/gateway.ts` (onUpstream, addPreamble's caller), `relay/test/e2e.test.ts`.

- In a channel or code channel, a message whose text (after a leading `<@BOT>` mention) starts with `!` from a
  user other than `owner.slackUserId` is not forwarded; the author gets an ephemeral
  `"🔒 Only <@OWNER> can run shell commands here."` (`"…only in the agent's own DM."` for a service account).
- `addPreamble` in a channel uses the message's author (users.info, cached in `authors: Map`), not the owner.

**Tests:** "`!ls` from a non-owner in a channel is refused with an ephemeral note; from the owner it passes";
"a channel message's context block names its author".

Commit: `feat(relay): owner-only shell commands in channels`.

---

### Task 7: Daemon — top-level threads (refactor, no behaviour change)

**Files:** `daemon/src/daemon.ts`, `daemon/src/output.ts`.

A code channel is a session whose messages go in the channel, not a thread. Add `top?: boolean` to `Thread`,
`Pending` and the `Where` type; one helper `const inThread = (w: Where) => (w.top ? undefined : w.thread)` and
use it for every `thread_ts:` the daemon sets (`say`, `shell`, `upload`, `chose`, `start`, permission/ask posts,
Retry). `createOutput` gets `thread?: string` and omits `thread_ts` from `chat.startStream` and
`agents.sessions.setStatus` when it is undefined.

**Step:** `make test` → all pass unchanged (59/60). Commit: `refactor(daemon): sessions that post in the channel itself`.

---

### Task 8: Daemon — a mention in a channel starts a session in its thread

**Files:** `daemon/src/daemon.ts` (app.message, offerPicker, the long-turn notice), `daemon/test/e2e.test.ts`
(the daemon test's relay gets `channels: { dev: { email: PEPE_EMAIL, code: false } }` and the mock Slack
`C_DEV`=`dev`).

- `const isDM = (c: string) => c.startsWith("D")`; the bot's user id from Bolt's `context.botUserId`.
- Top-level message in a channel: only when it mentions the bot (`<@BOT>`); the mention is stripped from the
  text. Without a mention it is ignored. A top-level DM message starts a picker as today.
- In a channel the picker greeting goes **in the thread** under the mention (`thread_ts: m.ts`), and so do the
  session question and header; the greeting is not turned into an "Open thread" link.
- Thread replies in a channel reach the session without a mention (like the DM).
- The long-turn "✅ Done in … → Open thread" notice is posted only in DMs (in a channel it would be noise).
- `$` commands without a thread in a channel: ignored unless they mention the bot.

**Tests:** "a mention in a channel opens the picker in its thread and the reply runs the session there";
"a channel message without a mention is ignored"; "a thread reply in a channel needs no mention".

Commit: `feat(daemon): sessions in channel threads`.

---

### Task 9: Daemon — a mention in a code-channel origin opens a code channel

**Files:** `daemon/src/daemon.ts`, `daemon/test/e2e.test.ts` (mock: `C_CODE`=`code`, code; the relay creates
`CCODE1`).

- Top-level mention with `code_channel_origin`: `agents.conversations.create({ origin_channel_id, origin_message_ts,
  session_id: m.ts, is_private: true })`. The picker (`offerPicker` with `top: true`, channel = the new id,
  key = the new id) is posted in the code channel; the first message waits as today. On `ok: false` the daemon
  says so in the origin's thread and falls back to Task 8 (a thread session).
- In the origin's thread: `"🧑‍💻 Working in <#CCODE1>"` so people find it.
- Messages in a code channel: `threads[m.channel]` when `m.thread_ts` is unset; a reply in a thread inside the
  code channel goes to the same session.
- Status (`agents.sessions.setStatus`) with `channel_id` only.

**Tests:** "a mention in a CODE_CHANNELS channel opens a code channel with the picker in it, and the session
replies there, top-level"; "if the code channel cannot be created, the session opens in the thread".

Commit: `feat(daemon): sessions in Slack code channels`.

---

### Task 10: Daemon — context bar, Changes tab, `$done`

**Files:** `daemon/src/daemon.ts`, `daemon/test/e2e.test.ts`.

- `contextBar(t)`: `[{ key: "folder", label: short(t.cwd), icon: "folder" }, { key: "branch", label: branch, icon:
  "branch" } (git only), { key: "model", label: model name, icon: "terminal" }]` → `setProperties`. Sent when the
  session starts, after a `$model`/cfg change, and at the end of each turn (the branch may change). After a
  daemon start, sent once per code channel (also re-announces it to the relay, Task 4 outcome B).
- Changes tab: after a turn with edits in a git folder, `setView({ view_key: "changes", type: "diff", content:
  git diff HEAD (clipped to 200 KB), base_branch, head_branch })`. Non-git folders: no tab.
  ponytail: `git diff HEAD` shows the whole working tree, including changes made outside the session.
- `$done` (code channels only; elsewhere "only in a code channel"): post `"✅ Session closed · <id> · resume it
  from the picker's Previous session"`, then `agents.conversations.archive({ channel_id, summary_message_ts })`,
  forget the thread mapping (the session stays resumable).
- `$help` lists `$done`.

**Tests:** context bar items after start and after a model change; a turn with an edit sets the diff view (the
test folder is a git repo with one commit); `$done` posts the summary and archives; `$done` in a DM explains.

Commit: `feat(daemon): code channel context bar, Changes tab and $done`.

---

### Task 11: Daemon — footer `📁 folder · 🌿 branch · model` under every reply

**Files:** `daemon/src/daemon.ts` (`editLine` → `footer`), `daemon/test/e2e.test.ts`.

- Every finished turn (not only those with edits) ends with a context block:
  `📁 \`ach-channelmux\` · 🌿 \`main\` · ackstorm.super · 2 files changed +12 −3` (branch only in git; model from
  the session's `model` option name; the change counts only when there were edits).
- In a code channel the bar already shows folder, branch and model: the footer keeps only the change counts
  (and is omitted when there were none).

**Tests:** update the "Changes" test's expected line; new: "a reply without edits shows folder and model".

Commit: `feat(daemon): folder, branch and model under every reply`.

---

### Task 12: Manifest, chart, docs

**Files:** `slack-app-manifest.json` (code_channels feature; scopes `code_channels:manage`, `channels:history`,
`groups:history`, `channels:read`, `groups:read`; events `message.channels`, `message.groups`),
`chart/values.yaml` + `chart/templates/deployment.yaml` (`channels` / `codeChannels` values → `CHANNELS` /
`CODE_CHANNELS`, empty by default), `README.md` (new rows: Channels, Code channels, Shared agents, footer;
Inbound and Permissions rows updated), `CLAUDE.md` layout line.

**Step:** `make test` (tests + helm lint) → pass. Commit: `docs: channels and code channels`.

---

### Task 13: Release and live check

1. `make release-cut VERSION=0.3.0` (new feature set), `gh run watch`.
2. Daemon on the pod: `up66.sh`-style script from the scratchpad.
3. Relay: Flux picks up the chart; setting `channels: "_tmp_jcm=juancarlos.moreno@ackstorm.com"` and
   `codeChannels: "_tmp_jcm"` in the HelmRelease values is a **cluster write: ask the user first**.
4. Live in Slack: a mention in #_tmp_jcm opens a code channel; picker; a turn with an edit; context bar and
   Changes tab; `$done`. A DM session still works and shows the new footer.
5. Archive the two test code channels from 2026-10-12 (`C0C8GHZ1CR0`, `C0C8AH2S8GK`) once the user says so.
