// End-to-end: mock Slack <-> real relay <-> daemon <-> mock ACP agent.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createGateway } from "../../relay/src/gateway.ts";
import { createMockSlack, APP_TOKEN, BOT_TOKEN } from "../../relay/test/mock-slack.ts";
import { createDaemon } from "../src/daemon.ts";

const DM = "D_UPEPE";
const slack = createMockSlack({ UPEPE: "pepe@example.com" });
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

// The picker modal: the latest view the daemon opened or redrew, and the user's taps on it.
const views = () => slack.calls.filter((c) => c.method === "views.open" || c.method === "views.update");
const lastView = () => JSON.parse(views().at(-1)!.params.view);
const actionValues = (view: any, actionId: string) =>
  view.blocks.flatMap((b: any) => [b.accessory, ...(b.elements ?? [])]).filter((e: any) => e?.action_id === actionId).map((e: any) => e.value);
async function tap(view: any, action_id: string, value: string) {
  const n = views().length;
  await slack.emit("interactive", { type: "block_actions", user: { id: "UPEPE" }, trigger_id: "T_tap", view: { id: "V_OPENED", callback_id: view.callback_id, private_metadata: view.private_metadata }, actions: [{ type: "button", action_id, value }] }, true);
  await waitFor(() => views().length > n);
  return lastView();
}
const submit = (view: any, values: Record<string, unknown> = {}) =>
  slack.emit("interactive", { type: "view_submission", user: { id: "UPEPE" }, trigger_id: "T_submit", view: { id: "V_OPENED", callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values } } }, true) as Promise<any>;
const sessionChoice = (value: string) => ({ session: { session: { type: "radio_buttons", selected_option: { value } } } });
async function openPicker(thread: string) {
  const msg = await waitFor(() => posts.find((p) => p.params.thread_ts === thread && p.params.blocks?.includes("picker_open_modal")));
  const n = views().length;
  await slack.emit("interactive", { type: "block_actions", user: { id: "UPEPE" }, trigger_id: `T_${thread}`, channel: { id: DM }, message: { ts: msg.ts, thread_ts: thread }, actions: [{ type: "button", action_id: "picker_open_modal", value: thread }] }, true);
  await waitFor(() => views().length > n);
  return { msg, view: lastView() };
}
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

test("a new DM opens the picker; browsing to a folder and starting a new session runs the thread there", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "fix the bug", { ts: "100.000001" }));
  let { msg, view } = await openPicker("100.000001");
  assert.deepEqual(actionValues(view, "picker_open"), ["alpha", "beta", "gamma"]); // no hidden folders or node_modules; symlinks count
  assert.deepEqual(actionValues(view, "picker_pick"), []); // no sessions yet: no "Last used"
  view = await tap(view, "picker_open", "gamma");
  assert.deepEqual(actionValues(view, "picker_open"), ["deep"]);
  view = await tap(view, "picker_up", "up");
  view = await tap(view, "picker_open", "beta");
  assert.equal(view.submit.text, "Use beta");
  const next = await submit(view);
  assert.equal(next.response_action, "update");
  view = next.view;
  assert.deepEqual(view.blocks.at(-1).element.options.map((o: any) => o.value), ["new"]);

  const n = mark();
  assert.deepEqual(await submit(view, sessionChoice("new")), { response_action: "clear" });
  await waitFor(() => calls("chat.stopStream").length > 0);
  assert.deepEqual(agentLog().slice(0, 2), [
    { m: "new", sessionId: "ses_1", cwd: join(base, "beta") },
    { m: "prompt", sessionId: "ses_1", text: "fix the bug" },
  ]);
  const head = calls("chat.update").find((c) => c.params.ts === msg.ts)!.params.text;
  assert.match(head, /beta` · new session/);
  assert.match(head, /opencode -s ses_1/);
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

test("the agent sends a file to the thread with the send_file tool, without our token reaching the upload URL", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "upload the report", { ts: "100.000011", thread_ts: "100.000001" }));
  const sent = await waitFor(() => agentLog().find((e) => e.m === "sent"));
  assert.deepEqual(sent.tools, ["send_file"]);
  assert.equal(sent.result, "Sent report.txt to the user.");
  const done = calls("files.completeUploadExternal").at(-1)!;
  assert.deepEqual([done.params.channel_id, done.params.thread_ts, done.params.initial_comment], [DM, "100.000001", "here it is"]);
  const [{ id }] = JSON.parse(done.params.files);
  assert.deepEqual(slack.uploads.get(id), { body: "report body", auth: undefined });
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

test("the picker offers last-used folders and continues an existing session, moving it to the new thread", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "carry on", { ts: "300.000001" }));
  let { msg, view } = await openPicker("300.000001");
  assert.deepEqual(actionValues(view, "picker_pick"), ["beta"]);
  view = await tap(view, "picker_pick", "beta");
  const options = view.blocks.at(-1).element.options;
  assert.deepEqual(options.map((o: any) => o.value), ["new", "ses_1"]);
  assert.match(options[1].description.text, /another thread/);
  view = await tap(view, "picker_other", "other"); // back to the first screen
  assert.deepEqual(actionValues(view, "picker_pick"), ["beta"]);
  view = await tap(view, "picker_pick", "beta");
  await submit(view, sessionChoice("ses_1"));

  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "carry on"));
  assert.deepEqual(agentLog().filter((e) => e.m === "load").at(-1), { m: "load", sessionId: "ses_1", cwd: join(base, "beta") });
  const head = await waitFor(() => calls("chat.update").find((c) => c.params.ts === msg.ts)?.params.text);
  assert.match(head, /continuing \*Session ses_1\*/);
  assert.match(head, /^> OLD HISTORY$/m); // its last reply, quoted; the history itself is not re-posted
  assert.match(head, /opencode -s ses_1/);
  await slack.emit("events_api", slack.dm("UPEPE", "hello?", { ts: "100.000099", thread_ts: "100.000001" }));
  await waitFor(() => posts.find((p) => p.params.thread_ts === "100.000001" && /no agent session/.test(p.params.text)));
});

test("a session in the base folder itself shows up in Last used and can be picked again", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "at the root", { ts: "400.000001" }));
  let { view } = await openPicker("400.000001");
  const next = await submit(view); // "Use <base>" on the first screen
  await submit(next.view, sessionChoice("new"));
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "at the root"));
  assert.deepEqual(agentLog().filter((e) => e.m === "new").at(-1).cwd, base);

  await slack.emit("events_api", slack.dm("UPEPE", "again at the root", { ts: "400.000002" }));
  ({ view } = await openPicker("400.000002"));
  assert.ok(actionValues(view, "picker_pick").includes("."), "the base folder is offered (as '.', never an empty value)");
  view = await tap(view, "picker_pick", ".");
  assert.equal(view.blocks.at(-1).element.options.length, 2); // New session + the root session
});

test("a picker still works after the daemon restarts", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "before the restart", { ts: "500.000001" }));
  await waitFor(() => posts.find((p) => p.params.thread_ts === "500.000001" && p.params.blocks?.includes("picker_open_modal")));
  await daemon.stop();
  daemon = newDaemon();
  await daemon.start();
  const { view } = await openPicker("500.000001");
  const next = await submit(view);
  await submit(next.view, sessionChoice("new"));
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "before the restart"));
});
