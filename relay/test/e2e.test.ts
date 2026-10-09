// End-to-end: mock Slack <-> gateway <-> real Bolt apps acting as daemons
// (socketMode + clientOptions.slackApiUrl pointing at the gateway).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import bolt from "@slack/bolt";
import { createGateway, addPreamble, localTime, WORKING_MESSAGES, SLOW_WORKING_MESSAGES } from "../src/gateway.ts";
import { createMockSlack, APP_TOKEN, BOT_TOKEN } from "./mock-slack.ts";

const { App, LogLevel } = bolt;

const USERS = { UPEPE: "pepe@example.com", UXAVI: "xavi@example.com" };
const TOKENS: Record<string, string> = { "gw-pepe": USERS.UPEPE, "gw-xavi": USERS.UXAVI };
// A free port, so the suite doesn't collide with a running run-local.sh (18080).
const GW_PORT = await new Promise<number>((r) => {
  const s = createServer().listen(0, () => {
    const p = (s.address() as any).port;
    s.close(() => r(p));
  });
});
const GW = `http://127.0.0.1:${GW_PORT}`;

const slack = createMockSlack(USERS);
let gw: ReturnType<typeof createGateway>;

type Daemon = { app: InstanceType<typeof App>; got: any[]; name: string };
const daemons: Daemon[] = [];

async function daemon(name: string, token: string): Promise<Daemon> {
  const app = new App({
    socketMode: true,
    appToken: token,
    token,
    clientOptions: { slackApiUrl: `${GW}/api/` },
    logLevel: LogLevel.ERROR,
  });
  const d: Daemon = { app, got: [], name };
  app.message(async ({ message }) => {
    d.got.push(message);
  });
  app.view("settings", async ({ ack }) => {
    await ack({ response_action: "errors", errors: { cwd: `rejected by ${name}` } });
  });
  app.event("agent_session_stopped", async ({ event }) => {
    d.got.push(event);
  });
  await app.start();
  daemons.push(d);
  return d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(20);
  }
  assert.fail("timed out waiting for condition");
}

before(async () => {
  await slack.start();
  gw = createGateway({
    port: GW_PORT,
    publicUrl: GW,
    upstreamApiUrl: `${slack.url}/api/`,
    appToken: APP_TOKEN,
    botToken: BOT_TOKEN,
    resolveToken: async (t) => TOKENS[t] ?? null,
    pingIntervalMs: 1000,
    workingNoticeMs: 150,
    slowWorkingAfterMs: 400,
    slowWorkingNoticeMs: 150,
    rates: {},
    offlineMessage: "Offline. Start it at <https://example.com|your workspace>.",
    log: () => {},
  });
  await gw.start();
});

after(async () => {
  for (const d of daemons) await d.app.stop().catch(() => {});
  await gw.stop();
  await slack.stop();
});

let pepe1: Daemon;

test("criterion 1: a DM reaches only its owner's daemon", async () => {
  pepe1 = await daemon("pepe1", "gw-pepe");
  await slack.emit("events_api", slack.dm("UPEPE", "hola desde pepe"));
  await waitFor(() => pepe1.got.length === 1);
  assert.equal(pepe1.got[0].text, "hola desde pepe");
  assert.equal(gw.state(USERS.UXAVI), null); // xavi never connected, never routed to
});

test("criterion 3: channels, group DMs and bot messages are not routed", async () => {
  const before = pepe1.got.length;
  await slack.emit("events_api", { event_id: "EvC1", event: { type: "message", channel_type: "channel", channel: "C1", user: "UPEPE", text: "x" } });
  await slack.emit("events_api", { event_id: "EvC2", event: { type: "message", channel_type: "mpim", channel: "G1", user: "UPEPE", text: "x" } });
  await slack.emit("events_api", slack.dm("UPEPE", "from a bot", { bot_id: "BOTHER" }));
  await sleep(200);
  assert.equal(pepe1.got.length, before);
});

test("a user's edit reaches its owner; bot edits and unfurls do not", async () => {
  const before = pepe1.got.length;
  const changed = (message: Record<string, unknown>, previous = "old") =>
    slack.dm("UPEPE", "", { user: undefined, subtype: "message_changed", message: { type: "message", ts: "1.1", ...message }, previous_message: { text: previous } });
  await slack.emit("events_api", changed({ user: "UPEPE", text: "fixed" }));
  await slack.emit("events_api", changed({ bot_id: "B1", user: "UBOT", text: "streamed" }));
  await slack.emit("events_api", changed({ user: "UPEPE", text: "old" })); // unfurl: same text
  await waitFor(() => pepe1.got.length === before + 1);
  await sleep(200);
  assert.equal(pepe1.got.length, before + 1);
  assert.equal(pepe1.got.at(-1).message.text, "fixed");
});

test("criterion 5: a redelivered event is delivered once", async () => {
  const before = pepe1.got.length;
  const ev = slack.dm("UPEPE", "dup");
  await slack.emit("events_api", ev);
  await slack.emit("events_api", ev);
  await sleep(200);
  assert.equal(pepe1.got.length, before + 1);
});

test("criterion 8: a daemon can only post to its owner's DM, with the real token upstream", async () => {
  await assert.rejects(
    pepe1.app.client.chat.postMessage({ channel: "D_UXAVI", text: "spoof" }),
    /restricted_action/,
  );
  const r = await pepe1.app.client.chat.postMessage({ channel: "D_UPEPE", text: "reply" });
  assert.equal(r.ok, true);
  const upstream = slack.calls.filter((c) => c.method === "chat.postMessage" && c.params.text === "reply");
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].token, BOT_TOKEN);
  assert.equal(slack.calls.some((c) => c.params.text === "spoof"), false);
  await assert.rejects(pepe1.app.client.users.list({}), /restricted_action/);
  const list = await pepe1.app.client.conversations.list({});
  assert.deepEqual(list.channels, []);
});

test("a daemon can read its own user and DM and remove its reactions, nobody else's", async () => {
  const c = pepe1.app.client;
  assert.equal((await c.users.info({ user: "UPEPE" })).ok, true);
  assert.equal((await c.conversations.info({ channel: "D_UPEPE" })).ok, true);
  assert.equal((await c.reactions.remove({ channel: "D_UPEPE", timestamp: "1.0", name: "eyes" })).ok, true);
  await assert.rejects(c.users.info({ user: "UXAVI" }), /restricted_action/);
  await assert.rejects(c.conversations.info({ channel: "D_UXAVI" }), /restricted_action/);
  await assert.rejects(c.reactions.remove({ channel: "D_UXAVI", timestamp: "1.0", name: "eyes" }), /restricted_action/);
});

test("working notice: shown in the thread while 👀 is on a message, removed with it", async () => {
  const c = pepe1.app.client;
  const notices = () => slack.calls.filter((x) => x.params.channel === "D_UPEPE" && [...WORKING_MESSAGES, ...SLOW_WORKING_MESSAGES].some((m) => (x.params.text ?? "").startsWith(m)));
  // A reply inside an existing thread: the notice goes to the thread root, not under the reply.
  await slack.emit("events_api", slack.dm("UPEPE", "long task", { ts: "50.2", thread_ts: "50.0" }));
  await c.reactions.add({ channel: "D_UPEPE", timestamp: "50.2", name: "eyes" });
  // Quick lines first, then a "taking a while" line with the elapsed time.
  await waitFor(() => notices().some((x) => SLOW_WORKING_MESSAGES.some((m) => x.params.text.startsWith(m))));
  const [post, update] = notices();
  assert.equal(post.method, "chat.postMessage");
  assert.ok(WORKING_MESSAGES.includes(post.params.text), post.params.text);
  assert.notEqual(update.params.text, post.params.text, "each refresh changes the message");
  assert.match(notices().at(-1)!.params.text, /\(0 min\)$/);
  assert.equal(post.params.thread_ts, "50.0");
  await c.reactions.remove({ channel: "D_UPEPE", timestamp: "50.2", name: "eyes" });
  await waitFor(() => slack.calls.some((x) => x.method === "chat.delete" && x.params.channel === "D_UPEPE"));
  const n = notices().length;
  await sleep(700);
  assert.equal(notices().length, n, "no updates after the turn ended");

  // A quick turn: its line is posted at once and deleted with the reaction.
  await c.reactions.add({ channel: "D_UPEPE", timestamp: "60.0", name: "eyes" });
  await waitFor(() => notices().length > n);
  const dels = slack.calls.filter((x) => x.method === "chat.delete").length;
  await c.reactions.remove({ channel: "D_UPEPE", timestamp: "60.0", name: "eyes" });
  await waitFor(() => slack.calls.filter((x) => x.method === "chat.delete").length > dels);

  // The progress reactions themselves never reach Slack; any other reaction does.
  assert.equal(slack.calls.some((x) => x.method.startsWith("reactions.")), false);
  await c.reactions.add({ channel: "D_UPEPE", timestamp: "60.0", name: "white_check_mark" });
  assert.ok(slack.calls.some((x) => x.method === "reactions.add" && x.params.name === "white_check_mark"));
});

test("files: URLs are rewritten and only the owner can fetch them", async () => {
  const ev = slack.dm("UPEPE", "see file", {
    subtype: "file_share",
    files: [{ id: "F1", name: "a.txt", url_private: `${slack.url}/files/F1/a.txt`, url_private_download: `${slack.url}/files/F1/a.txt` }],
  });
  const before = pepe1.got.length;
  await slack.emit("events_api", ev);
  await waitFor(() => pepe1.got.length === before + 1);
  const url = pepe1.got.at(-1).files[0].url_private_download as string;
  assert.ok(url.startsWith(GW), url);
  const ok = await fetch(url, { headers: { authorization: "Bearer gw-pepe" } });
  assert.equal(await ok.text(), "content of F1");
  const denied = await fetch(url, { headers: { authorization: "Bearer gw-xavi" } });
  assert.equal(denied.status, 404);
});

test("interactivity: ack payload is relayed and views.open needs a delivered trigger", async () => {
  await assert.rejects(
    pepe1.app.client.views.open({ trigger_id: "T_FORGED", view: { type: "modal", title: { type: "plain_text", text: "x" }, blocks: [] } }),
    /restricted_action/,
  );
  const reply = await slack.emit(
    "interactive",
    { type: "view_submission", user: { id: "UPEPE" }, trigger_id: "T_REAL", view: { id: "V1", callback_id: "settings", state: { values: {} } } },
    true,
  );
  assert.deepEqual(reply, { response_action: "errors", errors: { cwd: "rejected by pepe1" } });
  const opened = await pepe1.app.client.views.open({ trigger_id: "T_REAL", view: { type: "modal", title: { type: "plain_text", text: "x" }, blocks: [] } });
  assert.equal(opened.ok, true);
});

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

test("criterion 4: a second daemon parks as standby and takes over when the first dies", async () => {
  const pepe2 = await daemon("pepe2", "gw-pepe");
  assert.deepEqual(gw.state(USERS.UPEPE), { primary: gw.state(USERS.UPEPE)!.primary, standby: 1 });
  const n1 = pepe1.got.length;
  await slack.emit("events_api", slack.dm("UPEPE", "still pepe1"));
  await waitFor(() => pepe1.got.length === n1 + 1);
  assert.equal(pepe2.got.length, 0);

  // A turn in progress dies with the primary: its working notice is removed.
  await pepe1.app.client.reactions.add({ channel: "D_UPEPE", timestamp: "70.0", name: "eyes" });
  await waitFor(() => slack.calls.some((x) => x.method === "chat.postMessage" && x.params.thread_ts === "70.0"));
  const deletes = slack.calls.filter((x) => x.method === "chat.delete").length;
  await pepe1.app.stop();
  await waitFor(() => gw.state(USERS.UPEPE)!.standby === 0);
  await waitFor(() => slack.calls.filter((x) => x.method === "chat.delete").length > deletes);
  await slack.emit("events_api", slack.dm("UPEPE", "now pepe2"));
  await waitFor(() => pepe2.got.length === 1);
  assert.equal(pepe2.got[0].text, "now pepe2");
  assert.equal(pepe1.got.at(-1).text, "still pepe1");
});

test("offline: every message gets OFFLINE_MESSAGE where it was written, and nothing is replayed on connect", async () => {
  const notice = (thread?: string) =>
    slack.calls.filter((c) => c.method === "chat.postMessage" && c.params.thread_ts === thread && /^Offline\. Start it/.test(c.params.text));
  for (const ts of ["100.000001", "100.000002"]) await slack.emit("events_api", slack.dm("UXAVI", "hello?", { ts }));
  await waitFor(() => notice(undefined).length === 2); // top-level: answered top-level, no thread opened
  await slack.emit("events_api", slack.dm("UXAVI", "still?", { ts: "100.000004", thread_ts: "100.000003" }));
  await waitFor(() => notice("100.000003").length === 1);
  const xavi = await daemon("xavi", "gw-xavi");
  await slack.emit("events_api", slack.dm("UXAVI", "now?"));
  await waitFor(() => xavi.got.length === 1);
  assert.equal(xavi.got[0].text, "now?");
});

test("session preamble: only a new top-level message, never commands, edits or other events", () => {
  const user = { email: "pepe@example.com", name: "Pepe Pérez", tz: "Europe/Madrid" };
  const ts = String(Date.UTC(2026, 9, 3, 16, 40) / 1000); // 18:40 in Madrid (CEST)
  const top = { type: "message", text: "ls -la", ts };
  addPreamble(top, "P", user);
  assert.equal(
    top.text,
    "ls -la\n\n[Context from the Slack relay. Do not mention or quote this block.]\n" +
      "User: Pepe Pérez <pepe@example.com>. Local time: 2026-10-03 18:40 (Europe/Madrid).\nP\n[End of relay context]",
  );
  const untouched = [
    { type: "message", text: "again", thread_ts: "1.0", ts },
    { type: "message", text: "/dir /tmp", ts },
    { type: "message", text: " /dir /tmp", ts }, // Slack DM workaround for unregistered commands
    { type: "message", text: "!ls", ts }, // cc-connect shell shortcut: the rest would run
    { type: "message", text: "$help", ts }, // the daemon's commands
    { type: "message", subtype: "message_changed", ts },
    { type: "reaction_added", ts },
  ];
  for (const ev of untouched) {
    const before = JSON.stringify(ev);
    addPreamble(ev, "P", user);
    assert.equal(JSON.stringify(ev), before);
  }
  const off = { type: "message", text: "x", ts };
  addPreamble(off, "", user);
  assert.equal(off.text, "x");
  const files = { type: "message", subtype: "file_share", text: "see this", ts };
  addPreamble(files, "P", { email: "x@a.com" }); // no name, no tz: email and UTC
  assert.match(files.text, /\nUser: x@a\.com\. Local time: 2026-10-03 16:40 \(UTC\)\.\n/);
  assert.equal(localTime(new Date(0), "Not/AZone"), "1970-01-01 00:00 (UTC)");
});

test("unknown daemon token is rejected", async () => {
  const res = await fetch(`${GW}/api/apps.connections.open`, { method: "POST", headers: { authorization: "Bearer nope" } });
  assert.deepEqual(await res.json(), { ok: false, error: "invalid_auth" });
});
