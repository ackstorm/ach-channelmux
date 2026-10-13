// End-to-end: mock Slack <-> real relay <-> daemon <-> mock ACP agent.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createGateway } from "../../relay/src/gateway.ts";
import { createMockSlack, APP_TOKEN, BOT_TOKEN } from "../../relay/test/mock-slack.ts";
import { createDaemon, short } from "../src/daemon.ts";

const DM = "D_UPEPE";
const DEV = "C_DEV"; // #dev: its mentions go to this daemon
const CODE = "C_CODE"; // #code: its mentions open a code channel
const slack = createMockSlack({ UPEPE: "pepe@example.com" }, { [DEV]: "dev", [CODE]: "code" });
const base = mkdtempSync(join(tmpdir(), "daemon-test-"));
for (const d of ["alpha", "beta", ".hidden", "node_modules"]) mkdirSync(join(base, d));
// A symlinked folder, browsed like any other.
const elsewhere = mkdtempSync(join(tmpdir(), "daemon-linked-"));
mkdirSync(join(elsewhere, "deep"));
symlinkSync(elsewhere, join(base, "gamma"));
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

// A speech API: transcripts (failing while sttDown is set) and speech (failing while ttsDown is set).
const sttCalls: { url?: string; auth?: string; body: string }[] = [];
const ttsCalls: { auth?: string; body: any }[] = [];
let sttDown = false;
let ttsDown = false;
const stt = createHttpServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/v1/audio/speech") {
      ttsCalls.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      if (ttsDown) return void res.writeHead(500).end();
      return void res.writeHead(200, { "content-type": "audio/wav" }).end("RIFF fake wav");
    }
    sttCalls.push({ url: req.url, auth: req.headers.authorization, body });
    if (sttDown) return void res.writeHead(500).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: " hello from the model " }));
  });
});
await new Promise<void>((r) => stt.listen(0, "127.0.0.1", r));

let gw: ReturnType<typeof createGateway>;
let daemon: ReturnType<typeof createDaemon>;
const posts: { params: Record<string, string>; ts: string }[] = [];
const logged: Record<string, unknown>[] = [];

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
const newDaemon = (over: Partial<Parameters<typeof createDaemon>[0]> = {}) =>
  createDaemon({
    relayUrl: GW,
    token: "tok-pepe",
    agentCmd: ["node", join(import.meta.dirname, "mock-agent.ts")],
    baseDir: base,
    stateFile: join(base, ".state", "threads.json"),
    log: (msg, extra) => void logged.push({ msg, ...(extra as object) }),
    stt: { url: `http://127.0.0.1:${(stt.address() as any).port}/v1/`, model: "stt-test", language: "es", headers: async () => ({ authorization: "Bearer k-1" }) },
    tts: { url: `http://127.0.0.1:${(stt.address() as any).port}/v1`, model: "tts-test", voice: "Puck", prompt: "Like a pirate", headers: async () => ({ authorization: "Bearer k-2" }) },
    ...over,
  });
const calls = (method: string) => slack.calls.filter((c) => c.method === method);
const replies = (thread: string) => posts.filter((p) => p.params.thread_ts === thread && p.params.markdown_text).map((p) => p.params.markdown_text);
const click = (message: { ts: string; thread_ts?: string }, action: Record<string, unknown>) =>
  slack.emit("interactive", { type: "block_actions", user: { id: "UPEPE" }, channel: { id: DM }, message, actions: [action] }, true);
const mark = () => slack.calls.length;

// The picker modal: the latest view the daemon opened or redrew, and the user's taps on it.
const views = () => slack.calls.filter((c) => c.method === "views.open" || c.method === "views.update");
const lastView = () => JSON.parse(views().at(-1)!.params.view);
// The folder modal's browse buttons (picker_open_0, _1, …): the subfolders shown.
const browse = (view: any) => view.blocks.flatMap((b: any) => b.elements ?? []).filter((e: any) => /^picker_open_\d+$/.test(e.action_id ?? "")).map((e: any) => e.value);
async function tap(view: any, action_id: string, value: string, action: object = { type: "button", value }, values: Record<string, unknown> = {}) {
  const n = views().length;
  await slack.emit("interactive", { type: "block_actions", user: { id: "UPEPE" }, trigger_id: "T_tap", view: { id: "V_OPENED", callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values } }, actions: [{ action_id, ...action }] }, true);
  await waitFor(() => views().length > n);
  return lastView();
}
const submit = (view: any, values: Record<string, unknown> = {}) =>
  slack.emit("interactive", { type: "view_submission", user: { id: "UPEPE" }, trigger_id: "T_submit", view: { id: "V_OPENED", callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values } } }, true) as Promise<any>;
const sessionChoice = (value: string) => ({ session: { session: { type: "static_select", selected_option: { value } } } });
// The picker's greeting sits in the message's thread; its button carries the message (thread) it is for.
const pickerFor = (thread: string) =>
  waitFor(() => posts.find((p) => p.params.thread_ts === thread && p.params.blocks?.includes("picker_open_modal")));
async function openPicker(thread: string) {
  const msg = await pickerFor(thread);
  assert.equal(msg.params.text, "👋 Hi Mary Ann! Pick the folder to work in, then the session."); // Slack's first_name, whole, not the real name's first word
  const n = views().length;
  await slack.emit("interactive", { type: "block_actions", user: { id: "UPEPE" }, trigger_id: `T_${thread}`, channel: { id: DM }, message: { ts: msg.ts, thread_ts: thread }, actions: [{ type: "button", action_id: "picker_open_modal", value: thread }] }, true);
  await waitFor(() => views().length > n);
  return { msg, view: lastView() };
}
// "Use" in the folder modal with a searched folder; with nothing picked, the ticked suggestion or the folder browsed.
const searched = (rel: string) => ({ search: { picker_search: { type: "external_select", selected_option: { value: rel } } } });
const ticked = (rel: string) => ({ recent: { picker_recent: { type: "radio_buttons", selected_option: { value: rel } } } });
// "Use" pushes step 2, the session; "Start" runs the message there.
async function useFolder(view: any, values: Record<string, unknown> = {}) {
  const r = await submit(view, values);
  assert.equal(r.response_action, "push", JSON.stringify(r));
  return r.view;
}
const startIn = async (step2: any, values: Record<string, unknown> = {}) => assert.deepEqual(await submit(step2, values), { response_action: "clear" });
// The whole picker: a folder ("" is the base), then a new session.
async function startNew(thread: string, rel = ".") {
  const { view } = await openPicker(thread);
  await startIn(await useFolder(view, searched(rel)));
}
const since = (n: number) => slack.calls.slice(n);
const turnEnded = (ts: string) => waitFor(() => calls("reactions.add").some((c) => c.params.timestamp === ts && c.params.name === "white_check_mark"));
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
    channels: { dev: { email: "pepe@example.com", code: false }, code: { email: "pepe@example.com", code: true } },
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
  stt.close();
});

test("a new DM gets the picker in its thread; browsing to a folder and starting a new session runs the thread there", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "fix the bug", { ts: "100.000001" }));
  let { msg, view } = await openPicker("100.000001");
  assert.equal(msg.params.thread_ts, "100.000001"); // in the message's thread: the main view keeps only the message
  assert.deepEqual(browse(view), ["alpha", "beta", "gamma"]); // no hidden folders or node_modules; symlinks count
  assert.equal(view.blocks.some((b: any) => b.block_id === "recent"), false); // no sessions yet: no Recent
  const at = (id: string) => view.blocks.findIndex((b: any) => b.block_id === id || b.elements?.some((e: any) => e.action_id === id));
  assert.ok(at("search") < at("picker_open_0"), "the search comes first, browsing after");
  assert.ok(view.blocks.some((b: any) => b.elements?.at(-1)?.action_id === "picker_naming"), "New folder is a button after the subfolders");
  assert.ok(!view.blocks.some((b: any) => b.block_id?.startsWith("mkdir:")), "its name box only once tapped");
  assert.match(view.submit.text, /^Use .{1,20}$/); // the base folder's name, cut to Slack's 24 characters
  view = await tap(view, "picker_open_2", "gamma");
  assert.deepEqual(browse(view), ["deep"]);
  assert.equal(at("search"), -1); // inside a folder it only browses
  assert.equal(view.submit.text, "Use gamma");
  view = await tap(view, "picker_up", "up");
  view = await tap(view, "picker_open_1", "beta");
  assert.equal(view.blocks[0].text.text, `📁 \`${join(base, "beta")}\``);
  const step2 = await useFolder(view); // "Use": the folder being browsed
  // Step 2 says there is no session to continue; Start opens a new one.
  assert.equal(step2.title.text, "Choose session");
  assert.equal(step2.submit.text, "Start");
  assert.equal(step2.blocks.at(-1).text.text, "_No sessions here yet: a new one starts._");
  const n = mark();
  await startIn(step2);
  await waitFor(() => calls("chat.stopStream").length > 0);
  assert.deepEqual(agentLog().slice(0, 2), [
    { m: "new", sessionId: "ses_1", cwd: join(base, "beta") },
    { m: "prompt", sessionId: "ses_1", text: "fix the bug" },
  ]);
  // Start says so in the greeting at once; then the greeting becomes the thread's header.
  const updates = calls("chat.update").filter((c) => c.params.ts === msg.ts);
  assert.equal(updates[0].params.text, "⏳ Starting a new session in `beta`…");
  const header = updates.at(-1)!;
  assert.equal(header.params.blocks, "[]");
  const head = header.params.text;
  assert.equal(head, `📁 \`${join(base, "beta")}\`\n💬 New session · \`ses_1\``);
  await waitFor(() => calls("reactions.add").some((c) => c.params.timestamp === "100.000001" && c.params.name === "white_check_mark"));
  const firstStatus = calls("agents.sessions.setStatus")[0];
  assert.equal(firstStatus.params.status, "processing");
  assert.equal(firstStatus.params.thread_ts, "100.000001");
  assert.equal(firstStatus.params.title, "beta - fix the bug");
  const chunks = streamed(since(n));
  assert.equal(chunks.filter((c: any) => c.type === "markdown_text").map((c: any) => c.text).join(""), "On it, checking.\n\nDone.");
  assert.deepEqual(chunks.filter((c: any) => c.type === "task_update").map((c: any) => [c.title, c.status]), [["ls", "pending"], ["ls", "complete"], ["🔧 1 tool used", "complete"]]);
});

test("a permission request becomes buttons whose click answers the agent", async () => {
  const n = mark();
  await slack.emit("events_api", slack.dm("UPEPE", "perm please", { ts: "100.000002", thread_ts: "100.000001" }));
  const ask = await waitFor(() => posts.find((p) => p.params.blocks?.includes("perm_allow")));
  assert.equal(ask.params.text, "🔐 The agent wants to run:\n```\nrm -rf build\n```");
  const allow = JSON.parse(ask.params.blocks)[1].elements[0];
  await click({ ts: ask.ts, thread_ts: "100.000001" }, { type: "button", action_id: allow.action_id, value: allow.value });
  await waitFor(() =>
    streamed(since(n))
      .filter((c: any) => c.type === "markdown_text")
      .map((c: any) => c.text)
      .join("")
      .includes("chosen: allow"),
  );
  assert.ok(calls("chat.update").some((c) => c.params.ts === ask.ts && c.params.text.endsWith("```\n→ *Allow once*")));
});

test("stopping a turn that waits for a permission answers the request as cancelled", async () => {
  const n = mark();
  await slack.emit("events_api", slack.dm("UPEPE", "perm again", { ts: "100.000021", thread_ts: "100.000001" }));
  await waitFor(() => since(n).some((c) => c.method === "chat.postMessage" && c.params.blocks?.includes("perm_allow")));
  await slack.emit("events_api", slack.dm("UPEPE", "$stop", { ts: "100.000022", thread_ts: "100.000001" }));
  await waitFor(() => streamed(since(n)).some((c: any) => c.type === "markdown_text" && c.text.includes("chosen: cancelled")));
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
  const notice = await waitFor(() => posts.find((p) => p.params.thread_ts === "100.000001" && /Queued/.test(p.params.text ?? "")));
  await slack.emit("events_api", stopEvent("100.000001"));
  await waitFor(() => agentLog().some((e) => e.m === "cancel"));
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "and then this"));
  await waitFor(() => calls("chat.update").some((c) => c.params.ts === notice.ts && c.params.text === "📬 Queued, now running." && c.params.blocks === "[]")); // no Send now left
  await waitFor(() => calls("reactions.add").some((c) => c.params.timestamp === "100.000005" && c.params.name === "black_square_for_stop"));
  assert.ok(!posts.some((p) => p.params.channel === DM && !p.params.thread_ts && /Stopped/.test(p.params.text ?? ""))); // the reaction says it; no notice in the main view
});

test("Send now on a queued notice stops the running turn and the queued message runs", async () => {
  const waits = () => agentLog().filter((e) => e.m === "prompt" && e.text === "wait").length;
  const before = waits();
  await slack.emit("events_api", slack.dm("UPEPE", "wait", { ts: "100.000015", thread_ts: "100.000001" }));
  await waitFor(() => waits() > before);
  const notices = () => posts.filter((p) => p.params.thread_ts === "100.000001" && p.params.blocks?.includes("queue_now"));
  const earlier = notices().length; // an earlier turn's notice no longer stops anything
  await slack.emit("events_api", slack.dm("UPEPE", "do this instead", { ts: "100.000016", thread_ts: "100.000001" }));
  const notice = await waitFor(() => notices()[earlier]);
  const stale = notices()[0]; // queued behind a turn that has ended: tapping it now must not stop this one
  const cancels = agentLog().filter((e) => e.m === "cancel").length;
  await click({ ts: stale.ts, thread_ts: "100.000001" }, { type: "button", action_id: "queue_now", value: JSON.parse(stale.params.blocks)[0].accessory.value });
  await sleep(200);
  assert.equal(agentLog().filter((e) => e.m === "cancel").length, cancels);
  const sendNow = JSON.parse(notice.params.blocks)[0].accessory;
  await click({ ts: notice.ts, thread_ts: "100.000001" }, { type: "button", action_id: "queue_now", value: sendNow.value });
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "do this instead"));
  await waitFor(() => calls("chat.update").some((c) => c.params.ts === notice.ts && /Sent now/.test(c.params.text)));
});

test("$stop (or /stop) in the thread cancels too", async () => {
  const waits = () => agentLog().filter((e) => e.m === "prompt" && e.text === "wait").length;
  const before = waits();
  await slack.emit("events_api", slack.dm("UPEPE", "wait", { ts: "100.000007", thread_ts: "100.000001" }));
  await waitFor(() => waits() > before);
  const cancels = agentLog().filter((e) => e.m === "cancel").length;
  await slack.emit("events_api", slack.dm("UPEPE", "/stop", { ts: "100.000008", thread_ts: "100.000001" }));
  await waitFor(() => agentLog().filter((e) => e.m === "cancel").length > cancels);
  assert.equal(agentLog().some((e) => e.m === "prompt" && e.text === "/stop"), false);
});

test("a turn that ends after its tools with no reply gets one nudge, and the reply reaches the thread", async () => {
  const n = mark();
  const before = agentLog().length;
  await slack.emit("events_api", slack.dm("UPEPE", "silent", { ts: "100.000012", thread_ts: "100.000001" }));
  await waitFor(() => since(n).some((c) => c.method === "chat.stopStream"));
  const prompts = agentLog().slice(before).filter((e) => e.m === "prompt").map((e) => e.text);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /without replying/);
  assert.match(streamed(since(n)).filter((c: any) => c.type === "markdown_text").map((c: any) => c.text).join(""), /Here is the result\./);
});

test("when the nudge gets no reply either, the thread says the agent ended without one", async () => {
  const n = mark();
  await slack.emit("events_api", slack.dm("UPEPE", "mute", { ts: "100.000039", thread_ts: "100.000001" }));
  await waitFor(() => since(n).some((c) => c.method === "chat.stopStream"));
  assert.match(streamed(since(n)).filter((c: any) => c.type === "markdown_text").map((c: any) => c.text).join(""), /_The agent ended its turn without a reply\._$/);
});

test("a turn with no reply and no tools at all gets the nudge too, then says the agent ended without one", async () => {
  const n = mark();
  const before = agentLog().length;
  await slack.emit("events_api", slack.dm("UPEPE", "empty", { ts: "100.000052", thread_ts: "100.000001" }));
  await turnEnded("100.000052");
  assert.match(agentLog().slice(before).filter((e) => e.m === "prompt").map((e) => e.text)[1], /without replying/);
  assert.match(streamed(since(n)).filter((c: any) => c.type === "markdown_text").map((c: any) => c.text).join(""), /_The agent ended its turn without a reply\._$/);
});

test("Slack's escaped & < > reach the agent as typed", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "is a &lt; b &amp;&amp; c &gt; d?", { ts: "100.000053", thread_ts: "100.000001" }));
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "is a < b && c > d?"));
  await turnEnded("100.000053");
});

test("the model's thinking shows as a Thinking card", async () => {
  const n = mark();
  await slack.emit("events_api", slack.dm("UPEPE", "think", { ts: "100.000017", thread_ts: "100.000001" }));
  await waitFor(() => since(n).some((c) => c.method === "chat.stopStream"));
  const cards = streamed(since(n)).filter((c: any) => c.type === "task_update");
  assert.deepEqual(cards.map((c: any) => [c.title, c.status, c.output]), [["Thinking", "in_progress", undefined], ["Thinking", "complete", "Weighing it."]]);
});

test("a failed turn offers Retry, which sends the same message again", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "flaky", { ts: "100.000023", thread_ts: "100.000001" }));
  const failed = await waitFor(() => posts.find((p) => p.params.thread_ts === "100.000001" && p.params.blocks?.includes('"retry"')));
  await waitFor(() => calls("reactions.add").some((c) => c.params.timestamp === "100.000023" && c.params.name === "x"));
  const id = JSON.parse(failed.params.blocks)[0].accessory.value;
  await click({ ts: failed.ts, thread_ts: "100.000001" }, { type: "button", action_id: "retry", value: id });
  await waitFor(() => agentLog().filter((e) => e.m === "prompt" && e.text === "flaky").length === 2);
  await waitFor(() => calls("reactions.add").some((c) => c.params.timestamp === "100.000023" && c.params.name === "white_check_mark"));
});

test("a message queued behind a running turn still runs after the daemon restarts", async () => {
  const from = agentLog().length;
  await slack.emit("events_api", slack.dm("UPEPE", "wait", { ts: "100.000050", thread_ts: "100.000001" }));
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "wait" && e.sessionId === "ses_1"));
  const notices = () => posts.filter((p) => p.params.thread_ts === "100.000001" && /Queued/.test(p.params.text ?? "")).length;
  const before = notices();
  await slack.emit("events_api", slack.dm("UPEPE", "queued before the restart", { ts: "100.000051", thread_ts: "100.000001" }));
  await waitFor(() => notices() > before);
  await daemon.stop();
  daemon = newDaemon();
  await daemon.start();
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "queued before the restart"));
  await turnEnded("100.000051");
  const state = JSON.parse(readFileSync(join(base, ".state", "threads.json"), "utf8"));
  assert.deepEqual(state.queued, []); // run once, then gone
  assert.equal(agentLog().slice(from).filter((e) => e.m === "prompt" && e.text === "wait").length, 1); // the turn cut short is not run again
});

test("a subagent's own reply is not streamed as the agent's reply", async () => {
  const n = mark();
  await slack.emit("events_api", slack.dm("UPEPE", "subagent", { ts: "100.000013", thread_ts: "100.000001" }));
  await waitFor(() => since(n).some((c) => c.method === "chat.stopStream"));
  const text = streamed(since(n)).filter((c: any) => c.type === "markdown_text").map((c: any) => c.text).join("");
  assert.equal(text, "Parent reply.");
});

test("a turn that edits ends with a line of its changes (branch, files, lines); an edit too long for its card also comes as a changes.diff snippet", async () => {
  const n = mark();
  execFileSync("git", ["init", "-q", "-b", "work", join(base, "beta")]);
  await slack.emit("events_api", slack.dm("UPEPE", "big edit", { ts: "100.000013", thread_ts: "100.000001" }));
  const done = await waitFor(() => since(n).find((c) => c.method === "files.completeUploadExternal"));
  // The turn's edits, in one line under the reply with the context and cost so far: the only block there.
  const end = JSON.parse(since(n).find((c) => c.method === "chat.stopStream")!.params.blocks);
  assert.deepEqual(end[0], { type: "context", elements: [{ type: "mrkdwn", text: "📁 `beta` · 🌿 `work` · Model one · 1 file changed +30 −30 · *Context* 24k / 200k (12%) · *Cost* $0.012" }] });
  assert.equal(end.length, 1);
  const get = since(n).find((c) => c.method === "files.getUploadURLExternal")!;
  assert.deepEqual([get.params.filename, get.params.snippet_type], ["changes.diff", "diff"]);
  assert.equal(done.params.thread_ts, "100.000001");
  const body = slack.uploads.get(JSON.parse(done.params.files)[0].id)!.body;
  assert.match(body, /^--- big\.py\n\+\+\+ big\.py\n@@ -1,30 \+1,30 @@\n-old line 0/);
  assert.match(body, /\+new line 29$/);
});

test("attached files are saved to a temp folder and the agent gets their paths, not their content", async () => {
  const file = (id: string, name: string, mimetype: string) =>
    ({ id, name, mimetype, size: 20, url_private_download: `${slack.url}/files/${id}/${name}` });
  await slack.emit("events_api", slack.dm("UPEPE", "look", {
    ts: "100.000009", thread_ts: "100.000001", subtype: "file_share",
    files: [file("F1", "shot.png", "image/png"), file("F2", "notes.txt", "text/plain")],
  }));
  const p = await waitFor(() => agentLog().find((e) => e.m === "prompt" && e.text.startsWith("look")));
  assert.equal(p.images, undefined); // the agent supports images, but opens them only if it needs to
  const paths = [...p.text.matchAll(/saved at (\S+)\]/g)].map((m) => m[1]);
  assert.deepEqual(paths.map((x) => basename(x)), ["shot.png", "notes.txt"]);
  assert.ok(paths.every((x) => x.startsWith(tmpdir())), paths.join());
  assert.equal(readFileSync(paths[1], "utf8"), "content of F2");
});

test("a voice clip reaches the agent as Slack's transcript, waited for while Slack transcribes it", async () => {
  const clip = { id: "FV1", name: "audio_message.m4a", subtype: "slack_audio", mimetype: "video/mp4", size: 20, url_private_download: `${slack.url}/files/FV1/audio_message.m4a` };
  const done = { ...clip, transcription: { status: "complete", preview: { content: "hello from", has_more: true } }, vtt: `${slack.url}/files/FV1/transcript.vtt` };
  slack.replies = (p) => (p.ts === "100.000001" ? [{ ts: "100.000001" }, { ts: "100.000014", files: [done] }] : []);
  await slack.emit("events_api", slack.dm("UPEPE", "", {
    ts: "100.000014", thread_ts: "100.000001", subtype: "file_share", files: [{ ...clip, transcription: { status: "processing" } }],
  }));
  const p = await waitFor(() => agentLog().find((e) => e.m === "prompt" && e.text.includes("Voice message")));
  assert.equal(p.text, "[Voice message, transcribed by Slack]\nhello from a voice note"); // the whole transcript, through the relay
  slack.replies = undefined;
});

test("the agent sends a file to the thread with the send_file tool, without our token reaching the upload URL", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "upload the report", { ts: "100.000011", thread_ts: "100.000001" }));
  const sent = await waitFor(() => agentLog().find((e) => e.m === "sent"));
  assert.deepEqual(sent.tools, ["send_file", "ask_user", "send_voice"]);
  assert.equal(sent.result, "Sent report.txt to the user.");
  const done = calls("files.completeUploadExternal").at(-1)!;
  assert.deepEqual([done.params.channel_id, done.params.thread_ts, done.params.initial_comment], [DM, "100.000001", "here it is"]);
  const [{ id }] = JSON.parse(done.params.files);
  assert.deepEqual(slack.uploads.get(id), { body: "report body", auth: undefined });
});

test("after a restart, a turn in a folder whose tools the agent connects late waits until it lists them", async () => {
  await daemon.stop(); // a new agent process: every folder is cold again
  daemon = newDaemon();
  await daemon.start();
  await slack.emit("events_api", slack.dm("UPEPE", "tools?", { ts: "100.000043", thread_ts: "100.000001" }));
  const seen = await waitFor(() => agentLog().filter((e) => e.m === "tools").at(-1));
  assert.equal(seen.ready, true);
  await turnEnded("100.000043");
});

test("with one MCP server per folder (opencode), a tool call goes to the thread whose turn runs there", async () => {
  await turnEnded("100.000011"); // the upload above: $fork refuses while a turn runs
  // A fork of the thread, in the same folder, registers its own URL last.
  const forks = agentLog().filter((e) => e.m === "new" && e.from).length;
  await slack.emit("events_api", slack.dm("UPEPE", "$fork", { ts: "100.000041", thread_ts: "100.000001" }));
  // Until the daemon says it forked, the fork's thread may be unknown to it: the agent logs the fork first.
  await waitFor(() => agentLog().filter((e) => e.m === "new" && e.from).length > forks);
  // A fork may wait up to 5.5 s for the agent to list the tools of a folder not yet warm.
  await waitFor(() => posts.some((p) => p.params.thread_ts === "100.000001" && p.params.text?.startsWith("🍴 Forked")), 10_000);
  const before = calls("files.completeUploadExternal").length;
  await slack.emit("events_api", slack.dm("UPEPE", "upload the report", { ts: "100.000042", thread_ts: "100.000001" }));
  await waitFor(() => calls("files.completeUploadExternal").length > before);
  assert.equal(calls("files.completeUploadExternal").at(-1)!.params.thread_ts, "100.000001");
  await turnEnded("100.000042");
});

test("the agent's ask_user question is answered with a button or a reply in the thread", async () => {
  const replied = (n: number) => streamed(since(n)).filter((c: any) => c.type === "markdown_text").map((c: any) => c.text).join("");
  let n = mark();
  await slack.emit("events_api", slack.dm("UPEPE", "ask", { ts: "100.000018", thread_ts: "100.000001" }));
  const q = await waitFor(() => posts.find((p) => p.params.blocks?.includes("ask_1")));
  assert.equal(q.params.text, "❓ Which one?");
  await click({ ts: q.ts, thread_ts: "100.000001" }, { type: "button", action_id: "ask_1", value: "Blue" });
  await waitFor(() => replied(n).includes("answer: Blue"));
  assert.ok(calls("chat.update").some((c) => c.params.ts === q.ts && c.params.text === "❓ Which one?\n→ *Blue*"));

  n = mark();
  await slack.emit("events_api", slack.dm("UPEPE", "ask", { ts: "100.000019", thread_ts: "100.000001" }));
  await waitFor(() => since(n).some((c) => c.method === "chat.postMessage" && c.params.blocks?.includes("ask_1")));
  await slack.emit("events_api", slack.dm("UPEPE", "green, actually", { ts: "100.000020", thread_ts: "100.000001" }));
  await waitFor(() => replied(n).includes("answer: green, actually"));
  assert.equal(agentLog().some((e) => e.m === "prompt" && e.text.includes("green, actually")), false); // an answer, not a new prompt
});

test("a second question while one waits is refused; a voice reply answers the first", async () => {
  const n = mark();
  await slack.emit("events_api", slack.dm("UPEPE", "ask twice", { ts: "100.000024", thread_ts: "100.000001" }));
  const q = await waitFor(() => since(n).find((c) => c.method === "chat.postMessage" && c.params.text === "❓ First?"));
  assert.deepEqual(JSON.parse(q.params.blocks)[1].elements.map((e: any) => e.value), ["Yes"]); // a blank option is dropped
  await waitFor(() => agentLog().some((e) => e.m === "asked" && /already waiting/.test(e.second)));
  const clip = { id: "FV2", name: "audio_message.m4a", subtype: "slack_audio", size: 20, url_private_download: `${slack.url}/files/FV2/audio_message.m4a`, transcription: { status: "complete", preview: { content: "the second one", has_more: false } } };
  await slack.emit("events_api", slack.dm("UPEPE", "", { ts: "100.000025", thread_ts: "100.000001", subtype: "file_share", files: [clip] }));
  await waitFor(() => streamed(since(n)).some((c: any) => c.type === "markdown_text" && c.text.includes("answer: [Voice message, transcribed by Slack]\nthe second one")));
  await turnEnded("100.000024");
});

test("a voice clip Slack did not transcribe goes to the stt model, and is saved as a file when that fails", async () => {
  const clip = (id: string) => ({ id, name: "audio_message.m4a", subtype: "slack_audio", size: 20, url_private_download: `${slack.url}/files/${id}/audio_message.m4a`, transcription: { status: "none" } });
  await slack.emit("events_api", slack.dm("UPEPE", "", { ts: "100.000026", thread_ts: "100.000001", subtype: "file_share", files: [clip("FV3")] }));
  const p = await waitFor(() => agentLog().find((e) => e.m === "prompt" && e.text.includes("transcribed]")));
  assert.equal(p.text, "[Voice message, transcribed]\nhello from the model");
  assert.equal(sttCalls.length, 1); // the clips Slack transcribed (the tests above) never reached it
  const [call] = sttCalls;
  assert.deepEqual([call.url, call.auth], ["/v1/audio/transcriptions", "Bearer k-1"]);
  assert.match(call.body, /name="model"\r\n\r\nstt-test\r\n[\s\S]*name="language"\r\n\r\nes\r\n/);
  assert.doesNotMatch(call.body, /name="prompt"/); // unset, not sent empty
  assert.match(call.body, /filename="audio_message\.m4a"[\s\S]*content of FV3/);

  sttDown = true;
  await slack.emit("events_api", slack.dm("UPEPE", "", { ts: "100.000027", thread_ts: "100.000001", subtype: "file_share", files: [clip("FV4")] }));
  const q = await waitFor(() => agentLog().find((e) => e.m === "prompt" && e.text.includes("audio_message.m4a")));
  assert.match(q.text, /^\[Attached file saved at \S+\/audio_message\.m4a\]$/);
  assert.ok(logged.some((l) => l.msg === "stt_failed" && l.file === "FV4"));
  sttDown = false;
});

test("the agent's send_voice tool speaks through the tts model into the thread; without tts there is no tool", async () => {
  const spoke = (n: number) => waitFor(() => agentLog().filter((e) => e.m === "spoke")[n]);
  let n = mark();
  await slack.emit("events_api", slack.dm("UPEPE", "speak all done, captain", { ts: "100.000028", thread_ts: "100.000001" }));
  assert.deepEqual(await spoke(0), { m: "spoke", tools: ["send_file", "ask_user", "send_voice"], result: "Sent the voice message to the user." });
  assert.deepEqual(ttsCalls, [{ auth: "Bearer k-2", body: { model: "tts-test", voice: "Puck", input: "Like a pirate: all done, captain" } }]);
  const get = since(n).find((c) => c.method === "files.getUploadURLExternal")!;
  assert.equal(get.params.filename, "voice.wav");
  const done = since(n).find((c) => c.method === "files.completeUploadExternal")!;
  assert.equal(done.params.thread_ts, "100.000001");
  assert.equal(slack.uploads.get(JSON.parse(done.params.files)[0].id)!.body, "RIFF fake wav");

  ttsDown = true;
  await slack.emit("events_api", slack.dm("UPEPE", "speak again", { ts: "100.000029", thread_ts: "100.000001" }));
  const failed = await spoke(1);
  assert.deepEqual([failed.result, failed.isError], ["Could not send the voice message: speech service: HTTP 500", true]);
  ttsDown = false;

  await daemon.stop();
  daemon = newDaemon({ tts: undefined });
  await daemon.start();
  await slack.emit("events_api", slack.dm("UPEPE", "speak nobody hears", { ts: "100.000030", thread_ts: "100.000001" }));
  assert.deepEqual((await spoke(2)).tools, ["send_file", "ask_user"]);
  await daemon.stop();
  daemon = newDaemon();
  await daemon.start();
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

test("the picker searches folders under the base, and creates a new one where it is", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "somewhere new", { ts: "910.000001" }));
  let { view } = await openPicker("910.000001");
  const suggest = (value: string) =>
    slack.emit("interactive", { type: "block_suggestion", user: { id: "UPEPE" }, action_id: "picker_search", block_id: "search", value, view: { id: "V_OPENED", callback_id: view.callback_id, private_metadata: view.private_metadata } }, true) as Promise<any>;
  assert.deepEqual((await suggest("DEE")).options, [{ text: { type: "plain_text", text: "gamma/deep", emoji: true }, value: "gamma/deep" }]); // through the symlink
  assert.deepEqual((await suggest("modules")).options, []); // node_modules is skipped

  view = await tap(view, "picker_naming", "new");
  assert.ok(view.blocks.some((b: any) => b.block_id === "mkdir:"));
  view = await tap(view, "picker_mkdir", "../out");
  assert.match(view.blocks.at(-1).elements[0].text, /^⚠️ "\.\.\/out" can't be a folder here/);
  assert.ok(view.blocks.some((b: any) => b.block_id === "mkdir:"), "the name box stays, to try again");
  assert.equal(existsSync(join(base, "../out")), false);
  view = await tap(view, "picker_mkdir", " new one ");
  assert.ok(statSync(join(base, "new one")).isDirectory());
  assert.equal(view.blocks[0].text.text, `📁 \`${join(base, "new one")}\``);
  assert.equal(view.blocks[0].accessory.action_id, "picker_up"); // Back, beside the folder
  assert.ok(!view.blocks.some((b: any) => b.block_id?.startsWith("mkdir:"))); // the box closes once it is made

  // Back in the base folder, "Use" with a searched folder takes it over the base folder.
  view = await tap(view, "picker_up", "up");
  assert.ok(view.blocks.some((b: any) => b.block_id === "search"));
  await startIn(await useFolder(view, searched("gamma/deep")));
  const greeting = await pickerFor("910.000001");
  assert.match((await waitFor(() => calls("chat.update").find((c) => c.params.ts === greeting.ts && c.params.text.includes("💬")))).params.text, new RegExp(`^📁 \`${join(base, "gamma/deep")}\``));
  await turnEnded("910.000001");
});

test("a picker error shows in the redrawn modal; a failed start replaces the greeting's Starting notice", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "go there", { ts: "920.000001" }));
  let { msg, view } = await openPicker("920.000001");
  mkdirSync(join(base, "doomed"));
  view = await tap(view, "picker_up", "up"); // a redraw, to see the new folder
  view = await tap(view, `picker_open_${browse(view).indexOf("doomed")}`, "doomed");
  rmSync(join(base, "doomed"), { recursive: true });
  // Inside a folder there is no Search block for an "errors" response to point at.
  const r = await submit(view);
  assert.equal(r.response_action, "update");
  assert.equal(r.view.blocks.at(-1).elements[0].text, "⚠️ That folder is gone.");
  assert.ok(r.view.blocks.some((b: any) => b.block_id === "search"), "back at the base, its folder gone");

  mkdirSync(join(base, "unstartable"));
  await startIn(await useFolder(r.view, searched("unstartable")));
  const failed = await waitFor(() => calls("chat.update").find((c) => c.params.ts === msg.ts && c.params.text.startsWith("⚠️")));
  assert.ok(failed.params.text.startsWith(`⚠️ Could not start a session in \`${join(base, "unstartable")}\`: `));
  rmSync(join(base, "unstartable"), { recursive: true });
});

test("a $command as a new message gets help, not the folder picker", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "$help", { ts: "800.000001" }));
  const help = await waitFor(() => posts.find((p) => p.params.thread_ts === "800.000001"));
  assert.match(help.params.text, /^\*Commands\*/);
  await slack.emit("events_api", slack.dm("UPEPE", "$model", { ts: "800.000002" }));
  const other = await waitFor(() => posts.find((p) => p.params.thread_ts === "800.000002"));
  assert.match(other.params.text, /^Commands work inside a thread/);
  assert.equal(posts.some((p) => p.params.blocks?.includes("picker_") && ["800.000001", "800.000002"].some((t) => p.params.blocks.includes(t))), false);
});

test("a reply in a thread the daemon does not know says so", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "hello?", { ts: "200.000002", thread_ts: "200.000001" }));
  await waitFor(() => posts.find((p) => p.params.thread_ts === "200.000001" && /no agent session/.test(p.params.text)));
});

test("Recent folders in step 1; step 2 offers the folder's sessions, continued in the new thread with a link to the old one and a recap", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "carry on", { ts: "300.000001" }));
  let { msg, view } = await openPicker("300.000001");
  const recent = view.blocks.find((b: any) => b.block_id === "recent").element;
  assert.equal(recent.type, "radio_buttons");
  assert.deepEqual(recent.options.map((o: any) => o.value), ["gamma/deep", "beta"]);
  assert.equal(recent.options[1].text.text, join(base, "beta")); // the full path, one line
  assert.equal(recent.options[1].description, undefined);
  assert.equal(recent.initial_option.value, "gamma/deep"); // the first one ticked, and the button says so
  assert.equal(view.submit.text, "Use deep");
  view = await tap(view, "picker_recent", "beta", { type: "radio_buttons", selected_option: { value: "beta" } });
  assert.equal(view.submit.text, "Use beta");
  view = await tap(view, "picker_naming", "new", undefined, ticked("beta"));
  assert.equal(view.submit.text, "Use beta"); // a redraw keeps the tick Slack keeps
  const step2 = await useFolder(view, ticked("beta"));
  const options = step2.blocks.at(-1).element.options;
  assert.deepEqual(options.map((o: any) => o.value), ["new", "ses_1"]);
  assert.equal(step2.blocks.at(-1).element.initial_option.value, "new");
  assert.match(options[1].description.text, /another thread/);
  await startIn(step2, sessionChoice("ses_1"));

  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "carry on"));
  assert.deepEqual(agentLog().filter((e) => e.m === "load").at(-1), { m: "load", sessionId: "ses_1", cwd: join(base, "beta") });
  const head = await waitFor(() => calls("chat.update").find((c) => c.params.ts === msg.ts && c.params.text.includes("💬"))?.params.text);
  assert.equal(head, `📁 \`${join(base, "beta")}\`\n💬 *Session ses_1* · \`ses_1\`\n↩️ <https://example.slack.com/archives/D_UPEPE/p100000001|previous thread>`);
  // The last exchanges, out of their envelopes, each turn its answer only; the history itself is not re-posted.
  const recap = posts.find((p) => p.params.thread_ts === "300.000001" && p.params.markdown_text?.includes("Session recap"))!.params.markdown_text;
  assert.equal(recap, "**📜 Session recap**\n\n> **You:** fix the bug\n>\n> **Agent:** OLD HISTORY [code] That ran.");
  await slack.emit("events_api", slack.dm("UPEPE", "hello?", { ts: "100.000099", thread_ts: "100.000001" }));
  await waitFor(() => posts.find((p) => p.params.thread_ts === "100.000001" && /no agent session/.test(p.params.text)));
});

test("a session in the base folder itself shows up in Recent and can be picked again", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "at the root", { ts: "400.000001" }));
  await startNew("400.000001"); // "Use" with nothing picked: the base folder
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "at the root"));
  assert.deepEqual(agentLog().filter((e) => e.m === "new").at(-1).cwd, base);

  await slack.emit("events_api", slack.dm("UPEPE", "again at the root", { ts: "400.000002" }));
  const { view } = await openPicker("400.000002");
  const recent = view.blocks.find((b: any) => b.block_id === "recent").element.options.map((o: any) => o.value);
  assert.ok(recent.includes("."), "the base folder is offered (as '.', never an empty value)");
  const step2 = await useFolder(view, ticked("."));
  assert.equal(step2.blocks[0].text.text, `📁 \`${base}\``);
  assert.ok(step2.blocks.at(-1).element.options.length > 1); // its sessions to continue
  await startIn(step2);
});

test("the picker still works after the daemon restarts", async () => {
  const restart = async () => {
    await daemon.stop();
    daemon = newDaemon();
    await daemon.start();
  };
  await slack.emit("events_api", slack.dm("UPEPE", "before the restart", { ts: "500.000001" }));
  await pickerFor("500.000001");
  await restart();
  const { view } = await openPicker("500.000001");
  await startIn(await useFolder(view)); // the restarted agent has no sessions: a new one
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "before the restart"));
});

test("$ commands: $help, $model changes a setting, $compact, the agent's $review, ! runs a shell command the agent then sees, $clear starts over, $fork copies", async () => {
  const T = "500.000001";
  const say = (text: string, ts: string) => slack.emit("events_api", slack.dm("UPEPE", text, { ts, thread_ts: T }));
  const before = agentLog().length;

  await say("$help", "500.000002");
  const help = await waitFor(() => posts.find((p) => p.params.thread_ts === T && /\$compact/.test(p.params.text ?? "")));
  assert.match(help.params.text, /The agent's commands:\*\n`\$review`: review changes/); // its compact is ours already

  await daemon.stop(); // so $model loads the session and gets opencode's provisional, then real, settings
  daemon = newDaemon();
  await daemon.start();
  await say("$model", "500.000003");
  const panel = await waitFor(() => posts.find((p) => p.params.thread_ts === T && p.params.blocks?.includes("cfg:model")));
  assert.match(panel.params.text, /\*Model\* `Model one`/);
  assert.doesNotMatch(panel.params.text, /Session Mode/);
  const menu = JSON.parse(panel.params.blocks).find((b: any) => b.accessory?.action_id === "cfg:model");
  assert.deepEqual([menu.text.text, menu.accessory.initial_option.value], ["*Model*", "m1"]);
  await click({ ts: panel.ts, thread_ts: T }, { type: "static_select", action_id: "cfg:model", selected_option: { value: "m2" } });
  await waitFor(() => agentLog().some((e) => e.m === "config" && e.configId === "model" && e.value === "m2"));
  const redrawn = await waitFor(() => calls("chat.update").find((c) => c.params.ts === panel.ts && /`Model two`/.test(c.params.text)));
  assert.equal(JSON.parse(redrawn.params.blocks).find((b: any) => b.accessory?.action_id === "cfg:model").accessory.initial_option.value, "m2");

  await say("$compact", "500.000004");
  await waitFor(() => agentLog().slice(before).some((e) => e.m === "prompt" && e.text === "/compact"));
  await say("$model", "500.000012"); // after a turn the agent has reported its context use
  await waitFor(() => posts.find((p) => p.params.thread_ts === T && /\*Context\* 24k \/ 200k \(12%\)   ·   \*Cost\* \$0\.012/.test(p.params.text ?? "")));
  await say("$review branch", "500.000010"); // the agent's own command, with arguments
  await waitFor(() => agentLog().slice(before).some((e) => e.m === "prompt" && e.text === "/review branch"));
  const prompts = agentLog().slice(before).filter((e) => e.m === "prompt").map((e) => e.text);
  assert.equal(prompts[prompts.indexOf("/compact") + 1], "/review branch"); // a command ending without a reply is not nudged
  await say("$HOME is unset", "500.000011"); // not a command: goes to the agent as a message
  await waitFor(() => agentLog().slice(before).some((e) => e.m === "prompt" && e.text === "$HOME is unset"));

  await say("! echo shell-$((40+2)) &amp;&amp; echo then", "500.000005"); // Slack escapes & < > in text
  const out = await waitFor(() => posts.find((p) => p.params.thread_ts === T && p.params.markdown_text?.includes("$ echo shell")));
  assert.match(out.params.markdown_text, /\$ echo shell-\$\(\(40\+2\)\) && echo then\n[\s\S]*shell-42\nthen/);
  const asked = mark();
  await say("what did I run?", "500.000006");
  const next = await waitFor(() => agentLog().slice(before).find((e) => e.m === "prompt" && e.text.includes("what did I run?")));
  assert.match(next.text, /shell-42/); // the command and its output reach the agent with the next message
  assert.equal(agentLog().slice(before).some((e) => e.m === "prompt" && e.text.startsWith("! echo")), false);

  await waitFor(() => since(asked).some((c) => c.method === "chat.stopStream")); // $clear refuses while a turn runs
  const session = agentLog().filter((e) => e.m === "prompt" && e.text.includes("what did I run?")).at(-1).sessionId;
  await say("$clear", "500.000007");
  const fresh = await waitFor(() => agentLog().slice(before).find((e) => e.m === "new"));
  assert.notEqual(fresh.sessionId, session);
  await say("hello again", "500.000008");
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "hello again" && e.sessionId === fresh.sessionId));

  await turnEnded("500.000008"); // $fork refuses while a turn runs
  const m = posts.length; // an earlier test forks too
  await say("$fork", "500.000013"); // a copy of the session in a new thread, rooted at our message
  const root = await waitFor(() => posts.slice(m).find((p) => !p.params.thread_ts && /^🍴 Fork of \*Session ses_\d+\* in /.test(p.params.text ?? "")));
  const forked = await waitFor(() => agentLog().find((e) => e.m === "new" && e.from === fresh.sessionId));
  await waitFor(() => posts.find((p) => p.params.thread_ts === T && p.params.text?.includes(`<https://example.slack.com/archives/${DM}/p${root.ts.replace(".", "")}|the copy>`)));
  await slack.emit("events_api", slack.dm("UPEPE", "in the fork", { ts: "600.000001", thread_ts: root.ts }));
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "in the fork" && e.sessionId === forked.sessionId));

  await say("$nope", "500.000009");
  await waitFor(() => posts.find((p) => p.params.thread_ts === T && /Unknown command/.test(p.params.text ?? "")));
});

test("a session the agent has not titled yet shows as Untitled, not opencode's timestamp title", async () => {
  const n = posts.length;
  await slack.emit("events_api", slack.dm("UPEPE", "$clear", { ts: "500.000020", thread_ts: "500.000001" })); // a new session, no prompt yet
  const cleared = await waitFor(() => posts.slice(n).find((p) => p.params.text?.startsWith("🧹")));
  const id = /💬 New session · `(\S+)`/.exec(cleared.params.text)![1];
  await slack.emit("events_api", slack.dm("UPEPE", "which one?", { ts: "500.000021" }));
  const { view } = await openPicker("500.000021");
  const option = (await useFolder(view, ticked("."))).blocks.at(-1).element.options.find((o: any) => o.value === id);
  assert.equal(option.text.text, "Untitled");
});

test("an edit never reaches the agent; its author gets a notice in the thread", async () => {
  const edit = (ts: string, text: string, thread_ts?: string) =>
    slack.dm("UPEPE", "", { user: undefined, subtype: "message_changed", message: { type: "message", user: "UPEPE", ts, thread_ts, text }, previous_message: { text: "old" } });
  await slack.emit("events_api", slack.dm("UPEPE", "lsit files", { ts: "700.000001" }));
  await pickerFor("700.000001");
  await slack.emit("events_api", edit("700.000001", "list files"));
  await startNew("700.000001");
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "lsit files"));
  await turnEnded("700.000001");
  await slack.emit("events_api", edit("700.000001", "list all files"));
  await waitFor(() => calls("chat.postEphemeral").filter((c) => c.params.thread_ts === "700.000001").length === 2);
  const notice = calls("chat.postEphemeral").at(-1)!.params;
  assert.equal(notice.user, "UPEPE");
  assert.equal(notice.text, "✏️ Edits don't reach the agent. Send a new message instead.");
  assert.equal(agentLog().some((e) => e.m === "prompt" && /list (all )?files/.test(e.text)), false);
});

test("each Slack message reaches the agent in a <slack> envelope with who wrote it and when", async () => {
  const lines = readFileSync(`${process.env.MOCK_AGENT_LOG}.envelopes`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const first = lines.find((e) => e.body.startsWith("fix the bug"));
  assert.match(first.attrs, /^from="Real UPEPE" at="\d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Z+0-9:]+"$/);
  assert.ok(!lines.some((e) => /^(\$\w+(\s|$)(?!is unset)|!)/.test(e.body)), "commands are not sent to the agent");
});

test("Send to agent on any message starts a DM thread with its text and a link back, at the picker", async () => {
  const n = views().length;
  await slack.emit("interactive", {
    type: "message_action", callback_id: "send_to_agent", trigger_id: "T_shortcut", user: { id: "UPEPE" }, team: { id: "T1", domain: "acme" },
    channel: { id: "C_TEAM" }, message: { ts: "900.000001", user: "UXAVI", text: "login fails on Safari\n\n[Context from the Slack relay. Do not mention or quote this block.]\nUser: x.\n[End of relay context]" },
  }, true);
  await waitFor(() => views().length > n);
  const root = posts.find((p) => p.params.channel === "UPEPE" && p.params.text?.startsWith("📎"))!;
  assert.equal(root.params.text, "📎 <https://acme.slack.com/archives/C_TEAM/p900000001|Shared message>:\n> login fails on Safari");
  await startIn(await useFolder(lastView(), searched("."))); // the base folder
  const p = await waitFor(() => agentLog().find((e) => e.m === "prompt" && e.text.startsWith("login fails on Safari")));
  // The relay's context block reaches the agent after the link, never the quote in the DM.
  assert.match(p.text, /\[Shared from this Slack message: https:\/\/acme\.slack\.com\/archives\/C_TEAM\/p900000001\]\n\n\[Context from the Slack relay/);
  await turnEnded(root.ts!); // a turn still running when the relay stops keeps retrying, and the test process never exits
});

test("a new message starting with $ and words is a message, not a command", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "$HOME is empty, why?", { ts: "800.000003" }));
  await pickerFor("800.000003");
});

test("folders the message names come first in step 1, marked and ticked", async () => {
  mkdirSync(join(elsewhere, "deep-sea"));
  mkdirSync(join(base, "alpha", "snake_game"));
  const suggested = (view: any) => view.blocks.find((b: any) => b.block_id === "recent").element;
  // A short plain name ("deep") is too often just a word in the sentence: not marked.
  await slack.emit("events_api", slack.dm("UPEPE", "go deep on this", { ts: "919.000001" }));
  let { view } = await openPicker("919.000001");
  assert.ok(!suggested(view).options.some((o: any) => o.text.text.includes("🪄")));
  assert.equal(view.blocks.find((b: any) => b.block_id === "recent").hint, undefined); // nothing suggested: no hint
  await slack.emit("events_api", slack.dm("UPEPE", "check the DEEP-SEA folder, please", { ts: "920.000001" }));
  ({ view } = await openPicker("920.000001"));
  assert.equal(suggested(view).initial_option.value, "gamma/deep-sea");
  assert.equal(suggested(view).options[0].text.text, `${join(base, "gamma/deep-sea")}  🪄`);
  assert.equal(view.blocks.find((b: any) => b.block_id === "recent").hint.text, "🪄 Suggested from your message");
  assert.equal(view.submit.text, "Use deep-sea");
  await startIn(await useFolder(view, ticked("gamma/deep-sea"))); // nothing touched: Slack sends the ticked one
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "check the DEEP-SEA folder, please"));
  assert.ok(agentLog().some((e) => e.m === "new" && e.cwd === join(base, "gamma/deep-sea")));
  await turnEnded("920.000001");

  // Several folders: each marked, last used first, before the other recent ones.
  await slack.emit("events_api", slack.dm("UPEPE", "Snake-Game or deep-sea?", { ts: "922.000001" }));
  ({ view } = await openPicker("922.000001"));
  const stars = suggested(view).options.filter((o: any) => o.text.text.includes("🪄")).map((o: any) => o.value);
  // 5 in all: the suggested ones, then recent ones to fill (as many as there are).
  const recent = [...new Set(view.blocks.find((b: any) => b.block_id === "recent").element.options.map((o: any) => o.value))];
  assert.equal(recent.length, suggested(view).options.length);
  assert.ok(suggested(view).options.length <= 5);
  assert.deepEqual(stars, ["gamma/deep-sea", "alpha/snake_game"]);
  assert.deepEqual(suggested(view).options.slice(0, 2).map((o: any) => o.value), stars);
});

test("the Home tab shows the agent, defaults for new sessions and recent threads; a default applies to the next new session", async () => {
  const opened = () => slack.emit("events_api", { type: "event_callback", event_id: `EvHome${mark()}`, team_id: "T1", api_app_id: "A1", event: { type: "app_home_opened", user: "UPEPE", channel: DM, tab: "home" } });
  const published = () => calls("views.publish");
  let n = published().length;
  await opened();
  await waitFor(() => published().length > n);
  let home = JSON.parse(published().at(-1)!.params.view);
  assert.equal(published().at(-1)!.params.user_id, "UPEPE");
  assert.deepEqual(home.blocks.filter((b: any) => b.type === "header").map((b: any) => b.text.text), ["Your agent", "Defaults for new sessions", "Recent threads"]);
  assert.equal(home.blocks[1].text.text, `🟢 Online · node · ${base}`);
  const model = home.blocks.find((b: any) => b.accessory?.action_id === "home_default:model");
  assert.deepEqual([model.text.text, model.accessory.initial_option, model.accessory.placeholder.text], ["*Model*   agent default", undefined, "Change…"]);
  const recent = home.blocks[home.blocks.findIndex((b: any) => b.text?.text === "Recent threads") + 1].text.text;
  assert.match(recent, /📁 \*deep-sea\* · <https:\/\/example\.slack\.com\/archives\/D_UPEPE\/p\d+\|[^>]+>/); // the title is the link

  n = published().length;
  await slack.emit("interactive", { type: "block_actions", user: { id: "UPEPE" }, view: { id: "V_HOME", type: "home" }, actions: [{ type: "static_select", action_id: "home_default:model", selected_option: { value: "m2" } }] }, true);
  await waitFor(() => published().length > n);
  home = JSON.parse(published().at(-1)!.params.view);
  assert.equal(home.blocks.find((b: any) => b.accessory?.action_id === "home_default:model").text.text, "*Model*   `Model two`");
  assert.deepEqual(JSON.parse(readFileSync(join(base, ".state", "threads.json"), "utf8")).defaults, { model: "m2" });

  // After a restart, before any session loads, the Home tab still knows the agent's settings: those saved,
  // here with a model the agent no longer offers.
  await daemon.stop();
  const stateFile = join(base, ".state", "threads.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.settings.find((o: any) => o.id === "model").options.push({ value: "m9", name: "Model nine" });
  writeFileSync(stateFile, JSON.stringify(state));
  daemon = newDaemon();
  await daemon.start();
  n = published().length;
  await opened();
  await waitFor(() => published().length > n);
  assert.equal(JSON.parse(published().at(-1)!.params.view).blocks.find((b: any) => b.accessory?.action_id === "home_default:model").text.text, "*Model*   `Model two`");

  // Settings that change its menus redraw the open Home tab: a loaded session's list drops the old model.
  const menu = (c: any) => JSON.parse(c.params.view).blocks.find((b: any) => b.accessory?.action_id === "home_default:model").accessory.options.map((o: any) => o.text.text);
  assert.ok(menu(published().at(-1)).includes("Model nine"));
  await slack.emit("events_api", slack.dm("UPEPE", "$model", { ts: "920.000009", thread_ts: "920.000001" }));
  await waitFor(() => !menu(published().at(-1)).includes("Model nine") && menu(published().at(-1)).includes("Model two"));

  // The next new session gets it.
  await slack.emit("events_api", slack.dm("UPEPE", "alpha please", { ts: "930.000001" }));
  await startNew("930.000001", "alpha");
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "alpha please"));
  assert.deepEqual(agentLog().filter((e) => e.m === "config").at(-1), { m: "config", configId: "model", value: "m2" });
  await turnEnded("930.000001"); // a turn still running when the relay stops keeps retrying, and the test process never exits
});

test("a reply without edits ends with its folder and model, not in a git repo no branch", async () => {
  const n = mark();
  await slack.emit("events_api", slack.dm("UPEPE", "hi again", { ts: "930.000002", thread_ts: "930.000001" }));
  await turnEnded("930.000002");
  const end = JSON.parse(since(n).find((c) => c.method === "chat.stopStream")!.params.blocks);
  assert.deepEqual(end, [{ type: "context", elements: [{ type: "mrkdwn", text: "📁 `alpha` · Model two · *Context* 24k / 200k (12%) · *Cost* $0.012" }] }]);
});

// A message in #dev, and a tap in a channel.
const inDev = (text: string, extra: Record<string, unknown>) =>
  slack.emit("events_api", slack.dm("UPEPE", text, { channel: DEV, channel_type: "channel", ...extra }));
const clickIn = (channel: string, message: { ts: string; thread_ts?: string }, action: Record<string, unknown>) =>
  slack.emit("interactive", { type: "block_actions", user: { id: "UPEPE" }, trigger_id: `T_${channel}_${message.ts}`, channel: { id: channel }, message, actions: [action] }, true);

test("a mention in a channel opens the picker in its thread and the reply runs the session there", async () => {
  await inDev("<@UBOT> look at the logs", { ts: "950.000001" });
  const greeting = await waitFor(() => posts.find((p) => p.params.channel === DEV && p.params.blocks?.includes("picker_open_modal")));
  assert.equal(greeting.params.thread_ts, "950.000001"); // in the mention's thread, not the channel
  assert.equal(greeting.params.text, "👋 Hi Mary Ann! Pick the folder to work in, then the session.");
  const n = views().length;
  await clickIn(DEV, { ts: greeting.ts, thread_ts: "950.000001" }, { type: "button", action_id: "picker_open_modal", value: "950.000001" });
  await waitFor(() => views().length > n);
  // A folder with a session in the DM: those stay out of the channel, so there is none to continue.
  const step2 = await useFolder(lastView(), searched("alpha"));
  assert.equal(step2.blocks.at(-1).text.text, "_No sessions here yet: a new one starts._");
  await startIn(step2);
  const p = await waitFor(() => agentLog().find((e) => e.m === "prompt" && e.text.includes("look at the logs")));
  assert.equal(p.text, "look at the logs"); // without the mention
  await turnEnded("950.000001");
  assert.match(calls("chat.update").filter((c) => c.params.ts === greeting.ts).at(-1)!.params.text, /^📁 `.*alpha`\n💬 New session · `ses_\d+`$/); // the greeting becomes the header

  // Replies need no mention; nothing goes to the channel's main view.
  await inDev("wait", { ts: "950.000002", thread_ts: "950.000001" });
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "wait" && e.sessionId === p.sessionId));
  await inDev("$stop", { ts: "950.000003", thread_ts: "950.000001" });
  await inDev("and now this", { ts: "950.000004", thread_ts: "950.000001" });
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "and now this" && e.sessionId === p.sessionId));
  await turnEnded("950.000004"); // the stopped turn ended before this one
  assert.deepEqual(posts.filter((x) => x.params.channel === DEV && !x.params.thread_ts), []);
});

test("a channel message without a mention is ignored", async () => {
  await inDev("just chatting", { ts: "951.000001" });
  await inDev("$help", { ts: "951.000002" });
  await inDev("<@UBOT> $help", { ts: "951.000003" }); // with a mention: the help, in its thread
  const help = await waitFor(() => posts.find((p) => p.params.thread_ts === "951.000003"));
  assert.match(help.params.text, /^\*Commands\*/);
  assert.equal(posts.some((p) => ["951.000001", "951.000002"].includes(p.params.thread_ts) || p.params.blocks?.includes("951.000001")), false);
  assert.equal(agentLog().some((e) => e.m === "prompt" && e.text.includes("just chatting")), false);
});

test("a thread reply in a channel with no session is ignored silently", async () => {
  await inDev("anyone?", { ts: "952.000002", thread_ts: "952.000001" });
  await inDev("", { user: undefined, subtype: "message_changed", message: { type: "message", user: "UPEPE", ts: "952.000002", thread_ts: "952.000001", text: "anyone at all?" }, previous_message: { text: "anyone?" } });
  await inDev("<@UBOT> $help", { ts: "952.000003" });
  await waitFor(() => posts.find((p) => p.params.thread_ts === "952.000003"));
  assert.equal(posts.some((p) => p.params.thread_ts === "952.000001"), false); // not "This thread has no agent session"
  assert.equal(calls("chat.postEphemeral").some((c) => c.params.thread_ts === "952.000001"), false); // nor the edit notice
});

// A message in #code or in a code channel (a private channel to Slack).
const inCode = (channel: string, text: string, extra: Record<string, unknown>) =>
  slack.emit("events_api", slack.dm("UPEPE", text, { channel, channel_type: channel === CODE ? "channel" : "group", ...extra }));
const repo = join(base, "delta"); // the code channel's folder: a git repo with one commit, on main
let cc = ""; // the code channel the next tests work in
let ccSession = "";

test("a mention in a CODE_CHANNELS channel opens a code channel with the picker in it, and the session replies there, top-level", async () => {
  mkdirSync(repo);
  writeFileSync(join(repo, "big.py"), "old\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("add", ".");
  git("commit", "-qm", "init");
  await inCode(CODE, "<@UBOT> refactor the parser", { ts: "960.000001" });
  const created = await waitFor(() => calls("agents.conversations.create")[0]);
  const { origin_channel_id, origin_message_ts, session_id, is_private, name } = created.params;
  assert.deepEqual([origin_channel_id, origin_message_ts, session_id, is_private], [CODE, "960.000001", "960.000001", "true"]);
  assert.equal(name, "refactor the parser"); // the message without the mention, which Slack's own name would keep
  const working = await waitFor(() => posts.find((p) => p.params.channel === CODE && p.params.thread_ts === "960.000001"));
  cc = /^🧑‍💻 Working in <#(\w+)>$/.exec(working.params.text)![1];
  const greeting = await waitFor(() => posts.find((p) => p.params.channel === cc && p.params.blocks?.includes("picker_open_modal")));
  assert.equal(greeting.params.thread_ts, undefined); // the channel is the session: no threads
  const n = views().length;
  await clickIn(cc, { ts: greeting.ts }, { type: "button", action_id: "picker_open_modal", value: cc });
  await waitFor(() => views().length > n);
  const m = mark();
  await startIn(await useFolder(lastView(), searched("delta"))); // no sessions there: a new one
  ccSession = (await waitFor(() => agentLog().find((e) => e.m === "prompt" && e.text === "refactor the parser"))).sessionId;
  await waitFor(() => since(m).some((c) => c.method === "chat.stopStream"));
  assert.ok(calls("chat.update").some((c) => c.params.ts === greeting.ts && c.params.text.includes("💬"))); // the greeting, top-level, becomes the header
  const stream = since(m).find((c) => c.method === "chat.startStream")!;
  assert.deepEqual([stream.params.channel, stream.params.thread_ts], [cc, undefined]);
  const statuses = since(m).filter((c) => c.method === "agents.sessions.setStatus");
  assert.ok(statuses.length && statuses.every((c) => c.params.channel_id === cc && c.params.thread_ts === undefined));

  // Its messages need no mention, top-level or in a thread inside it; its buttons and stop find the session.
  const plain = mark();
  await inCode(cc, "and the tests", { ts: "960.000002" });
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "and the tests" && e.sessionId === ccSession));
  await turnEnded("960.000002");
  // The context bar shows folder, branch and model: the footer only context and cost.
  const footer = JSON.parse(since(plain).find((c) => c.method === "chat.stopStream")!.params.blocks);
  assert.equal(footer[0].elements[0].text, "*Context* 24k / 200k (12%) · *Cost* $0.012");
  await inCode(cc, "in a thread", { ts: "960.000003", thread_ts: "960.000002" });
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "in a thread" && e.sessionId === ccSession));
  await turnEnded("960.000003");
  const k = mark();
  await inCode(cc, "ask", { ts: "960.000004" });
  const ask = await waitFor(() => posts.find((p) => p.params.channel === cc && p.params.blocks?.includes("ask_1")));
  assert.equal(ask.params.thread_ts, undefined);
  await clickIn(cc, { ts: ask.ts }, { type: "button", action_id: "ask_1", value: "Blue" });
  await waitFor(() => streamed(since(k)).some((c: any) => c.type === "markdown_text" && c.text.includes("answer: Blue")));
  await turnEnded("960.000004");
  await inCode(cc, "wait", { ts: "960.000005" });
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "wait" && e.sessionId === ccSession));
  await slack.emit("events_api", { type: "event_callback", event_id: "EvStopCode", team_id: "T1", api_app_id: "A1", event: { type: "agent_session_stopped", channel: cc, user: "UPEPE" } });
  await waitFor(() => calls("reactions.add").some((c) => c.params.timestamp === "960.000005" && c.params.name === "black_square_for_stop"));

  // The Home tab still draws: a code channel's session has no thread ts.
  const published = calls("views.publish").length;
  await slack.emit("events_api", { type: "event_callback", event_id: "EvHomeCode", team_id: "T1", api_app_id: "A1", event: { type: "app_home_opened", user: "UPEPE", channel: DM, tab: "home" } });
  await waitFor(() => calls("views.publish").length > published);
  assert.match(calls("views.publish").at(-1)!.params.view, new RegExp(`📁 \\*delta\\* · <#${cc}>`)); // a code channel links as itself
});

test("if the code channel cannot be created, the session opens in the thread", async () => {
  slack.fail.set("agents.conversations.create", "restricted_action");
  try {
    await inCode(CODE, "<@UBOT> try this", { ts: "961.000001" });
    await waitFor(() => posts.find((p) => p.params.channel === CODE && p.params.thread_ts === "961.000001" && p.params.blocks?.includes("picker_open_modal")));
    assert.ok(posts.some((p) => p.params.thread_ts === "961.000001" && /^⚠️ Could not open a code channel/.test(p.params.text ?? "")));
  } finally {
    slack.fail.delete("agents.conversations.create");
  }
});

// The code channel's context bar, as last set.
const bar = () => JSON.parse(calls("agents.conversations.setProperties").filter((c) => c.params.channel_id === cc).at(-1)!.params.code_channel).context_bar_items;

test("a code channel's context bar shows its folder, branch and model, and follows a model change", async () => {
  assert.deepEqual(bar(), [
    { key: "folder", label: short(repo), icon: "folder" },
    { key: "branch", label: "main", icon: "branch" },
    { key: "model", label: "Model two", icon: "terminal" }, // the Home tab's default
  ]);
  await inCode(cc, "$model", { ts: "962.000001" });
  const panel = await waitFor(() => posts.find((p) => p.params.channel === cc && p.params.blocks?.includes("cfg:model")));
  assert.equal(panel.params.thread_ts, undefined);
  await clickIn(cc, { ts: panel.ts }, { type: "static_select", action_id: "cfg:model", selected_option: { value: "m1" } });
  await waitFor(() => bar().find((i: any) => i.key === "model").label === "Model one");
  // $clear: a new session, with the Home tab's default model again.
  const m = posts.length;
  await inCode(cc, "$clear", { ts: "962.000002" });
  ccSession = /💬 New session · `(\S+)`/.exec((await waitFor(() => posts.slice(m).find((p) => p.params.channel === cc && p.params.text?.startsWith("🧹")))).params.text)![1];
  await waitFor(() => bar().find((i: any) => i.key === "model").label === "Model two");
});

test("a turn that edits in a git folder sets the code channel's Changes tab to the diff since the session's first turn", async () => {
  assert.equal(calls("agents.conversations.setView").length, 0); // the turns so far edited nothing
  // The agent commits as it goes: what it committed since the session's first turn is still a change.
  writeFileSync(join(repo, "done.txt"), "committed\n");
  execFileSync("git", ["-C", repo, "add", "done.txt"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "done"]);
  writeFileSync(join(repo, "big.py"), "new\n"); // the mock agent only reports its edit
  const n = mark();
  await inCode(cc, "big edit", { ts: "963.000001" });
  const view = await waitFor(() => calls("agents.conversations.setView")[0]);
  const { channel_id, view_key, type, base_branch, head_branch, content } = view.params;
  assert.deepEqual([channel_id, view_key, type, base_branch, head_branch], [cc, "changes", "diff", "main", "main"]);
  assert.match(content, /^diff --git a\/big\.py b\/big\.py\n[\s\S]*\n-old\n\+new\ndiff --git a\/done\.txt b\/done\.txt\n[\s\S]*\n\+committed\n$/);
  await turnEnded("963.000001");
  const end = JSON.parse(since(n).find((c) => c.method === "chat.stopStream")!.params.blocks);
  assert.deepEqual(end[0], { type: "context", elements: [{ type: "mrkdwn", text: "1 file changed +30 −30 · *Context* 24k / 200k (12%) · *Cost* $0.012" }] }); // the bar has the rest
});

test("$done closes a code channel: a summary, then the channel archived with it; elsewhere it explains", async () => {
  const state = () => JSON.parse(readFileSync(join(base, ".state", "threads.json"), "utf8")).threads;
  // Slack refuses: the summary says so, and the channel stays the session.
  slack.fail.set("agents.conversations.archive", "not_allowed");
  try {
    await inCode(cc, "$done", { ts: "964.000000" });
    await waitFor(() => calls("chat.update").some((c) => c.params.channel === cc && c.params.text === "⚠️ Could not close the code channel: not_allowed"));
    assert.ok(cc in state());
  } finally {
    slack.fail.delete("agents.conversations.archive");
  }
  await inCode(cc, "$done", { ts: "964.000001" });
  const archive = await waitFor(() => calls("agents.conversations.archive")[1]);
  const summary = posts.filter((p) => p.params.channel === cc && p.params.text?.startsWith("✅ Session closed")).at(-1)!;
  assert.equal(summary.params.text, `✅ Session closed · \`${ccSession}\` — continue it from any new message's Previous session.`);
  assert.equal(summary.params.thread_ts, undefined);
  assert.deepEqual([archive.params.channel_id, archive.params.summary_message_ts], [cc, summary.ts]);
  await waitFor(() => !(cc in state())); // still resumable from the picker
  await slack.emit("events_api", slack.dm("UPEPE", "$done", { ts: "964.000002", thread_ts: "930.000001" }));
  await waitFor(() => posts.find((p) => p.params.thread_ts === "930.000001" && p.params.text === "`$done` closes a code channel; this is not one."));
});

test("a long folder path keeps its start and its name, the middle cut", () => {
  assert.equal(short("/workspace/local/x"), "/workspace/local/x");
  const long = `/workspace/local/${"epepe".repeat(10)}/deeper/ach-project`;
  assert.equal(short(long), `${long.slice(0, 60 - "ach-project".length - 6)}[...]/ach-project`);
  assert.equal(short(long).length, 60);
  assert.equal(short(`/w/${"n".repeat(80)}`), `[...]/${"n".repeat(54)}`);
});
