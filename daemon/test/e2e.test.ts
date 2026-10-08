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
const mark = () => slack.calls.length;
const since = (n: number) => slack.calls.slice(n);
const streamed = (calls: typeof slack.calls) =>
  calls.flatMap((c) => (c.params.chunks ? JSON.parse(c.params.chunks) : []));

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

  const n = mark();
  await click({ ts: picker.ts, thread_ts: "100.000001" }, { type: "static_select", action_id: "folder", selected_option: { value: "beta" } });
  await waitFor(() => calls("chat.stopStream").length > 0);
  assert.deepEqual(agentLog().slice(0, 2), [
    { m: "new", sessionId: "ses_1", cwd: join(base, "beta") },
    { m: "prompt", sessionId: "ses_1", text: "fix the bug" },
  ]);
  assert.ok(calls("chat.update").some((c) => c.params.ts === picker.ts && c.params.text.includes("beta")));
  const firstStatus = calls("agents.sessions.setStatus")[0];
  assert.equal(firstStatus.params.status, "processing");
  assert.equal(firstStatus.params.thread_ts, "100.000001");
  assert.match(firstStatus.params.title, /beta/);
  const chunks = streamed(since(n));
  assert.equal(chunks.filter((c: any) => c.type === "markdown_text").map((c: any) => c.text).join(""), "On it, checking.\n\nDone.");
  assert.deepEqual(chunks.filter((c: any) => c.type === "task_update").map((c: any) => [c.title, c.status]), [["ls", "pending"], ["ls", "complete"]]);
});

test("a permission request becomes buttons whose click answers the agent", async () => {
  const n = mark();
  await slack.emit("events_api", slack.dm("UPEPE", "perm please", { ts: "100.000002", thread_ts: "100.000001" }));
  const ask = await waitFor(() => posts.find((p) => p.params.blocks?.includes("perm_allow")));
  assert.match(ask.params.text, /rm -rf build/);
  assert.match(ask.params.text, /bash/);
  const allow = JSON.parse(ask.params.blocks)[1].elements[0];
  await click({ ts: ask.ts, thread_ts: "100.000001" }, { type: "button", action_id: allow.action_id, value: allow.value });
  await waitFor(() =>
    streamed(since(n))
      .filter((c: any) => c.type === "markdown_text")
      .map((c: any) => c.text)
      .join("")
      .includes("chosen: allow"),
  );
  assert.ok(calls("chat.update").some((c) => c.params.ts === ask.ts && c.params.text.endsWith("Allow once")));
});

test("after a restart a thread reloads its session without re-posting its history", async () => {
  await daemon.stop();
  daemon = newDaemon();
  await daemon.start();
  const n = mark();
  await slack.emit("events_api", slack.dm("UPEPE", "still there?", { ts: "100.000003", thread_ts: "100.000001" }));
  await waitFor(() => since(n).some((c) => c.method === "chat.stopStream"));
  const log = agentLog();
  assert.deepEqual(log.at(-2), { m: "load", sessionId: "ses_1", cwd: join(base, "beta") });
  assert.deepEqual(log.at(-1), { m: "prompt", sessionId: "ses_1", text: "still there?" });
  assert.equal(streamed(since(n)).some((c: any) => String(c.text).includes("OLD HISTORY")), false);
});

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

test("a file-only message (no text) still reaches the agent", async () => {
  const file = (id: string, name: string, mimetype: string) =>
    ({ id, name, mimetype, size: 20, url_private_download: `${slack.url}/files/${id}/${name}` });
  await slack.emit("events_api", slack.dm("UPEPE", "", {
    ts: "100.000010", thread_ts: "100.000001", subtype: "file_share",
    files: [file("F3", "data.csv", "text/csv")],
  }));
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text?.includes("data.csv")));
});

test("a reply in a thread the daemon does not know says so", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "hello?", { ts: "200.000002", thread_ts: "200.000001" }));
  await waitFor(() => posts.find((p) => p.params.thread_ts === "200.000001" && /no agent session/.test(p.params.text)));
});
