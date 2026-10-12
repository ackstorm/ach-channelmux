// End-to-end: mock Slack <-> gateway <-> real Bolt apps acting as daemons
// (socketMode + clientOptions.slackApiUrl pointing at the gateway).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import bolt from "@slack/bolt";
import { createGateway, addPreamble, parseChannels, addShortcutPreamble, localTime, WORKING_MESSAGES, SLOW_WORKING_MESSAGES } from "../src/gateway.ts";
import { createMockSlack, APP_TOKEN, BOT_TOKEN } from "./mock-slack.ts";

const { App, LogLevel } = bolt;

const USERS = { UPEPE: "pepe@example.com", UXAVI: "xavi@example.com", UANA: "ana@example.com" };
const TOKENS: Record<string, string> = { "gw-pepe": USERS.UPEPE, "gw-pepe-case": "Pepe@Example.COM", "gw-xavi": USERS.UXAVI, "gw-bot": "bot@example.com", "gw-nobody": "nobody@example.com" };
const CHANNEL_NAMES = { C_DEV: "dev", C_CODE: "code", C_OTHER: "other", C_SALES: "sales", C_OPS: "ops", C_QA: "qa" };
// Keyed by name, or by id (C_OPS): an id survives a rename and cannot be taken by a new channel of that name.
const CHANNELS = { dev: { email: USERS.UPEPE, code: false }, code: { email: USERS.UPEPE, code: true }, sales: { email: "bot@example.com", code: false }, C_OPS: { email: USERS.UPEPE, code: false }, qa: { email: USERS.UANA, code: false } }; // ana never connects
// A free port, so the suite doesn't collide with a running run-local.sh (18080).
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, () => {
      const p = (s.address() as any).port;
      s.close(() => r(p));
    });
  });
const GW_PORT = await freePort();
const GW = `http://127.0.0.1:${GW_PORT}`;

const slack = createMockSlack(USERS, CHANNEL_NAMES);
let gw: ReturnType<typeof createGateway>;
let sessionPreamble: string | undefined; // set by a test, read by the gateway on each message

type Daemon = { app: InstanceType<typeof App>; got: any[]; name: string };
const daemons: Daemon[] = [];

async function daemon(name: string, token: string, gwUrl = GW): Promise<Daemon> {
  const app = new App({
    socketMode: true,
    appToken: token,
    token,
    clientOptions: { slackApiUrl: `${gwUrl}/api/` },
    logLevel: LogLevel.ERROR,
  });
  const d: Daemon = { app, got: [], name };
  app.message(async ({ message }) => {
    d.got.push(message);
  });
  app.action(/.*/, async ({ ack, body }) => {
    await ack();
    d.got.push(body);
  });
  app.shortcut(/.*/, async ({ ack, body }) => {
    await ack();
    d.got.push(body);
  });
  app.view("settings", async ({ ack }) => {
    await ack({ response_action: "errors", errors: { cwd: `rejected by ${name}` } });
  });
  app.event("agent_session_stopped", async ({ event }) => {
    d.got.push(event);
  });
  app.event("app_home_opened", async ({ event }) => {
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
    get sessionPreamble() {
      return sessionPreamble;
    },
    channels: CHANNELS,
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

test("criterion 3: unmapped channels, group DMs and bot messages are not routed", async () => {
  const before = pepe1.got.length;
  await slack.emit("events_api", { event_id: "EvC1", event: { type: "message", channel_type: "channel", channel: "C1", user: "UPEPE", text: "x" } });
  await slack.emit("events_api", { event_id: "EvC2", event: { type: "message", channel_type: "mpim", channel: "G1", user: "UPEPE", text: "x" } });
  await slack.emit("events_api", slack.dm("UPEPE", "from a bot", { bot_id: "BOTHER" }));
  await sleep(200);
  assert.equal(pepe1.got.length, before);
});

const inChannel = (channel: string, user: string, text: string, extra: Record<string, unknown> = {}) =>
  slack.dm(user, text, { channel_type: "channel", channel, ...extra });

test("a message in a configured channel reaches the channel's owner, with code_channel_origin only in CODE_CHANNELS", async () => {
  const before = pepe1.got.length;
  await slack.emit("events_api", inChannel("C_DEV", "UPEPE", "in dev"));
  await slack.emit("events_api", inChannel("C_CODE", "UPEPE", "in code"));
  await slack.emit("events_api", inChannel("C_OTHER", "UPEPE", "in other"));
  await slack.emit("events_api", inChannel("C_DEV", "UBOT", "from a bot", { bot_id: "BOTHER" }));
  await waitFor(() => pepe1.got.length === before + 2);
  await sleep(200);
  const got = pepe1.got.slice(before);
  assert.equal(got.length, 2);
  const dev = got.find((m) => m.channel === "C_DEV");
  const code = got.find((m) => m.channel === "C_CODE");
  assert.equal(dev.text, "in dev");
  assert.equal(dev.code_channel_origin, undefined);
  assert.equal(code.text, "in code");
  assert.equal(code.code_channel_origin, true);
});

test("a message in a channel goes to the owner's daemon even when someone else wrote it", async () => {
  const before = pepe1.got.length;
  await slack.emit("events_api", inChannel("C_DEV", "UXAVI", "from xavi"));
  await waitFor(() => pepe1.got.length === before + 1);
  assert.equal(pepe1.got.at(-1).text, "from xavi");
  // So do their edits and a stop of the agent session in the channel.
  await slack.emit("events_api", inChannel("C_DEV", "UXAVI", "", { user: undefined, subtype: "message_changed", message: { type: "message", ts: "1.1", user: "UXAVI", text: "fixed" }, previous_message: { text: "old" } }));
  await waitFor(() => pepe1.got.length === before + 2);
  assert.equal(pepe1.got.at(-1).message.text, "fixed");
  await slack.emit("events_api", { type: "event_callback", event_id: "EvStopC", team_id: "T1", api_app_id: "A1", event: { type: "agent_session_stopped", channel: "C_DEV", thread_ts: "90.0", user: "UXAVI" } });
  await waitFor(() => pepe1.got.length === before + 3);
  assert.equal(pepe1.got.at(-1).type, "agent_session_stopped");
  // The channel's name is looked up once.
  assert.equal(slack.calls.filter((c) => c.method === "conversations.info" && c.params.channel === "C_DEV").length, 1);
});

let bot: Daemon;
test("a service account without a Slack user connects when it owns a channel; other unknown emails do not", async () => {
  // Offline: the notice goes in the message's thread, not the channel's main view.
  await slack.emit("events_api", inChannel("C_SALES", "UXAVI", "<@UBOT> anyone?", { ts: "200.000001" }));
  await waitFor(() => slack.calls.some((c) => c.method === "chat.postMessage" && c.params.channel === "C_SALES" && c.params.thread_ts === "200.000001" && /^Offline\. Start it/.test(c.params.text)));
  bot = await daemon("bot", "gw-bot");
  await slack.emit("events_api", inChannel("C_SALES", "UXAVI", "a lead"));
  await waitFor(() => bot.got.length === 1);
  assert.equal(bot.got[0].text, "a lead");
  const res = await fetch(`${GW}/api/apps.connections.open`, { method: "POST", headers: { authorization: "Bearer gw-nobody" } });
  assert.deepEqual(await res.json(), { ok: false, error: "invalid_auth" });
});

test("an owner's daemon posts in its channel and not in another", async () => {
  const c = pepe1.app.client;
  assert.ok((await c.chat.postMessage({ channel: "C_DEV", text: "warm" })).ok); // C_DEV seen in an event
  assert.ok((await c.chat.postMessage({ channel: "C_OPS", text: "cold" })).ok); // looked up on the way
  await assert.rejects(c.chat.postMessage({ channel: "C_OTHER", text: "x" }), /restricted_action/);
  await assert.rejects(c.chat.postMessage({ channel: "C_SALES", text: "x" }), /restricted_action/); // the bot's
  await assert.rejects(bot.app.client.chat.postMessage({ channel: "C_DEV", text: "x" }), /restricted_action/);
  assert.ok((await bot.app.client.chat.postMessage({ channel: "C_SALES", text: "hi" })).ok);
  await assert.rejects(bot.app.client.chat.postMessage({ channel: "", text: "x" }), /restricted_action/); // its empty DM is nobody's
});

test("a code channel can be created only from a CODE_CHANNELS origin, and is then the owner's", async () => {
  const c = pepe1.app.client;
  const create = (origin?: string) => c.apiCall("agents.conversations.create", { origin_channel_id: origin, name: "fix-login" });
  await assert.rejects(create("C_DEV"), /restricted_action/);
  await assert.rejects(create(), /restricted_action/);
  await assert.rejects(bot.app.client.apiCall("agents.conversations.create", { origin_channel_id: "C_CODE" }), /restricted_action/);
  const r = (await create("C_CODE")) as { channel_id?: string };
  assert.equal(r.channel_id, "CCODE1");
  assert.ok((await c.apiCall("agents.conversations.setProperties", { channel_id: "CCODE1", title: "Fix login" })).ok);
  assert.ok((await c.chat.postMessage({ channel: "CCODE1", text: "on it" })).ok);
  await assert.rejects(bot.app.client.chat.postMessage({ channel: "CCODE1", text: "x" }), /restricted_action/);
  await assert.rejects(bot.app.client.apiCall("agents.conversations.archive", { channel_id: "CCODE1" }), /restricted_action/);
  const before = pepe1.got.length;
  await slack.emit("events_api", inChannel("CCODE1", "UXAVI", "also check Safari", { channel_type: "group" }));
  await waitFor(() => pepe1.got.length === before + 1);
  assert.equal(pepe1.got.at(-1).text, "also check Safari");
  assert.equal(slack.calls.some((x) => x.method === "conversations.info" && x.params.channel === "CCODE1"), false);
});

test("after a relay restart a code channel's messages still reach its owner, and its daemon may still write there", async () => {
  const { channel_id: id } = (await pepe1.app.client.apiCall("agents.conversations.create", { origin_channel_id: "C_CODE", name: "fix-signup" })) as { channel_id?: string };
  // A fresh relay: it knows no code channel, Slack's conversations.info says where this one came from.
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const gw2 = createGateway({ port, publicUrl: url, upstreamApiUrl: `${slack.url}/api/`, appToken: APP_TOKEN, botToken: BOT_TOKEN, resolveToken: async (t) => TOKENS[t] ?? null, rates: {}, workingNoticeMs: 0, channels: CHANNELS, log: () => {} });
  await gw2.start();
  const [pepe, bot2] = [await daemon("pepe-r", "gw-pepe", url), await daemon("bot-r", "gw-bot", url)];
  try {
    await slack.emit("events_api", inChannel(id as string, "UXAVI", "still there?", { channel_type: "group" }));
    await waitFor(() => pepe.got.length === 1);
    assert.equal(pepe.got[0].text, "still there?");
    assert.equal(pepe.got[0].code_channel_origin, undefined);
    assert.ok((await pepe.app.client.apiCall("agents.conversations.setProperties", { channel_id: id, title: "Fix signup" })).ok);
    await assert.rejects(bot2.app.client.apiCall("agents.conversations.setProperties", { channel_id: id }), /restricted_action/);
    assert.equal(slack.calls.filter((c) => c.method === "conversations.info" && c.params.channel === id).length, 1);
  } finally {
    for (const d of [pepe, bot2]) await d.app.stop();
    await gw2.stop();
  }
});

test("ephemeral notices in a channel may go to any member; in the DM only to the owner", async () => {
  const c = pepe1.app.client;
  assert.ok((await c.chat.postEphemeral({ channel: "C_DEV", user: "UXAVI", text: "only you" })).ok);
  assert.ok((await c.chat.postEphemeral({ channel: "D_UPEPE", user: "UPEPE", text: "only you" })).ok);
  await assert.rejects(c.chat.postEphemeral({ channel: "D_UPEPE", user: "UXAVI", text: "x" }), /restricted_action/);
  await assert.rejects(c.chat.postEphemeral({ channel: "UPEPE", user: "UXAVI", text: "x" }), /restricted_action/);
});

test("users.info for any user once the owner has a channel", async () => {
  assert.ok((await pepe1.app.client.users.info({ user: "UXAVI" })).ok);
  // xavi owns no channel: only himself.
  const info = async (user: string) => (await (await fetch(`${GW}/api/users.info?user=${user}`, { method: "POST", headers: { authorization: "Bearer gw-xavi" } })).json()).error;
  assert.equal(await info("UXAVI"), undefined);
  assert.equal(await info("UPEPE"), "restricted_action");
});

test("a button in a channel thread clicked by another user reaches the channel owner's daemon, and its modal's submit too", async () => {
  const before = pepe1.got.length;
  await slack.emit("interactive", { type: "block_actions", user: { id: "UXAVI" }, trigger_id: "T_CHAN", channel: { id: "C_DEV" }, container: { type: "message", channel_id: "C_DEV" }, actions: [{ action_id: "new_session", type: "button" }] }, true);
  await waitFor(() => pepe1.got.length === before + 1);
  assert.equal(pepe1.got.at(-1).trigger_id, "T_CHAN");
  const view = { type: "modal" as const, callback_id: "settings", title: { type: "plain_text" as const, text: "x" }, blocks: [] };
  const opened = await pepe1.app.client.views.open({ trigger_id: "T_CHAN", view });
  assert.ok(opened.ok);
  // The submit carries no channel: the view says whose it is.
  const reply = await slack.emit("interactive", { type: "view_submission", user: { id: "UXAVI" }, trigger_id: "T_CHAN2", view: { id: opened.view!.id, callback_id: "settings", state: { values: {} } } }, true);
  assert.deepEqual(reply, { response_action: "errors", errors: { cwd: "rejected by pepe1" } });
  // A shortcut is personal: it stays with whoever used it, even in the owner's channel.
  const n = pepe1.got.length;
  await slack.emit("interactive", { type: "message_action", callback_id: "send_to_agent", user: { id: "UXAVI" }, trigger_id: "T_SC", channel: { id: "C_DEV" }, message: { text: "look", ts: "1.0" } }, true);
  await sleep(200);
  assert.equal(pepe1.got.length, n);
});

test("!ls from a non-owner in a channel is refused with an ephemeral note; from the owner it passes", async () => {
  const notes = (text: string) => slack.calls.filter((c) => c.method === "chat.postEphemeral" && c.params.user === "UXAVI" && c.params.text === text);
  const before = pepe1.got.length;
  // A top-level message that does not mention the agent is not for it: "!!! great" passes untouched.
  await slack.emit("events_api", inChannel("C_DEV", "UXAVI", "!!! great", { ts: "300.000000" }));
  await waitFor(() => pepe1.got.length === before + 1);
  await slack.emit("events_api", inChannel("C_DEV", "UXAVI", "<@UBOT> !ls", { ts: "300.000001" }));
  await slack.emit("events_api", inChannel("C_DEV", "UXAVI", "<@UBOT>  !rm -rf /", { ts: "300.000003", thread_ts: "300.000002" }));
  await slack.emit("events_api", inChannel("C_DEV", "UXAVI", "!ls <@UBOT>", { ts: "300.000004" })); // the mention anywhere
  await waitFor(() => notes("🔒 Only <@UPEPE> can run shell commands here.").length === 3);
  assert.deepEqual(notes("🔒 Only <@UPEPE> can run shell commands here.").map((c) => [c.params.channel, c.params.thread_ts]).sort(), [["C_DEV", "300.000001"], ["C_DEV", "300.000002"], ["C_DEV", "300.000004"]]);
  await slack.emit("events_api", inChannel("C_DEV", "UPEPE", "<@UBOT> !ls"));
  await waitFor(() => pepe1.got.length === before + 2);
  assert.equal(pepe1.got.at(-1).text, "<@UBOT> !ls");
  // A service account has no owner to run them.
  const n = bot.got.length;
  await slack.emit("events_api", inChannel("C_SALES", "UXAVI", "<@UBOT> !ls"));
  await waitFor(() => notes("🔒 Shell commands are off in this channel.").length === 1);
  await sleep(100);
  assert.equal(bot.got.length, n);
});

test("offline in a channel: only a message for the agent gets the notice, in its thread", async () => {
  const notice = (thread: string) => slack.calls.filter((c) => c.method === "chat.postMessage" && c.params.channel === "C_QA" && c.params.thread_ts === thread && /^Offline\. Start it/.test(c.params.text));
  await slack.emit("events_api", inChannel("C_QA", "UXAVI", "lunch?", { ts: "600.000001" }));
  await slack.emit("events_api", inChannel("C_QA", "UXAVI", "me too", { ts: "600.000002", thread_ts: "600.000001" }));
  await slack.emit("events_api", inChannel("C_QA", "UXAVI", "is the build red, <@UBOT>?", { ts: "600.000003" }));
  await waitFor(() => notice("600.000003").length === 1);
  await slack.emit("events_api", inChannel("C_QA", "UXAVI", "hello?", { ts: "600.000004", thread_ts: "600.000003" })); // the mention's thread: the agent's
  await waitFor(() => notice("600.000003").length === 2);
  assert.equal(notice("600.000001").length, 0);
});

test("an email from the resolver meets its CHANNELS entry whatever its case", async () => {
  const res = await fetch(`${GW}/api/chat.postMessage`, { method: "POST", headers: { authorization: "Bearer gw-pepe-case" }, body: new URLSearchParams({ channel: "C_DEV", text: "hi" }) });
  assert.equal((await res.json()).ok, true);
});

test("a code channel whose origin lookup fails is looked up again on its next message", async () => {
  // Opened from a channel Slack cannot find (yet): nothing is cached.
  const { channel_id: id } = await (await fetch(`${slack.url}/api/agents.conversations.create`, { method: "POST", body: new URLSearchParams({ origin_channel_id: "C_GONE" }) })).json();
  const lookups = () => slack.calls.filter((c) => c.method === "conversations.info" && c.params.channel === id).length;
  await slack.emit("events_api", inChannel(id, "UXAVI", "hi", { ts: "610.000001", channel_type: "group" }));
  await waitFor(() => lookups() === 1);
  await sleep(100);
  await slack.emit("events_api", inChannel(id, "UXAVI", "hi again", { ts: "610.000002", channel_type: "group" }));
  await waitFor(() => lookups() === 2);
});

test("a channel message's context block names its author", async () => {
  const lookups = () => slack.calls.filter((c) => c.method === "users.info" && c.params.user === "UANA").length;
  const before = pepe1.got.length;
  await slack.emit("events_api", inChannel("C_DEV", "UANA", "no preamble configured"));
  sessionPreamble = "P";
  try {
    await slack.emit("events_api", inChannel("C_DEV", "UANA", "a reply", { thread_ts: "1.0" }));
    await waitFor(() => pepe1.got.length === before + 2);
    assert.equal(lookups(), 0, "the author is looked up only for a context block");
    await slack.emit("events_api", inChannel("C_DEV", "UANA", "hi team"));
    await waitFor(() => pepe1.got.length === before + 3);
    assert.match(pepe1.got.at(-1).text, /^hi team\n[\s\S]*\nUser: Real UANA <ana@example\.com>\. Local time: .* \(Europe\/Madrid\)\.\nP\n/);
    assert.equal(lookups(), 1);
  } finally {
    sessionPreamble = undefined;
  }
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

test("Home tab: opening it reaches the owner's daemon, which may publish only the owner's Home", async () => {
  const home = (user: string, tab: string, id: string) =>
    slack.emit("events_api", { type: "event_callback", event_id: id, team_id: "T1", api_app_id: "A1", event: { type: "app_home_opened", user, channel: `D_${user}`, tab } });
  const n = pepe1.got.length;
  await home("UPEPE", "messages", "EvHome0"); // the Messages tab is not routed
  await home("UPEPE", "home", "EvHome1");
  await waitFor(() => pepe1.got.length > n);
  assert.deepEqual([pepe1.got.length - n, pepe1.got.at(-1).type, pepe1.got.at(-1).tab], [1, "app_home_opened", "home"]);
  const view = { type: "home" as const, blocks: [] };
  assert.ok((await pepe1.app.client.views.publish({ user_id: "UPEPE", view })).ok);
  await assert.rejects(pepe1.app.client.views.publish({ user_id: "UXAVI", view }), /restricted_action/);
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
  // The Home tab, published by the relay itself.
  await slack.emit("events_api", { type: "event_callback", event_id: "EvHomeOff", team_id: "T1", api_app_id: "A1", event: { type: "app_home_opened", user: "UXAVI", channel: "D_UXAVI", tab: "home" } });
  await waitFor(() => slack.calls.some((c) => c.method === "views.publish" && c.params.user_id === "UXAVI"));
  const published = JSON.parse(slack.calls.find((c) => c.method === "views.publish" && c.params.user_id === "UXAVI")!.params.view);
  assert.match(published.blocks[0].text.text, /^\*Your agent\*\n🔴 Offline\nOffline\. Start it/);
  const xavi = await daemon("xavi", "gw-xavi");
  await slack.emit("events_api", slack.dm("UXAVI", "now?"));
  await waitFor(() => xavi.got.length === 1);
  assert.equal(xavi.got[0].text, "now?");
});

test("session preamble: a message shortcut's text gets it too, other interactions never", () => {
  const user = { email: "pepe@example.com" };
  const shortcut = { type: "message_action", message: { text: "login fails on Safari", ts: "1.0" } };
  addShortcutPreamble(shortcut, "P", user);
  assert.match(shortcut.message.text, /^login fails on Safari\n\n\[Context from the Slack relay[\s\S]*User: pepe@example\.com\.[\s\S]*\nP\n\[End of relay context\]$/);
  const click = { type: "block_actions", message: { text: "a picker" } };
  addShortcutPreamble(click, "P", user);
  assert.equal(click.message.text, "a picker");
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
  const noEmail = { type: "message", text: "hi", ts };
  addPreamble(noEmail, "P", { name: "Ext Guest" }); // a channel author without an email: the name alone
  assert.match(noEmail.text, /\nUser: Ext Guest\. Local time/);
  assert.equal(localTime(new Date(0), "Not/AZone"), "1970-01-01 00:00 (UTC)");
});

test("CHANNELS maps channel names to owners; CODE_CHANNELS must be among them", () => {
  assert.deepEqual(parseChannels("#_tmp_jcm = Pepe@Example.com, sales=bot@example.com", "_tmp_jcm"), {
    _tmp_jcm: { email: "pepe@example.com", code: true },
    sales: { email: "bot@example.com", code: false },
  });
  assert.deepEqual(parseChannels("", ""), {});
  assert.throws(() => parseChannels("sales=bot@example.com", "other"), /CODE_CHANNELS: other is not in CHANNELS/);
  assert.throws(() => parseChannels("sales", ""), /CHANNELS: "sales" is not name=email/);
});

test("unknown daemon token is rejected", async () => {
  const res = await fetch(`${GW}/api/apps.connections.open`, { method: "POST", headers: { authorization: "Bearer nope" } });
  assert.deepEqual(await res.json(), { ok: false, error: "invalid_auth" });
});
