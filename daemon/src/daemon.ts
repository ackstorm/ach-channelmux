// Agent daemon: a Bolt app that connects to the relay as if it were Slack and runs each
// DM thread as an ACP session (e.g. `opencode acp`), in a folder the user picks when the
// thread starts.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import bolt from "@slack/bolt";
import * as acp from "@agentclientprotocol/sdk";

const { App, LogLevel } = bolt;

export interface DaemonConfig {
  /** Relay base URL; its Web API facade is at /api/. */
  relayUrl: string;
  /** Presented as both Slack tokens; the relay resolves it to the owner. */
  token: string;
  /** ACP agent command and arguments, e.g. ["opencode", "acp"]. */
  agentCmd: string[];
  /** The folder picker offers this folder and its direct subfolders. */
  baseDir: string;
  /** Thread -> session map, so threads resume after a restart. */
  stateFile: string;
  /** Called when the agent process exits on its own. */
  onAgentExit?: (code: number | null) => void;
  log?: (msg: string, extra?: unknown) => void;
}

interface Thread {
  channel: string;
  thread: string;
  sessionId: string;
  cwd: string;
}

// Slack caps markdown_text at 12k characters.
const MAX_TEXT = 12_000;

export function createDaemon(cfg: DaemonConfig) {
  const log = cfg.log ?? ((msg, extra) => console.log(JSON.stringify({ msg, ...(extra as object) })));
  const app = new App({
    socketMode: true,
    appToken: cfg.token,
    token: cfg.token,
    clientOptions: { slackApiUrl: `${cfg.relayUrl.replace(/\/$/, "")}/api/` },
    logLevel: LogLevel.ERROR,
  });
  const slack = app.client;

  let threads: Record<string, Thread> = {}; // thread ts -> session
  try {
    threads = JSON.parse(readFileSync(cfg.stateFile, "utf8"));
  } catch {} // first run
  const bySession = new Map(Object.values(threads).map((t) => [t.sessionId, t]));
  const pending = new Map<string, { channel: string; text: string }>(); // thread ts -> first message, until a folder is picked
  const loaded = new Map<string, Promise<unknown>>(); // sessions open in this agent process
  const replaying = new Set<string>(); // sessions being loaded: their history updates are dropped
  const queues = new Map<string, Promise<void>>(); // one turn at a time per session
  const buffers = new Map<string, string>(); // session -> agent text not yet posted
  const permissions = new Map<string, (optionId: string) => void>(); // request id -> resolver

  function save() {
    mkdirSync(dirname(cfg.stateFile), { recursive: true });
    writeFileSync(cfg.stateFile, JSON.stringify(threads));
  }

  function folders() {
    const subs = readdirSync(cfg.baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
    return [".", ...subs].slice(0, 100); // static_select holds 100 options
  }

  const say = (t: { channel: string; thread: string }, text: string, blocks?: unknown[]) =>
    slack.chat.postMessage({ channel: t.channel, thread_ts: t.thread, text, ...(blocks && { blocks: blocks as any }) });

  // Each finished text segment (cut by a tool call or the end of the turn) is its own message;
  // tool calls and thinking stay hidden.
  async function flush(sessionId: string) {
    const text = buffers.get(sessionId)?.trim();
    buffers.delete(sessionId);
    const t = bySession.get(sessionId);
    if (!text || !t) return;
    await slack.chat.postMessage({
      channel: t.channel,
      thread_ts: t.thread,
      markdown_text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 20)}\n\n…(truncated)` : text,
    } as any);
  }

  // ---------- ACP agent ----------

  const proc = spawn(cfg.agentCmd[0], cfg.agentCmd.slice(1), { stdio: ["pipe", "pipe", "inherit"], cwd: cfg.baseDir });
  let stopping = false;
  proc.on("exit", (code) => {
    if (stopping) return;
    log("agent_exited", { code });
    cfg.onAgentExit?.(code);
  });
  const client: acp.Client = {
    async sessionUpdate({ sessionId, update }) {
      if (!bySession.has(sessionId) || replaying.has(sessionId)) return;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        buffers.set(sessionId, (buffers.get(sessionId) ?? "") + update.content.text);
      } else if (update.sessionUpdate === "tool_call") {
        await flush(sessionId);
      }
    },
    async requestPermission({ sessionId, toolCall, options }) {
      const t = bySession.get(sessionId);
      if (!t) return { outcome: { outcome: "cancelled" } };
      await flush(sessionId);
      const id = randomUUID();
      const what = `🔐 The agent wants to run *${toolCall.title ?? toolCall.kind ?? "a tool"}*`;
      const chosen = new Promise<string>((resolve) => permissions.set(id, resolve));
      await say(t, what, [
        { type: "section", text: { type: "mrkdwn", text: what } },
        {
          type: "actions",
          elements: options.slice(0, 5).map((o) => ({
            type: "button",
            action_id: `perm_${o.optionId}`,
            text: { type: "plain_text", text: o.name.slice(0, 75) },
            value: JSON.stringify({ id, optionId: o.optionId, what, name: o.name }),
            ...(o.kind === "allow_once" && { style: "primary" }),
            ...(o.kind.startsWith("reject") && { style: "danger" }),
          })),
        },
      ]);
      return { outcome: { outcome: "selected", optionId: await chosen } };
    },
  };
  const agent = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(Writable.toWeb(proc.stdin!), Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>),
  );
  const ready = agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

  // Opens a session from an earlier process; the history it replays is not re-posted.
  function open(t: Thread) {
    let p = loaded.get(t.sessionId);
    if (!p) {
      replaying.add(t.sessionId);
      p = ready.then(() => agent.loadSession({ sessionId: t.sessionId, cwd: t.cwd, mcpServers: [] }));
      p.finally(() => replaying.delete(t.sessionId)).catch(() => loaded.delete(t.sessionId));
      loaded.set(t.sessionId, p);
    }
    return p;
  }

  function prompt(t: Thread, text: string, ts: string) {
    const turn = (queues.get(t.sessionId) ?? Promise.resolve()).then(async () => {
      // 👀 marks a running turn; the relay turns it into its working notice.
      await slack.reactions.add({ channel: t.channel, timestamp: ts, name: "eyes" }).catch(() => {});
      try {
        await open(t);
        await agent.prompt({ sessionId: t.sessionId, prompt: [{ type: "text", text }] });
        await flush(t.sessionId);
      } catch (err: any) {
        log("prompt_failed", { session: t.sessionId, error: err?.message ?? String(err) });
        await flush(t.sessionId);
        await say(t, `⚠️ ${err?.message ?? err}`);
      } finally {
        await slack.reactions.remove({ channel: t.channel, timestamp: ts, name: "eyes" }).catch(() => {});
      }
    });
    queues.set(t.sessionId, turn);
    return turn;
  }

  async function start(channel: string, thread: string, folder: string, text: string) {
    const cwd = folder === "." ? cfg.baseDir : join(cfg.baseDir, folder);
    let sessionId: string;
    try {
      await ready;
      ({ sessionId } = await agent.newSession({ cwd, mcpServers: [] }));
    } catch (err: any) {
      log("session_create_failed", { cwd, error: err?.message ?? String(err) });
      return void (await say({ channel, thread }, `⚠️ Could not start a session in \`${cwd}\`: ${err?.message ?? err}`));
    }
    const t: Thread = { channel, thread, sessionId, cwd };
    threads[thread] = t;
    bySession.set(sessionId, t);
    loaded.set(sessionId, Promise.resolve());
    save();
    await prompt(t, text, thread);
  }

  // ---------- Slack ----------

  app.message(async ({ message }) => {
    const m = message as any;
    if ((m.subtype && m.subtype !== "file_share") || !m.text) return;
    if (!m.thread_ts) {
      const names = folders();
      if (names.length === 1) return void start(m.channel, m.ts, ".", m.text);
      pending.set(m.ts, { channel: m.channel, text: m.text });
      const options = names.map((n) => ({
        text: { type: "plain_text", text: (n === "." ? `${basename(cfg.baseDir)} (base folder)` : n).slice(0, 75) },
        value: n,
      }));
      await say({ channel: m.channel, thread: m.ts }, "Where should I work?", [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Where should I work?" },
          accessory: { type: "static_select", action_id: "folder", placeholder: { type: "plain_text", text: "Pick a folder" }, options },
        },
      ]);
      return;
    }
    const t = threads[m.thread_ts];
    // Not awaited: the turn can outlive Bolt's handler.
    if (t) return void prompt(t, m.text, m.ts);
    const where = { channel: m.channel, thread: m.thread_ts };
    if (pending.has(m.thread_ts)) return void (await say(where, "Pick a folder above first."));
    await say(where, "This thread has no agent session. Send a new message to start one.");
  });

  app.action("folder", async ({ ack, body, action }) => {
    await ack();
    const b = body as any;
    const thread = b.message?.thread_ts;
    const first = pending.get(thread);
    if (!first) return;
    pending.delete(thread);
    const folder = (action as any).selected_option.value as string;
    const cwd = folder === "." ? cfg.baseDir : join(cfg.baseDir, folder);
    await slack.chat.update({ channel: b.channel.id, ts: b.message.ts, text: `📁 \`${cwd}\``, blocks: [] });
    void start(first.channel, thread, folder, first.text);
  });

  app.action(/^perm_/, async ({ ack, body, action }) => {
    await ack();
    const b = body as any;
    const { id, optionId, what, name } = JSON.parse((action as any).value);
    const resolve = permissions.get(id);
    permissions.delete(id);
    resolve?.(optionId);
    const text = resolve ? `${what}: ${name}` : `${what}: expired`;
    await slack.chat.update({ channel: b.channel.id, ts: b.message.ts, text, blocks: [] });
  });

  return {
    async start() {
      await ready;
      await app.start();
      log("started", { baseDir: cfg.baseDir, threads: bySession.size });
    },
    async stop() {
      stopping = true;
      await app.stop();
      proc.kill();
    },
  };
}
