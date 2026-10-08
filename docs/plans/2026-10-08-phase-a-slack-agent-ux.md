# Phase A: Slack agent UX at 40–200 users — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give each user a "Slack Code"-like experience: native streaming with tool cards, session status, a stop button, files in, and clear permission prompts. It must hold up with 40–200 concurrent users who share one Slack app's rate limits.

**Architecture:** The relay becomes the single place that spends the Slack app's per-method budget. It keeps a paced queue per method, retries 429s using their Retry-After, merges queued edits and appends to the same message, and refuses `chat.startStream` instead of queueing it. The daemon renders each ACP turn through a small `output.ts`: native streaming (`chat.startStream` with `task_update` chunks) when Slack and the relay allow it, and plain messages per finished text segment for the rest of the turn when they don't. The working-indicator reaction (👀) is replaced by `agents.sessions.setStatus`.

**Tech Stack:** Node ≥ 22.18 type stripping (erasable TS only, no build step), `@slack/bolt` 4 / `@slack/web-api` 7.19, `@agentclientprotocol/sdk` 1.7, `node:test`.

**Background facts (verified 2026-10-08, see Slack docs):**
- **Rate limits are per method, per workspace, per app.** All daemons share one bucket per method. The exception is posting, limited to about 1 message per second per channel. Tiers:

  | Method | Tier |
  |---|---|
  | `chat.startStream`, `chat.stopStream` | Tier 2 (20+/min) |
  | `chat.appendStream` | Tier 4 (100+/min) |
  | `chat.update`, `chat.delete`, `reactions.add`/`remove`, `agents.sessions.setStatus` | Tier 3 (50+/min) |

- **Today the relay forwards Slack's 429 to daemons as HTTP 200 `{ok:false,error:"ratelimited"}`**, so Bolt never retries and the call fails silently. `relay/src/gateway.ts`, `slack()`.
- **`agents.sessions.setStatus`** takes `channel_id`, `thread_ts` (required for DM threads), `status` (`processing|active|suspended|closed`), and `title` (only applied when the session is created).
  - `chat.startStream` sets the session to `processing`; `chat.stopStream` sets it back to `active`.
  - Slack shows the native stop button only when the app subscribes to `agent_session_stopped`.
  - That event carries `channel`, `thread_ts` and `user`.
- **Chunks:**
  - `markdown_text` up to 12k characters.
  - `task_update` `{id, title ≤256, status: pending|in_progress|complete|error}`.
  - `recipient_*` fields are not needed in DMs.
  - Blocks are only allowed on `chat.stopStream`, so permission buttons are posted between streams.
- **Manifest:** `features.agent_view`, scope `assistant:write`, bot event `agent_session_stopped`.

**Rules for the executor (repo CLAUDE.md):**
- Every behaviour change comes with a test.
- `make test` must pass after every task.
- Never log daemon tokens.
- Use conventional commits; end every commit message with the attribution lines in effect for the session.
- Nothing Coder-specific goes in `relay/`, `daemon/` or `chart/`.

---

### Task 0: Branch and baseline

The restructure and the MVP daemon are staged on `main` but not committed.

**Step 1:** `git switch -c feat/phase-a`
**Step 2:** `make test`. Expected: relay 17 pass, daemon 4 pass, helm lint OK.
**Step 3:** Commit the staged work. Leave the untracked `cc-connect/` clone out.

```bash
git add -A -- . ':!cc-connect'
git commit -m "refactor: split relay and ACP daemon into npm workspaces"
```

---

### Task 1: Relay rate limiter (unit)

**Files:**
- Create: `relay/src/limiter.ts`
- Create: `relay/test/limiter.test.ts`
- Modify: `relay/package.json` (add `test/limiter.test.ts` to the `test` script)

**Step 1: Write the failing test** `relay/test/limiter.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimiter } from "../src/limiter.ts";

// Fake upstream: records calls; `plan` returns HTTP statuses in order (default 200).
function fake(plan: number[] = [], delayMs = 0) {
  const calls: { method: string; params: any; at: number }[] = [];
  const call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params, at: Date.now() });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const status = plan.shift() ?? 200;
    return status === 429 ? { status, retryAfter: 0.05, body: { ok: false, error: "ratelimited" } } : { status, body: { ok: true } };
  };
  return { calls, call };
}

test("paces calls of a method to its rate", async () => {
  const f = fake();
  const slack = createLimiter(f.call, { rates: { "x.paced": 600 } }); // one per 100 ms
  await Promise.all([1, 2, 3].map(() => slack("x.paced", {})));
  const gaps = f.calls.slice(1).map((c, i) => c.at - f.calls[i].at);
  assert.ok(gaps.every((g) => g >= 90), `gaps ${gaps}`);
});

test("methods without a rate are not paced", async () => {
  const f = fake();
  const slack = createLimiter(f.call, { rates: {} });
  const t0 = Date.now();
  await Promise.all([1, 2, 3].map(() => slack("chat.update", {})));
  assert.ok(Date.now() - t0 < 50);
});

test("queued edits of one message merge into the latest", async () => {
  const f = fake([], 30);
  const slack = createLimiter(f.call, { rates: { "chat.update": 6000 } });
  const r = await Promise.all(["a", "b", "c"].map((text) => slack("chat.update", { channel: "D1", ts: "1.0", text })));
  assert.deepEqual(f.calls.map((c) => c.params.text), ["a", "c"]); // "a" was in flight; "b" was replaced by "c"
  assert.ok(r.every((x) => x.ok));
});

test("queued appends to one stream concatenate their chunks", async () => {
  const f = fake([], 30);
  const slack = createLimiter(f.call, { rates: { "chat.appendStream": 6000 } });
  const task = { type: "task_update", id: "t", title: "ls", status: "in_progress" };
  await Promise.all([
    slack("chat.appendStream", { channel: "D1", ts: "1.0", markdown_text: "one" }),
    slack("chat.appendStream", { channel: "D1", ts: "1.0", markdown_text: "two" }),
    slack("chat.appendStream", { channel: "D1", ts: "1.0", chunks: JSON.stringify([task]) }),
  ]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].params.chunks, [{ type: "markdown_text", text: "two" }, task]);
});

test("a 429 waits Retry-After and retries", async () => {
  const f = fake([429]);
  const slack = createLimiter(f.call, { rates: {} });
  assert.deepEqual(await slack("chat.postMessage", {}), { ok: true });
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].at - f.calls[0].at >= 45);
});

test("chat.startStream is refused, not queued, when the wait would be long", async () => {
  const f = fake();
  const slack = createLimiter(f.call, { rates: { "chat.startStream": 60 }, maxStreamStartWaitMs: 200 });
  const [a, b] = await Promise.all([slack("chat.startStream", {}), slack("chat.startStream", {})]);
  assert.deepEqual(a, { ok: true });
  assert.deepEqual(b, { ok: false, error: "ratelimited" });
  assert.equal(f.calls.length, 1);
});
```

Add `test/limiter.test.ts` to `relay/package.json` → `scripts.test`.

**Step 2:** `cd relay && npm test`. Expected: FAIL, `Cannot find module '../src/limiter.ts'`.

**Step 3: Implement** `relay/src/limiter.ts`

```ts
// Shared Slack Web API budget. Every daemon behind the relay shares the app's per-method
// rate limits (per method, per workspace, per app), so upstream calls queue per method,
// paced to the method's tier. A 429 pauses the method for Retry-After and retries. Queued
// chat.update / chat.appendStream calls for the same message merge. chat.startStream is
// refused when the wait would be long, so the daemon streams nothing and falls back to
// plain messages for that turn.

export type UpstreamCall = (
  method: string,
  params: Record<string, unknown>,
) => Promise<{ status: number; retryAfter?: number; body: any }>;

/** Calls per minute: Slack's documented tier floors. Methods not listed are not paced. */
export const RATES: Record<string, number> = {
  "chat.startStream": 20,
  "chat.stopStream": 20,
  "chat.appendStream": 100,
  "chat.update": 50,
  "chat.delete": 50,
  "reactions.add": 50,
  "reactions.remove": 50,
  "agents.sessions.setStatus": 50,
  "agents.sessions.rename": 50, // tier not documented; assume Tier 3
};

export interface LimiterOptions {
  /** Replaces RATES (calls per minute). {} disables pacing; 429s are still retried. */
  rates?: Record<string, number>;
  /** chat.startStream is refused when it would wait longer than this. Default 2 s. */
  maxStreamStartWaitMs?: number;
  /** Retries after a 429. Default 3. */
  maxRetries?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

interface Job {
  params: Record<string, any>;
  waiters: ((body: any) => void)[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chunksOf = (p: Record<string, any>): unknown[] =>
  p.chunks === undefined
    ? [{ type: "markdown_text", text: p.markdown_text ?? "" }]
    : typeof p.chunks === "string" ? JSON.parse(p.chunks) : p.chunks;

export function createLimiter(call: UpstreamCall, opts: LimiterOptions = {}) {
  const rates = opts.rates ?? RATES;
  const maxStartWait = opts.maxStreamStartWaitMs ?? 2000;
  const maxRetries = opts.maxRetries ?? 3;
  const log = opts.log ?? (() => {});
  const lanes = new Map<string, { queue: Job[]; next: number; busy: boolean }>();

  async function send(method: string, params: Record<string, unknown>) {
    for (let attempt = 0; ; attempt++) {
      const r = await call(method, params);
      if (r.status !== 429) return r.body;
      const waitMs = (r.retryAfter ?? 1) * 1000;
      log("ratelimited", { method, wait_ms: waitMs, attempt });
      const lane = lanes.get(method);
      if (lane) lane.next = Math.max(lane.next, Date.now() + waitMs);
      if (attempt >= maxRetries) return { ok: false, error: "ratelimited" };
      await sleep(waitMs);
    }
  }

  async function drain(method: string, lane: { queue: Job[]; next: number; busy: boolean }) {
    lane.busy = true;
    while (lane.queue.length) {
      const wait = lane.next - Date.now();
      if (wait > 0) await sleep(wait);
      const job = lane.queue.shift()!;
      lane.next = Date.now() + 60_000 / rates[method];
      const body = await send(method, job.params).catch((err) => ({ ok: false, error: String(err) }));
      for (const w of job.waiters) w(body);
    }
    lane.busy = false;
  }

  // Merge into a queued (not yet sent) call for the same message.
  function merge(queue: Job[], method: string, params: Record<string, any>, waiter: (body: any) => void) {
    if (method !== "chat.update" && method !== "chat.appendStream") return false;
    const job = queue.find((j) => j.params.channel === params.channel && j.params.ts === params.ts);
    if (!job) return false;
    job.params =
      method === "chat.update"
        ? params
        : { ...job.params, markdown_text: undefined, chunks: [...chunksOf(job.params), ...chunksOf(params)] };
    job.waiters.push(waiter);
    return true;
  }

  return function limited(method: string, params: Record<string, unknown>): Promise<any> {
    const rate = rates[method];
    if (!rate) return send(method, params);
    let lane = lanes.get(method);
    if (!lane) lanes.set(method, (lane = { queue: [], next: 0, busy: false }));
    const wait = Math.max(0, lane.next - Date.now()) + (lane.queue.length * 60_000) / rate;
    if (method === "chat.startStream" && wait > maxStartWait) {
      log("stream_refused", { wait_ms: Math.round(wait) });
      return Promise.resolve({ ok: false, error: "ratelimited" });
    }
    return new Promise((resolve) => {
      if (!merge(lane.queue, method, params, resolve)) lane.queue.push({ params, waiters: [resolve] });
      if (!lane.busy) void drain(method, lane);
    });
  };
}
```

**Step 4:** `cd relay && npm test`. Expected: PASS, with the 6 new limiter tests included.

**Step 5:** Commit: `feat(relay): add a shared Slack rate limiter`.

---

### Task 2: Route all relay upstream calls through the limiter

**Files:**
- Modify: `relay/src/gateway.ts` (`GatewayConfig`; `slack()` at about lines 337–352)
- Modify: `relay/src/main.ts` (no change needed: defaults apply)
- Modify: `relay/test/mock-slack.ts` (rate windows and forced failures)
- Modify: `relay/test/e2e.test.ts` (`rates: {}` in the gateway config; new test)

**Step 1: Mock Slack learns 429s and forced errors.** In `createMockSlack`, after `calls.push(...)` and before the `switch`:

```ts
    const limit = mock.limits[method];
    if (limit) {
      const now = Date.now();
      const hits = (windows.get(method) ?? []).filter((t) => now - t < limit.windowMs);
      if (hits.length >= limit.max) {
        mock.rateLimited++;
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        return res.end(JSON.stringify({ ok: false, error: "ratelimited" }));
      }
      windows.set(method, [...hits, now]);
    }
    const failure = mock.fail.get(method);
    if (failure) return send({ ok: false, error: failure });
```

Add `const windows = new Map<string, number[]>();` next to `calls`. Add these fields to `mock`:

```ts
    /** Per-method sliding windows; over the limit answers HTTP 429 with Retry-After: 1. */
    limits: {} as Record<string, { max: number; windowMs: number }>,
    /** Methods that answer ok:false with this error. */
    fail: new Map<string, string>(),
    /** How many 429s were answered. */
    rateLimited: 0,
```

**Step 2: Write the failing test** in `relay/test/e2e.test.ts`, after the interactivity test:

```ts
test("a 429 from Slack is retried by the relay, not returned to the daemon", async () => {
  slack.limits["chat.update"] = { max: 1, windowMs: 500 };
  try {
    const a = await pepe1.app.client.chat.update({ channel: "D_UPEPE", ts: "1.0", text: "a" });
    const b = await pepe1.app.client.chat.update({ channel: "D_UPEPE", ts: "2.0", text: "b" });
    assert.ok(a.ok && b.ok);
    assert.equal(slack.rateLimited, 1);
  } finally {
    delete slack.limits["chat.update"];
  }
});
```

In the `createGateway({...})` call of that file, add `rates: {}`. The tests check routing, not pacing, and the working-notice test edits every 150 ms.

**Step 3:** `cd relay && npm test`. Expected: the new test FAILS (`An API error occurred: ratelimited`).

**Step 4: Implement.**
- In `GatewayConfig` add:
  ```ts
    /** Slack calls per minute per method (default RATES in limiter.ts); {} disables pacing. */
    rates?: Record<string, number>;
    /** chat.startStream is refused when it would wait longer. Default 2 s. */
    maxStreamStartWaitMs?: number;
  ```
- Replace `slack()` with:

```ts
  async function upstreamCall(method: string, params: Record<string, unknown>) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    const res = await fetch(upstream + method, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.botToken}`, "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (res.status === 429) return { status: 429, retryAfter: Number(res.headers.get("retry-after")) || 1, body: null };
    return { status: res.status, body: await res.json() };
  }
  const slack = createLimiter(upstreamCall, { rates: cfg.rates, maxStreamStartWaitMs: cfg.maxStreamStartWaitMs, log });
```

- Import: `import { createLimiter } from "./limiter.ts";`
- Update the header comment of `gateway.ts`: add "- spends the Slack app's shared rate limits for every daemon (limiter.ts)".

**Step 5:** `make test`. Expected: all PASS. Also add `rates: {}` to the gateway config in `daemon/test/e2e.test.ts`.

**Step 6:** Commit: `feat(relay): pace and retry upstream Slack calls`.

---

### Task 3: Allowlist streaming and agent sessions; route the stop event

**Files:**
- Modify: `relay/src/gateway.ts` (`CHANNEL_SCOPED` at about line 78; `routeKey` at about line 452; the `threadOf` bookkeeping in `onUpstream` at about line 508)
- Modify: `relay/test/e2e.test.ts` (the `daemon()` helper and a new test)
- Modify: `slack-app-manifest.json`

**Step 1: Write the failing test.** In the `daemon()` helper add:

```ts
  app.event("agent_session_stopped", async ({ event }) => {
    d.got.push(event);
  });
```

Add a new test after the 429 test:

```ts
test("agent sessions: streams and status are scoped to the owner's DM; stop events reach the owner", async () => {
  const c = pepe1.app.client;
  assert.ok((await c.apiCall("chat.startStream", { channel: "D_UPEPE", thread_ts: "80.0", markdown_text: "hi" })).ok);
  assert.ok((await c.apiCall("agents.sessions.setStatus", { channel_id: "D_UPEPE", thread_ts: "80.0", status: "processing" })).ok);
  await assert.rejects(c.apiCall("chat.startStream", { channel: "D_UXAVI", thread_ts: "80.0", markdown_text: "x" }), /restricted_action/);
  await assert.rejects(c.apiCall("agents.sessions.setStatus", { thread_ts: "80.0", status: "processing" }), /restricted_action/);

  const n = pepe1.got.length;
  await slack.emit("events_api", {
    type: "event_callback",
    event_id: "EvStop1",
    team_id: "T1",
    api_app_id: "A1",
    event: { type: "agent_session_stopped", channel: "D_UPEPE", thread_ts: "80.0", user: "UPEPE" },
  });
  await waitFor(() => pepe1.got.length > n);
  assert.equal(pepe1.got.at(-1).type, "agent_session_stopped");
});
```

**Step 2:** `cd relay && npm test`. Expected: FAIL (`restricted_action` on `chat.startStream`).

**Step 3: Implement.**
- `CHANNEL_SCOPED`, add:
  ```ts
  "chat.startStream": ["channel"],
  "chat.appendStream": ["channel"],
  "chat.stopStream": ["channel"],
  "agents.sessions.setStatus": ["channel_id"],
  "agents.sessions.rename": ["channel_id"],
  ```
  Check the `agents.sessions.rename` reference page; if its channel argument is not `channel_id`, use that name.
- `routeKey`, events_api branch. Before the message checks:
  ```ts
      if (ev?.type === "agent_session_stopped") return ev.user ? { userId: ev.user, channel: ev.channel } : null;
  ```
- In `onUpstream`, run the preamble and `threadOf` bookkeeping only for messages: wrap the three lines in `if (ev.type === "message") { ... }`.
- `slack-app-manifest.json`:
  - Add `"agent_view": { "agent_description": "Your coding agent, in your own workspace.", "suggested_prompts": [] }` under `features`.
  - Add `"assistant:write"` to the bot scopes.
  - Set `bot_events` to `["message.im", "agent_session_stopped"]`.

**Step 4:** `make test`. Expected: PASS.

**Step 5:** Commit: `feat(relay): allow Slack streaming and agent sessions, route stop events`.

---

### Task 4: Load test with 200 daemons

**Files:**
- Create: `relay/test/load.test.ts`
- Modify: `relay/package.json` (add it to `test`)

**Step 1: Write the test.** It should pass if Tasks 1–3 are right; it guards against regressions.

```ts
// Load: 200 daemons share one Slack app. Mock Slack enforces per-method windows; the relay
// must pace, merge and refuse so that daemons never see a rate-limit error on posts and edits.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createGateway } from "../src/gateway.ts";
import { createMockSlack, APP_TOKEN, BOT_TOKEN } from "./mock-slack.ts";

const N = 200;
const slack = createMockSlack(Object.fromEntries(Array.from({ length: N }, (_, i) => [`U${i}`, `u${i}@example.com`])));
slack.limits = { "chat.update": { max: 50, windowMs: 1000 }, "chat.startStream": { max: 5, windowMs: 1000 } };
const PORT = await new Promise<number>((r) => {
  const s = createServer().listen(0, () => {
    const p = (s.address() as any).port;
    s.close(() => r(p));
  });
});
const GW = `http://127.0.0.1:${PORT}`;
let gw: ReturnType<typeof createGateway>;

before(async () => {
  await slack.start();
  gw = createGateway({
    port: PORT,
    publicUrl: GW,
    upstreamApiUrl: `${slack.url}/api/`,
    appToken: APP_TOKEN,
    botToken: BOT_TOKEN,
    resolveToken: async (t) => (t.startsWith("tok-") ? `u${t.slice(4)}@example.com` : null),
    rates: { "chat.update": 2400, "chat.startStream": 240 }, // 40/s and 4/s, under the mock's windows
    maxStreamStartWaitMs: 500,
    workingNoticeMs: 0,
    log: () => {},
  });
  await gw.start();
});
after(async () => {
  await gw.stop();
  await slack.stop();
});

const api = async (i: number, method: string, params: Record<string, string>) =>
  (
    await fetch(`${GW}/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer tok-${i}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    })
  ).json();

test("200 daemons posting, editing and streaming at once stay within Slack's limits", { timeout: 60_000 }, async () => {
  const results = await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const channel = `D_U${i}`;
      const post = await api(i, "chat.postMessage", { channel, text: "working" });
      const edits = await Promise.all([1, 2, 3, 4, 5].map((n) => api(i, "chat.update", { channel, ts: post.ts, text: `step ${n}` })));
      const stream = await api(i, "chat.startStream", { channel, thread_ts: post.ts, markdown_text: "hi" });
      return { post, edits, stream };
    }),
  );
  assert.ok(results.every((r) => r.post.ok && r.edits.every((e: any) => e.ok)), "every post and edit succeeded");
  const updates = slack.calls.filter((c) => c.method === "chat.update").length;
  assert.ok(updates < (N * 5) / 2, `${updates} chat.update calls reached Slack (merging)`);
  const refused = results.filter((r) => !r.stream.ok);
  assert.ok(refused.length > 0 && refused.every((r) => r.stream.error === "ratelimited"), "excess streams refused fast");
  assert.equal(slack.rateLimited, 0, "the relay never exceeded Slack's limits");
});
```

**Step 2:** `cd relay && npm test`. Expected: PASS in under about 15 s. If `rateLimited > 0`, the pacing is wrong; fix the limiter, not the test.

**Step 3:** Commit: `test(relay): load test with 200 daemons against Slack limits`.

---

### Task 5: Daemon turn output (`output.ts`, unit)

**Files:**
- Create: `daemon/src/output.ts`
- Create: `daemon/test/output.test.ts`
- Modify: `daemon/package.json` (`test` script: add `test/output.test.ts`)

**Step 1: Write the failing test** `daemon/test/output.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutput, splitMarkdown } from "../src/output.ts";

function fakeApi(fail: Record<string, string> = {}) {
  const calls: { method: string; params: any }[] = [];
  let n = 0;
  const api = async (method: string, params: any) => {
    calls.push({ method, params });
    if (fail[method]) throw new Error(`An API error occurred: ${fail[method]}`);
    return { ok: true, ts: `9.${++n}` };
  };
  return { api, calls };
}
const where = { channel: "D1", thread: "1.0" };
const chunks = (calls: { params: any }[]) => calls.flatMap((c) => c.params.chunks ?? []);

test("splitMarkdown keeps every part under the limit with balanced code fences", () => {
  const text = "intro\n```ts\n" + "const x = 1;\n".repeat(20) + "```\nend";
  const parts = splitMarkdown(text, 80);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.length <= 80, `part of ${p.length}`);
    assert.equal((p.match(/^```/gm) ?? []).length % 2, 0, p);
  }
  assert.equal(parts.join("\n").split("const x = 1;").length - 1, 20);
});

test("a turn streams text and tool cards into one message, then stops the stream", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where, { title: "repo: fix the bug" });
  await out.begin();
  out.text("On it, ");
  out.text("checking.");
  await out.tool("t0", "ls", "pending");
  await out.tool("t0", undefined, "completed");
  out.text("Done.");
  await out.end();
  assert.deepEqual(calls.map((c) => c.method), [
    "agents.sessions.setStatus", "chat.startStream", "chat.appendStream", "chat.appendStream", "chat.appendStream", "chat.stopStream",
  ]);
  assert.deepEqual(calls[0].params, { channel_id: "D1", thread_ts: "1.0", status: "processing", title: "repo: fix the bug" });
  assert.equal(chunks(calls).filter((c: any) => c.type === "markdown_text").map((c: any) => c.text).join(""), "On it, checking.\n\nDone.");
  assert.deepEqual(chunks(calls).filter((c: any) => c.type === "task_update").map((c: any) => [c.title, c.status]), [["ls", "pending"], ["ls", "complete"]]);
});

test("when streaming is refused the turn goes out as one message per text segment", async () => {
  const { api, calls } = fakeApi({ "chat.startStream": "ratelimited" });
  const out = createOutput(api, where);
  await out.begin();
  out.text("On it, checking.");
  await out.tool("t0", "ls", "in_progress");
  out.text("Done.");
  await out.end();
  assert.deepEqual(calls.filter((c) => c.method === "chat.postMessage").map((c) => c.params.markdown_text), ["On it, checking.", "Done."]);
  assert.equal(calls.at(-1)!.method, "agents.sessions.setStatus");
  assert.equal(calls.at(-1)!.params.status, "active");
});

test("long text without streaming is split to Slack's limit", async () => {
  const { api, calls } = fakeApi({ "chat.startStream": "feature_not_enabled" });
  const out = createOutput(api, where);
  out.text("word ".repeat(6000)); // 30k chars
  await out.end();
  const posts = calls.filter((c) => c.method === "chat.postMessage");
  assert.equal(posts.length, 3);
  assert.ok(posts.every((p) => p.params.markdown_text.length <= 12_000));
});

test("pause ends the stream and suspends the session; later text opens a new stream", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where);
  out.text("Need approval.");
  await out.pause();
  await out.resume();
  out.text("Approved, continuing.");
  await out.end();
  assert.deepEqual(calls.map((c) => c.method + (c.params.status ? `:${c.params.status}` : "")), [
    "chat.startStream", "chat.stopStream", "agents.sessions.setStatus:suspended",
    "agents.sessions.setStatus:processing", "chat.startStream", "chat.stopStream",
  ]);
});
```

**Step 2:** `cd daemon && npm test`. Expected: FAIL (module not found).

**Step 3: Implement** `daemon/src/output.ts`

```ts
// Renders one agent turn into a Slack thread. With native streaming (chat.startStream),
// text grows in one message and each tool call is a task card. If a stream cannot start or
// breaks (feature off, or the relay refusing it because the shared rate budget is spent),
// the rest of the turn goes out as plain messages, one per finished text segment (cut at
// tool calls), split to Slack's 12k limit. The session status (Slack's "Working…" and stop
// button) brackets the turn.

export const MAX_TEXT = 12_000;
// chat.appendStream is Tier 4 (100+/min) shared by every user: at most one append a second.
const FLUSH_MS = 1_000;
// Slack ends a stream after about 5 minutes; roll over to a new message before that.
const STREAM_MAX_AGE_MS = 240_000;
const TASK_STATUS: Record<string, string> = { pending: "pending", in_progress: "in_progress", completed: "complete", failed: "error" };

type Api = (method: string, params: Record<string, unknown>) => Promise<any>;
type Log = (msg: string, extra?: unknown) => void;
type Chunk = { type: string; [k: string]: unknown };

/** Splits Markdown into parts of at most `max` characters, closing and reopening code fences at the cuts. */
export function splitMarkdown(text: string, max = MAX_TEXT): string[] {
  const parts: string[] = [];
  let rest = text;
  let reopen = "";
  while (reopen.length + rest.length > max) {
    const budget = max - reopen.length - 4; // room for "\n```"
    let cut = rest.lastIndexOf("\n", budget);
    if (cut <= 0) cut = budget;
    let part = reopen + rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, "");
    const fences = part.match(/^```.*$/gm) ?? [];
    const open = fences.length % 2 === 1 ? fences[fences.length - 1] : "";
    if (open) part += "\n```";
    reopen = open ? `${open}\n` : "";
    parts.push(part);
  }
  parts.push(reopen + rest);
  return parts;
}

export function createOutput(api: Api, where: { channel: string; thread: string }, opts: { title?: string; log?: Log } = {}) {
  const log = opts.log ?? (() => {});
  const { channel, thread } = where;
  let streaming = true; // until a stream call fails, for the rest of this turn
  let stream: { ts: string; started: number } | null = null;
  let pending = "";
  let afterTool = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tasks = new Map<string, Chunk>(); // open cards are replayed into a rolled-over stream
  let chain: Promise<unknown> = Promise.resolve();
  const run = (fn: () => Promise<unknown>) =>
    (chain = chain.then(fn).catch((err) => log("output_failed", { error: String(err) })));
  const status = (s: string, extra: Record<string, unknown> = {}) =>
    api("agents.sessions.setStatus", { channel_id: channel, thread_ts: thread, status: s, ...extra }).catch((err) =>
      log("status_failed", { status: s, error: String(err) }),
    );

  async function stopStream() {
    if (!stream) return;
    const ts = stream.ts;
    stream = null;
    await api("chat.stopStream", { channel, ts }); // also sets the session back to active
  }

  async function send(chunks: Chunk[]): Promise<boolean> {
    if (!streaming) return false;
    try {
      if (stream && Date.now() - stream.started > STREAM_MAX_AGE_MS) await stopStream();
      if (stream) {
        await api("chat.appendStream", { channel, ts: stream.ts, chunks });
      } else {
        const open = [...tasks.values()].filter((t) => t.status === "pending" || t.status === "in_progress");
        const r = await api("chat.startStream", { channel, thread_ts: thread, task_display_mode: "timeline", chunks: [...open, ...chunks] });
        stream = { ts: r.ts, started: Date.now() };
      }
      return true;
    } catch (err) {
      log("stream_fallback", { error: String(err) });
      streaming = false;
      await stopStream().catch(() => {});
      await status("processing");
      return false;
    }
  }

  async function flush() {
    clearTimeout(timer);
    timer = undefined;
    const text = pending;
    pending = "";
    if (!text.trim()) return;
    const pieces = text.match(/[\s\S]{1,12000}/g)!;
    if (await send(pieces.map((t) => ({ type: "markdown_text", text: t })))) return;
    for (const part of splitMarkdown(text.trim())) await api("chat.postMessage", { channel, thread_ts: thread, markdown_text: part });
  }

  return {
    begin: () => run(() => status("processing", opts.title ? { title: opts.title.slice(0, 200) } : {})),
    text(s: string) {
      if (afterTool) {
        s = `\n\n${s}`;
        afterTool = false;
      }
      pending += s;
      if (streaming && !timer) timer = setTimeout(() => run(flush), FLUSH_MS);
    },
    tool(id: string, title: string | undefined, acpStatus: string | undefined) {
      const prev = tasks.get(id);
      const task: Chunk = {
        type: "task_update",
        id,
        title: String(title ?? prev?.title ?? "tool").slice(0, 256),
        status: TASK_STATUS[acpStatus ?? ""] ?? prev?.status ?? "in_progress",
      };
      tasks.set(id, task);
      afterTool = true;
      return run(async () => {
        await flush();
        await send([task]);
      });
    },
    /** Before posting buttons (blocks only go out when a stream stops). */
    pause: () =>
      run(async () => {
        await flush();
        await stopStream().catch(() => {});
        await status("suspended");
      }),
    resume: () => run(() => status("processing")),
    end: () =>
      run(async () => {
        await flush();
        if (stream) await stopStream().catch(() => status("active"));
        else await status("active");
      }),
  };
}

export type Output = ReturnType<typeof createOutput>;
```

**Step 4:** `cd daemon && npm test`. Expected: PASS. The e2e tests are unchanged so far.

**Step 5:** Commit: `feat(daemon): stream turns natively with a plain-message fallback`.

---

### Task 6: Wire the output into the daemon (status replaces 👀)

**Files:**
- Modify: `daemon/src/daemon.ts`
- Modify: `daemon/test/mock-agent.ts`
- Modify: `daemon/test/e2e.test.ts`

**Step 1: Mock agent.** In the default branch, after the `tool_call`, add:

```ts
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "t0", status: "completed" } });
```

**Step 2: Rewrite the e2e assertions (failing first).** In `daemon/test/e2e.test.ts`:
- Add helpers:

```ts
const mark = () => slack.calls.length;
const since = (n: number) => slack.calls.slice(n);
const streamed = (calls: typeof slack.calls) =>
  calls.flatMap((c) => (c.params.chunks ? JSON.parse(c.params.chunks) : []));
```

- Test 1:
  - Replace the 👀 assertions and `replies(...)` with: wait for `chat.stopStream` after picking the folder (`const n = mark()` taken before the click).
  - Assert the first `agents.sessions.setStatus` has `status: "processing"`, `thread_ts: "100.000001"` and a `title` containing `beta`.
  - Assert `streamed(since(n))`'s markdown text joins to `"On it, checking.\n\nDone."`.
  - Assert the task updates are `[["ls","pending"],["ls","complete"]]`.
  - Keep the agent-log assertions.
- New test:

```ts
test("when Slack refuses streaming, replies arrive as one message per segment", async () => {
  slack.fail.set("chat.startStream", "feature_not_enabled");
  try {
    await slack.emit("events_api", slack.dm("UPEPE", "again", { ts: "100.000004", thread_ts: "100.000001" }));
    await waitFor(() => replies("100.000001").filter((r) => r === "Done.").length >= 1);
    assert.deepEqual(replies("100.000001").slice(-2), ["On it, checking.", "Done."]);
  } finally {
    slack.fail.delete("chat.startStream");
  }
});
```

- The restart test: replace `reactions.remove` waits with `chat.stopStream` waits (`mark()` before emitting). Replace the `OLD HISTORY` assertion with `assert.equal(streamed(since(n)).some((c: any) => String(c.text).includes("OLD HISTORY")), false)`.

**Step 3:** `cd daemon && npm test`. Expected: FAIL (still 👀 and `markdown_text` posts).

**Step 4: Implement in `daemon.ts`.**
- `import { createOutput, type Output } from "./output.ts";` Remove `MAX_TEXT`, `buffers` and `flush` (now in output.ts).
- Add `const outputs = new Map<string, Output>(); // session -> its running turn`.
- `sessionUpdate`:

```ts
    async sessionUpdate({ sessionId, update }) {
      const out = outputs.get(sessionId);
      if (!out || replaying.has(sessionId)) return;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") out.text(update.content.text);
      else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        void out.tool(update.toolCallId, update.title ?? undefined, update.status ?? undefined);
      }
    },
```

- `prompt(t, blocks, title?)`, where `blocks: acp.ContentBlock[]`:

```ts
  function prompt(t: Thread, blocks: acp.ContentBlock[], title?: string) {
    const turn = (queues.get(t.sessionId) ?? Promise.resolve()).then(async () => {
      const out = createOutput((m, p) => slack.apiCall(m, p), t, { title, log });
      outputs.set(t.sessionId, out);
      await out.begin();
      try {
        await open(t);
        const r = await agent.prompt({ sessionId: t.sessionId, prompt: blocks });
        if (r.stopReason === "cancelled") out.text("\n\n_Stopped._");
      } catch (err: any) {
        log("prompt_failed", { session: t.sessionId, error: err?.message ?? String(err) });
        out.text(`\n\n⚠️ ${err?.message ?? err}`);
      } finally {
        await out.end();
        outputs.delete(t.sessionId);
      }
    });
    queues.set(t.sessionId, turn);
    return turn;
  }
```

- Callers:
  - `start()` → `prompt(t, [{ type: "text", text }], \`${basename(cwd)}: ${text.split("\n")[0]}\`)`.
  - Thread reply → `prompt(t, [{ type: "text", text: m.text }])`.
- `requestPermission`: replace `await flush(sessionId)` with `await outputs.get(sessionId)?.pause()`; after `await chosen`, call `await outputs.get(sessionId)?.resume()`.
- Delete the 👀 `reactions.add/remove` calls. The relay's working notice stays for other daemons.

**Step 5:** `make test`. Expected: PASS.

**Step 6:** Commit: `feat(daemon): native streaming, task cards and session status`.

---

### Task 7: Stop (native button and `/stop`) and the queued notice

**Files:**
- Modify: `daemon/src/daemon.ts`
- Modify: `daemon/test/mock-agent.ts`
- Modify: `daemon/test/e2e.test.ts`

**Step 1: Mock agent.**
- Add `const cancels = new Map<string, () => void>();` at module level.
- In `prompt`, before the default branch:

```ts
        if (text === "wait") {
          await new Promise<void>((r) => cancels.set(sessionId, r));
          return { stopReason: "cancelled" };
        }
```

- In `cancel`:

```ts
      async cancel({ sessionId }) {
        log({ m: "cancel", sessionId });
        cancels.get(sessionId)?.();
      },
```

**Step 2: Write the failing tests.**

```ts
const stopEvent = (thread: string) => ({
  type: "event_callback",
  event_id: `EvStop${thread}`,
  team_id: "T1",
  api_app_id: "A1",
  event: { type: "agent_session_stopped", channel: DM, thread_ts: thread, user: "UPEPE" },
});

test("Slack's stop button cancels the running turn; a message meanwhile is queued with a notice", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "wait", { ts: "100.000005", thread_ts: "100.000001" }));
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "wait"));
  await slack.emit("events_api", slack.dm("UPEPE", "and then this", { ts: "100.000006", thread_ts: "100.000001" }));
  await waitFor(() => posts.find((p) => p.params.thread_ts === "100.000001" && /Queued/.test(p.params.text ?? "")));
  await slack.emit("events_api", stopEvent("100.000001"));
  await waitFor(() => agentLog().some((e) => e.m === "cancel"));
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "and then this"));
});

test("/stop in the thread cancels too", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "wait", { ts: "100.000007", thread_ts: "100.000001" }));
  await waitFor(() => agentLog().filter((e) => e.m === "prompt" && e.text === "wait").length === 2);
  const cancels = agentLog().filter((e) => e.m === "cancel").length;
  await slack.emit("events_api", slack.dm("UPEPE", "/stop", { ts: "100.000008", thread_ts: "100.000001" }));
  await waitFor(() => agentLog().filter((e) => e.m === "cancel").length > cancels);
  assert.equal(agentLog().some((e) => e.m === "prompt" && e.text === "/stop"), false);
});
```

**Step 3:** `cd daemon && npm test`. Expected: FAIL (timeout waiting for `Queued`).

**Step 4: Implement in `daemon.ts`.**
- In `prompt()`, before chaining:

```ts
    if (outputs.has(t.sessionId)) void say(t, "📬 Queued: I'll start on this when the current turn ends.");
```

- Add `const stop = (t: Thread) => agent.cancel({ sessionId: t.sessionId });`
- In the message handler, before the `if (t) return void prompt(...)` line:

```ts
    if (t && m.text.trim() === "/stop") {
      if (outputs.has(t.sessionId)) await stop(t);
      else await say(t, "Nothing is running.");
      return;
    }
```

- Add the event handler:

```ts
  app.event("agent_session_stopped", async ({ event }) => {
    const t = threads[(event as any).thread_ts];
    if (t && outputs.has(t.sessionId)) await stop(t);
  });
```

**Step 5:** `make test`. Expected: PASS.

**Step 6:** Commit: `feat(daemon): stop turns from Slack and announce queued messages`.

---

### Task 8: Permission prompts show what will run

**Files:**
- Modify: `daemon/src/daemon.ts`
- Modify: `daemon/test/mock-agent.ts`
- Modify: `daemon/test/e2e.test.ts`

**Step 1: Mock agent.** In the `perm` branch, send the input in an update first, as OpenCode does, and leave it out of the request:

```ts
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } } });
          const r = await conn.requestPermission({
            sessionId,
            toolCall: { toolCallId: "t1", title: "bash", kind: "execute" },
            options: [ /* unchanged */ ],
          });
```

**Step 2: Failing assertion.** In the permission test, keep `assert.match(ask.params.text, /rm -rf build/);` and add `assert.match(ask.params.text, /bash/);`. It now fails because the title is `bash` and the command isn't shown.

**Step 3: Implement.**
- Add `const inputs = new Map<string, unknown>(); // toolCallId -> rawInput (OpenCode sends it in updates, not in the permission request)`.
- In `sessionUpdate`'s tool branch: `if (update.rawInput !== undefined) inputs.set(update.toolCallId, update.rawInput);`. Do this before the `out` check, so it is recorded even outside a turn.
- In `requestPermission`:

```ts
      const input = toolCall.rawInput ?? inputs.get(toolCall.toolCallId);
      const i = (input ?? {}) as Record<string, unknown>;
      const shown = typeof i.command === "string" ? i.command : typeof i.filePath === "string" ? i.filePath : input ? JSON.stringify(input) : "";
      const what = `🔐 The agent wants to run *${toolCall.title ?? toolCall.kind ?? "a tool"}*${shown ? `\n\`\`\`\n${shown.slice(0, 500)}\n\`\`\`` : ""}`;
```

  The button `value` must stay under Slack's 2,000 characters. Drop `what` from the value and keep it in a `Map` keyed by `id`, next to `permissions`; the `perm_` handler reads it from there.

**Step 4:** `make test`. Expected: PASS.

**Step 5:** Commit: `feat(daemon): show the command or path in permission prompts`.

---

### Task 9: Files and images from Slack

**Files:**
- Modify: `daemon/src/daemon.ts`
- Modify: `daemon/test/mock-agent.ts`
- Modify: `daemon/test/e2e.test.ts`

**Step 1: Mock agent.**
- `initialize` returns `agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }`.
- In `prompt`, log images when present:

```ts
        const images = prompt.filter((p) => p.type === "image").map((p: any) => p.mimeType);
        log({ m: "prompt", sessionId, text, ...(images.length && { images }) });
```

**Step 2: Write the failing test.**

```ts
test("images go to the agent as images; other files are saved in the session folder", async () => {
  const file = (id: string, name: string, mimetype: string) =>
    ({ id, name, mimetype, size: 20, url_private_download: `${slack.url}/files/${id}/${name}` });
  await slack.emit("events_api", slack.dm("UPEPE", "look", {
    ts: "100.000009", thread_ts: "100.000001", subtype: "file_share",
    files: [file("F1", "shot.png", "image/png"), file("F2", "notes.txt", "text/plain")],
  }));
  const p = await waitFor(() => agentLog().find((e) => e.m === "prompt" && e.images));
  assert.deepEqual(p.images, ["image/png"]);
  assert.match(p.text, /notes\.txt/);
  assert.equal(readFileSync(join(base, "beta", ".slack-files", "F2-notes.txt"), "utf8"), "content of F2");
});
```

The relay rewrites `url_private_download` to its `/files/` proxy, and mock Slack serves `content of <id>`. Also add a file-only message (empty `text`) to that test or a twin; it must reach the agent too.

**Step 3:** `cd daemon && npm test`. Expected: FAIL.

**Step 4: Implement in `daemon.ts`.**
- Keep the `initialize` result: `const ready = agent.initialize(...)`, then `const images = ready.then((r) => Boolean(r.agentCapabilities?.promptCapabilities?.image));`.
- Add:

```ts
const MAX_FILE = 20 * 1024 * 1024;

  // Slack files, fetched through the relay's file proxy with this daemon's token.
  async function attachments(files: any[] = [], cwd: string): Promise<acp.ContentBlock[]> {
    const blocks: acp.ContentBlock[] = [];
    for (const f of files) {
      const url = f.url_private_download ?? f.url_private;
      if (!url || f.size > MAX_FILE) {
        blocks.push({ type: "text", text: `[Attachment ${f.name} skipped: too large or unavailable]` });
        continue;
      }
      const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.token}` } });
      if (!res.ok) {
        log("file_fetch_failed", { file: f.id, status: res.status });
        continue;
      }
      const data = Buffer.from(await res.arrayBuffer());
      if ((await images) && /^image\/(png|jpeg|gif|webp)$/.test(f.mimetype)) {
        blocks.push({ type: "image", mimeType: f.mimetype, data: data.toString("base64") });
      } else {
        const dir = join(cwd, ".slack-files");
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${f.id}-${basename(f.name)}`);
        writeFileSync(path, data);
        blocks.push({ type: "text", text: `[Attached file saved at ${path}]` });
      }
    }
    return blocks;
  }
```

- Message handler:
  - Accept `(m.text || m.files?.length)`.
  - Keep `m.files` in `pending` (`{ channel, text, files }`).
  - Build `[{ type: "text", text: m.text ?? "" }, ...(await attachments(m.files, t.cwd))]` for thread replies, and in `start()` once `cwd` is known.
  - Drop an empty leading text block.

**Step 5:** `make test`. Expected: PASS.

**Step 6:** Commit: `feat(daemon): pass Slack images and files to the agent`.

---

### Task 10: Docs and manifest

**Files:** `README.md`, `CLAUDE.md`, `examples/coder/README.md` (no change expected; check it), `slack-app-manifest.json` (done in Task 3).

**Step 1: README "How it works"** (relay table):
- Add the stream and session methods to **Outbound**.
- Add a **Rate limits** row: "All daemons share the app's per-method limits. Upstream calls queue per method at the tier rate (`RATES` in `relay/src/limiter.ts`); a 429 waits Retry-After and retries; queued edits and appends of one message merge; `chat.startStream` is refused with `ratelimited` when it would wait over 2 s, so daemons fall back to plain messages."
- **Inbound**: add `agent_session_stopped`.

**Step 2: README "Daemon" table:**
- **Replies:** native stream with task cards; plain messages per segment as the fallback.
- **Status/Stop:** `agents.sessions.setStatus`, the native stop button and `/stop`.
- **Queued:** the notice.
- **Files:** images as ACP image blocks, other files saved to `<cwd>/.slack-files/`.
- **Permissions:** show the command or path.

**Step 3:** Slack app section: the manifest now declares the app as an agent (`agent_view`, `assistant:write`, `agent_session_stopped`). After updating an existing app, reinstall it.

**Step 4: CLAUDE.md layout:** add `relay/src/limiter.ts` and `daemon/src/output.ts`, one line each.

**Step 5:** `make test`. Commit: `docs: rate limits, agent sessions and the daemon's Slack UX`.

---

### Task 11: Real-world verification (manual, with the user)

1. **Real opencode, mock Slack:** rerun the scratchpad smoke (`real.mts`-style: mock Slack, relay, daemon, `opencode acp`). Expect `chat.startStream`, task cards for real tool calls, and `chat.stopStream`.
2. **Real Slack:**
   - Update the Slack app from `slack-app-manifest.json` (admin), reinstall, and run `./run-local.sh`.
   - Checklist:
     - Folder picker.
     - Streamed reply with tool cards.
     - "Working…" plus the stop button, and stop works.
     - A message sent mid-turn gets the queued notice.
     - An image and a file reach the agent.
     - A permission prompt shows the command.
     - Turning streaming off (remove the agent feature) falls back to plain messages.
3. **Budget check under real load:**
   - Watch the relay logs for `ratelimited` (Slack 429s) and `stream_refused` (budget spent) during normal team use.
   - If Slack never returns 429 but streams are refused often, raise the `RATES` entries; the tiers are floors ("20+").
   - Record the tuned numbers in `RATES` with a comment giving the date and evidence.

**Out of scope for Phase A (Phase B/C):**
- `/new`, `/mode`, `/model`, `/status`, and changing folder mid-thread.
- Images and files from the agent back to Slack.
- Suggested prompts and app context.
- Code channels, diff views and the context bar.
- Sharding users across several Slack apps, which is only needed if Task 11 shows the budget is not enough.
