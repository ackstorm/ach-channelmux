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
    doneNoticeMs: 100, // the "wait" turns run longer: they end with a notice
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
  assert.ok(calls("chat.delete").some((c) => c.params.ts === msg.ts)); // the picker gives way to the header
  const header = posts.find((p) => p.params.thread_ts === "100.000001" && p.params.reply_broadcast === "true")!;
  const head = header.params.text;
  assert.match(head, /beta` · new session/);
  assert.match(head, /opencode -s ses_1/);
  await waitFor(() => calls("reactions.add").some((c) => c.params.timestamp === "100.000001" && c.params.name === "white_check_mark"));
  const firstStatus = calls("agents.sessions.setStatus")[0];
  assert.equal(firstStatus.params.status, "processing");
  assert.equal(firstStatus.params.thread_ts, "100.000001");
  assert.equal(firstStatus.params.title, "beta · fix the bug");
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
  await waitFor(() => posts.find((p) => p.params.thread_ts === "100.000001" && /Queued/.test(p.params.text ?? "")));
  await sleep(150); // past doneNoticeMs
  await slack.emit("events_api", stopEvent("100.000001"));
  await waitFor(() => agentLog().some((e) => e.m === "cancel"));
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "and then this"));
  await waitFor(() => calls("reactions.add").some((c) => c.params.timestamp === "100.000005" && c.params.name === "black_square_for_stop"));
  await waitFor(() => posts.find((p) => p.params.thread_ts === "100.000001" && /^⏹️ Stopped · \d+s$/.test(p.params.text ?? ""))); // a long turn ends with a message, which notifies
});

test("Send now on a queued notice stops the running turn and the queued message runs", async () => {
  const waits = () => agentLog().filter((e) => e.m === "prompt" && e.text === "wait").length;
  const before = waits();
  await slack.emit("events_api", slack.dm("UPEPE", "wait", { ts: "100.000015", thread_ts: "100.000001" }));
  await waitFor(() => waits() > before);
  await slack.emit("events_api", slack.dm("UPEPE", "do this instead", { ts: "100.000016", thread_ts: "100.000001" }));
  const notice = await waitFor(() => posts.find((p) => p.params.thread_ts === "100.000001" && p.params.blocks?.includes("queue_now")));
  await click({ ts: notice.ts, thread_ts: "100.000001" }, { type: "button", action_id: "queue_now", value: "100.000001" });
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

test("a subagent's own reply is not streamed as the agent's reply", async () => {
  const n = mark();
  await slack.emit("events_api", slack.dm("UPEPE", "subagent", { ts: "100.000013", thread_ts: "100.000001" }));
  await waitFor(() => since(n).some((c) => c.method === "chat.stopStream"));
  const text = streamed(since(n)).filter((c: any) => c.type === "markdown_text").map((c: any) => c.text).join("");
  assert.equal(text, "Parent reply.");
});

test("an edit too long for its card also comes as a changes.diff snippet at the end of the turn", async () => {
  const n = mark();
  await slack.emit("events_api", slack.dm("UPEPE", "big edit", { ts: "100.000013", thread_ts: "100.000001" }));
  const done = await waitFor(() => since(n).find((c) => c.method === "files.completeUploadExternal"));
  const get = since(n).find((c) => c.method === "files.getUploadURLExternal")!;
  assert.deepEqual([get.params.filename, get.params.snippet_type], ["changes.diff", "diff"]);
  assert.equal(done.params.thread_ts, "100.000001");
  const body = slack.uploads.get(JSON.parse(done.params.files)[0].id)!.body;
  assert.match(body, /^--- big\.py\n\+\+\+ big\.py\n-old line 0/);
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
  assert.deepEqual(sent.tools, ["send_file", "ask_user"]);
  assert.equal(sent.result, "Sent report.txt to the user.");
  const done = calls("files.completeUploadExternal").at(-1)!;
  assert.deepEqual([done.params.channel_id, done.params.thread_ts, done.params.initial_comment], [DM, "100.000001", "here it is"]);
  const [{ id }] = JSON.parse(done.params.files);
  assert.deepEqual(slack.uploads.get(id), { body: "report body", auth: undefined });
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

test("a file-only message (no text) still reaches the agent", async () => {
  const file = (id: string, name: string, mimetype: string) =>
    ({ id, name, mimetype, size: 20, url_private_download: `${slack.url}/files/${id}/${name}` });
  await slack.emit("events_api", slack.dm("UPEPE", "", {
    ts: "100.000010", thread_ts: "100.000001", subtype: "file_share",
    files: [file("F3", "data.csv", "text/csv")],
  }));
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text?.includes("data.csv")));
});

test("a $command as a new message gets help, not the folder picker", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "$help", { ts: "800.000001" }));
  const help = await waitFor(() => posts.find((p) => p.params.thread_ts === "800.000001"));
  assert.match(help.params.text, /^\*Commands\*/);
  await slack.emit("events_api", slack.dm("UPEPE", "$model", { ts: "800.000002" }));
  const other = await waitFor(() => posts.find((p) => p.params.thread_ts === "800.000002"));
  assert.match(other.params.text, /^Commands work inside a thread/);
  assert.equal(posts.some((p) => ["800.000001", "800.000002"].includes(p.params.thread_ts) && p.params.blocks?.includes("picker_open_modal")), false);
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
  const head = await waitFor(() => posts.find((p) => p.params.thread_ts === "300.000001" && p.params.reply_broadcast === "true")?.params.text);
  assert.ok(calls("chat.delete").some((c) => c.params.ts === msg.ts));
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
  const panel = await waitFor(() => posts.find((p) => p.params.thread_ts === T && p.params.blocks?.includes("cfg_open")));
  assert.match(panel.params.text, /\*Model\* `Model one`/);
  assert.doesNotMatch(panel.params.text, /Session Mode/);
  const n = views().length;
  await slack.emit("interactive", { type: "block_actions", user: { id: "UPEPE" }, trigger_id: "T_cfg", channel: { id: DM }, message: { ts: panel.ts, thread_ts: T }, actions: [{ type: "button", action_id: "cfg_open", value: T }] }, true);
  await waitFor(() => views().length > n);
  const settingsView = lastView();
  const menu = settingsView.blocks.find((b: any) => b.block_id === "cfg_model").element;
  assert.equal(menu.initial_option.value, "m1");
  assert.deepEqual(await submit(settingsView, { cfg_model: { value: { type: "static_select", selected_option: { value: "m2" } } } }), { response_action: "clear" });
  await waitFor(() => agentLog().some((e) => e.m === "config" && e.configId === "model" && e.value === "m2"));
  await waitFor(() => calls("chat.update").some((c) => c.params.ts === panel.ts && /`Model two`/.test(c.params.text)));

  await say("$compact", "500.000004");
  await waitFor(() => agentLog().slice(before).some((e) => e.m === "prompt" && e.text === "/compact"));
  await say("$model", "500.000012"); // after a turn the agent has reported its context use
  await waitFor(() => posts.find((p) => p.params.thread_ts === T && /\*Context\* 24k \/ 200k \(12%\)   ·   \*Cost\* \$0\.012/.test(p.params.text ?? "")));
  await say("$review branch", "500.000010"); // the agent's own command, with arguments
  await waitFor(() => agentLog().slice(before).some((e) => e.m === "prompt" && e.text === "/review branch"));
  await say("$HOME is unset", "500.000011"); // not a command: goes to the agent as a message
  await waitFor(() => agentLog().slice(before).some((e) => e.m === "prompt" && e.text === "$HOME is unset"));

  await say("! echo shell-$((40+2))", "500.000005");
  const out = await waitFor(() => posts.find((p) => p.params.thread_ts === T && p.params.markdown_text?.includes("$ echo shell")));
  assert.match(out.params.markdown_text, /shell-42/);
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

  await say("$fork", "500.000013"); // a copy of the session in a new thread, rooted at our message
  const root = await waitFor(() => posts.find((p) => !p.params.thread_ts && /^🍴 Fork of \*Session ses_\d+\* in /.test(p.params.text ?? "")));
  const forked = await waitFor(() => agentLog().find((e) => e.m === "new" && e.from === fresh.sessionId));
  await waitFor(() => posts.find((p) => p.params.thread_ts === T && p.params.text?.includes(`<https://example.slack.com/archives/${DM}/p${root.ts.replace(".", "")}|the copy>`)));
  await slack.emit("events_api", slack.dm("UPEPE", "in the fork", { ts: "600.000001", thread_ts: root.ts }));
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "in the fork" && e.sessionId === forked.sessionId));

  await say("$nope", "500.000009");
  await waitFor(() => posts.find((p) => p.params.thread_ts === T && /Unknown command/.test(p.params.text ?? "")));
});

test("an edit before the picker changes the first prompt; an edit in a session reaches the agent as a correction", async () => {
  const edit = (ts: string, text: string, thread_ts?: string) =>
    slack.dm("UPEPE", "", { user: undefined, subtype: "message_changed", message: { type: "message", user: "UPEPE", ts, thread_ts, text }, previous_message: { text: "old" } });
  await slack.emit("events_api", slack.dm("UPEPE", "lsit files", { ts: "700.000001" }));
  await waitFor(() => posts.find((p) => p.params.thread_ts === "700.000001" && p.params.blocks?.includes("picker_open_modal")));
  await slack.emit("events_api", edit("700.000001", "list files"));
  const { view } = await openPicker("700.000001");
  const next = await submit(view);
  await submit(next.view, sessionChoice("new"));
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "list files"));
  assert.equal(agentLog().some((e) => e.m === "prompt" && e.text === "lsit files"), false);

  await slack.emit("events_api", edit("700.000001", "list all files"));
  await slack.emit("events_api", edit("700.000002", "$help", "700.000001")); // edited commands do not run again
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "list all files"));
  const envelope = readFileSync(`${process.env.MOCK_AGENT_LOG}.envelopes`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.body === "list all files");
  assert.match(envelope.attrs, / edited="true"$/);
  await sleep(200);
  assert.equal(agentLog().some((e) => e.m === "prompt" && /help/.test(e.text)), false);
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
    channel: { id: "C_TEAM" }, message: { ts: "900.000001", user: "UXAVI", text: "login fails on Safari" },
  }, true);
  await waitFor(() => views().length > n);
  const root = posts.find((p) => p.params.channel === "UPEPE" && p.params.text?.startsWith("📎"))!;
  assert.equal(root.params.text, "📎 <https://acme.slack.com/archives/C_TEAM/p900000001|Shared message>:\n> login fails on Safari");
  const next = await submit(lastView()); // the base folder
  await submit(next.view, sessionChoice("new"));
  const p = await waitFor(() => agentLog().find((e) => e.m === "prompt" && e.text.startsWith("login fails on Safari")));
  assert.match(p.text, /\[Shared from this Slack message: https:\/\/acme\.slack\.com\/archives\/C_TEAM\/p900000001\]/);
});

test("the picker message offers a one-tap new session in the last used folder", async () => {
  await slack.emit("events_api", slack.dm("UPEPE", "quick one", { ts: "910.000001" }));
  const msg = await waitFor(() => posts.find((p) => p.params.thread_ts === "910.000001" && p.params.blocks?.includes("picker_quick")));
  const quick = JSON.parse(msg.params.blocks)[1].elements[1];
  const last = agentLog().filter((e) => e.m === "new").at(-1).cwd;
  assert.equal(quick.text.text, `▶ New session in ${last === base ? basename(base) : basename(last)}`);
  await click({ ts: msg.ts, thread_ts: "910.000001" }, { type: "button", action_id: "picker_quick", value: quick.value });
  await waitFor(() => agentLog().some((e) => e.m === "prompt" && e.text === "quick one"));
  assert.equal(agentLog().filter((e) => e.m === "new").at(-1).cwd, last);
});
