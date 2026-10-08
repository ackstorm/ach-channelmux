// End-to-end: mock Slack <-> real relay <-> daemon <-> mock ACP agent.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../../relay/src/gateway.ts";
import { createMockSlack, APP_TOKEN, BOT_TOKEN } from "../../relay/test/mock-slack.ts";
import { createDaemon } from "../src/daemon.ts";

const DM = "D_UPEPE";
const slack = createMockSlack({ UPEPE: "pepe@example.com" });
const base = mkdtempSync(join(tmpdir(), "daemon-test-"));
for (const d of ["alpha", "beta", ".hidden"]) mkdirSync(join(base, d));
process.env.MOCK_AGENT_LOG = join(base, ".agent.log");
const agentLog = () =>
  readFileSync(process.env.MOCK_AGENT_LOG!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const GW_PORT = await new Promise<number>((r) => {
  const s = createServer().listen(0, () => {
    const p = (s.address() as any).port;
    s.close(() => r(p));
  });
});
const GW = `http://127.0.0.1:${GW_PORT}`;

let gw: ReturnType<typeof createGateway>;
let daemon: ReturnType<typeof createDaemon>;
const posts: { params: Record<string, string>; ts: string }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = fn();
      if (v) return v;
    } catch {} // agent log not written yet
    await sleep(20);
  }
  assert.fail("timed out waiting for condition");
}
const newDaemon = () =>
  createDaemon({
    relayUrl: GW,
    token: "tok-pepe",
    agentCmd: ["node", join(import.meta.dirname, "mock-agent.ts")],
    baseDir: base,
    stateFile: join(base, ".state", "threads.json"),
    log: () => {},
  });
const calls = (method: string) => slack.calls.filter((c) => c.method === method);
const replies = (thread: string) => posts.filter((p) => p.params.thread_ts === thread && p.params.markdown_text).map((p) => p.params.markdown_text);
const click = (message: { ts: string; thread_ts: string }, action: Record<string, unknown>) =>
  slack.emit("interactive", { type: "block_actions", user: { id: "UPEPE" }, channel: { id: DM }, message, actions: [action] }, true);

before(async () => {
  await slack.start();
  slack.onPost = (params, ts) => posts.push({ params, ts });
  gw = createGateway({
    port: GW_PORT,
    publicUrl: GW,
    upstreamApiUrl: `${slack.url}/api/`,
    appToken: APP_TOKEN,
    botToken: BOT_TOKEN,
    resolveToken: async (t) => (t === "tok-pepe" ? "pepe@example.com" : null),
    workingNoticeMs: 0, // forward 👀 so the test sees the daemon's turn markers
    rates: {},
    log: () => {},
  });
  await gw.start();
  daemon = newDaemon();
  await daemon.start();
});

after(async () => {
  await daemon.stop();
  await gw.stop();
  await slack.stop();
});

test("a new DM asks for a folder, then runs the thread as an agent session there", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "fix the bug", { ts: "100.000001" }));
  const picker = await waitFor(() => posts.find((p) => p.params.thread_ts === "100.000001" && p.params.blocks));
  const select = JSON.parse(picker.params.blocks)[0].accessory;
  assert.deepEqual(select.options.map((o: any) => o.value), [".", "alpha", "beta"]);

  await click({ ts: picker.ts, thread_ts: "100.000001" }, { type: "static_select", action_id: "folder", selected_option: { value: "beta" } });
  await waitFor(() => calls("reactions.remove").some((c) => c.params.timestamp === "100.000001"));
  assert.deepEqual(agentLog().slice(0, 2), [
    { m: "new", sessionId: "ses_1", cwd: join(base, "beta") },
    { m: "prompt", sessionId: "ses_1", text: "fix the bug" },
  ]);
  assert.ok(calls("chat.update").some((c) => c.params.ts === picker.ts && c.params.text.includes("beta")));
  assert.ok(calls("reactions.add").some((c) => c.params.timestamp === "100.000001" && c.params.name === "eyes"));
  // Text segments are cut at tool calls; the tool call itself is not posted.
  assert.deepEqual(replies("100.000001"), ["On it, checking.", "Done."]);
});

test("a permission request becomes buttons whose click answers the agent", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "perm please", { ts: "100.000002", thread_ts: "100.000001" }));
  const ask = await waitFor(() => posts.find((p) => p.params.blocks?.includes("perm_allow")));
  assert.match(ask.params.text, /rm -rf build/);
  const allow = JSON.parse(ask.params.blocks)[1].elements[0];
  await click({ ts: ask.ts, thread_ts: "100.000001" }, { type: "button", action_id: allow.action_id, value: allow.value });
  await waitFor(() => replies("100.000001").includes("chosen: allow"));
  assert.ok(calls("chat.update").some((c) => c.params.ts === ask.ts && c.params.text.endsWith("Allow once")));
});

test("after a restart a thread reloads its session without re-posting its history", async () => {
  await daemon.stop();
  daemon = newDaemon();
  await daemon.start();
  await slack.emit("events_api", slack.dm("UPEPE", "still there?", { ts: "100.000003", thread_ts: "100.000001" }));
  await waitFor(() => calls("reactions.remove").some((c) => c.params.timestamp === "100.000003"));
  const log = agentLog();
  assert.deepEqual(log.at(-2), { m: "load", sessionId: "ses_1", cwd: join(base, "beta") });
  assert.deepEqual(log.at(-1), { m: "prompt", sessionId: "ses_1", text: "still there?" });
  assert.equal(replies("100.000001").some((r) => r.includes("OLD HISTORY")), false);
});

test("a reply in a thread the daemon does not know says so", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "hello?", { ts: "200.000002", thread_ts: "200.000001" }));
  await waitFor(() => posts.find((p) => p.params.thread_ts === "200.000001" && /no agent session/.test(p.params.text)));
});
