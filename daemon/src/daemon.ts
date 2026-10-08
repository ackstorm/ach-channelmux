// Agent daemon: a Bolt app that connects to the relay as if it were Slack and runs each
// DM thread as an ACP session (e.g. `opencode acp`), in a folder the user picks when the
// thread starts.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import bolt from "@slack/bolt";
import * as acp from "@agentclientprotocol/sdk";
import { createOutput, type Output } from "./output.ts";

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
  const pending = new Map<string, { channel: string; text: string; files?: any[] }>(); // thread ts -> first message, until a folder is picked
  const loaded = new Map<string, Promise<unknown>>(); // sessions open in this agent process
  const replaying = new Set<string>(); // sessions being loaded: their history updates are dropped
  const queues = new Map<string, Promise<void>>(); // one turn at a time per session
  const outputs = new Map<string, Output>(); // session -> its running turn
  const permissions = new Map<string, (optionId: string) => void>(); // request id -> resolver
  const permissionTexts = new Map<string, string>(); // request id -> "what" (kept out of the button value, which Slack caps at 2000 chars)
  const inputs = new Map<string, unknown>(); // toolCallId -> rawInput (OpenCode sends it in updates, not in the permission request)

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
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        if ((update as any).rawInput !== undefined) inputs.set(update.toolCallId, (update as any).rawInput);
      }
      const out = outputs.get(sessionId);
      if (!out || replaying.has(sessionId)) return;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") out.text(update.content.text);
      else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        void out.tool(update.toolCallId, update.title ?? undefined, update.status ?? undefined);
      }
    },
    async requestPermission({ sessionId, toolCall, options }) {
      const t = bySession.get(sessionId);
      if (!t) return { outcome: { outcome: "cancelled" } };
      await outputs.get(sessionId)?.pause();
      const id = randomUUID();
      const input = toolCall.rawInput ?? inputs.get(toolCall.toolCallId);
      const i = (input ?? {}) as Record<string, unknown>;
      const shown = typeof i.command === "string" ? i.command : typeof i.filePath === "string" ? i.filePath : input ? JSON.stringify(input) : "";
      const what = `🔐 The agent wants to run *${toolCall.title ?? toolCall.kind ?? "a tool"}*${shown ? `\n\`\`\`\n${shown.slice(0, 500)}\n\`\`\`` : ""}`;
      permissionTexts.set(id, what);
      const chosen = new Promise<string>((resolve) => permissions.set(id, resolve));
      await say(t, what, [
        { type: "section", text: { type: "mrkdwn", text: what } },
        {
          type: "actions",
          elements: options.slice(0, 5).map((o) => ({
            type: "button",
            action_id: `perm_${o.optionId}`,
            text: { type: "plain_text", text: o.name.slice(0, 75) },
            value: JSON.stringify({ id, optionId: o.optionId, name: o.name }),
            ...(o.kind === "allow_once" && { style: "primary" }),
            ...(o.kind.startsWith("reject") && { style: "danger" }),
          })),
        },
      ]);
      const optionId = await chosen;
      await outputs.get(sessionId)?.resume();
      return { outcome: { outcome: "selected", optionId } };
    },
  };
  const agent = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(Writable.toWeb(proc.stdin!), Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>),
  );
  const ready = agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

  const MAX_FILE = 20 * 1024 * 1024;

  // Slack files, fetched through the relay's file proxy with this daemon's token and saved to a
  // temp folder. The agent only gets their paths: it opens a file when it needs to, so images
  // do not fill its context unasked.
  async function attachments(files: any[] = []): Promise<string[]> {
    const notes: string[] = [];
    for (const f of files) {
      const url = f.url_private_download ?? f.url_private;
      if (!url || f.size > MAX_FILE) {
        notes.push(`[Attachment ${f.name} skipped: too large or unavailable]`);
        continue;
      }
      const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.token}` } });
      if (!res.ok) {
        log("file_fetch_failed", { file: f.id, status: res.status });
        continue;
      }
      const path = join(mkdtempSync(join(tmpdir(), "ach-channelmux-")), basename(f.name));
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      notes.push(`[Attached file saved at ${path}]`);
    }
    return notes;
  }

  // ---------- MCP: the agent's Slack tools ----------
  // A minimal MCP server (Streamable HTTP, JSON responses only) on 127.0.0.1. Each session's URL
  // carries its thread and a per-process secret, so only our agent can post, and only there.

  const MAX_SEND = 50 * 1024 * 1024;
  const secret = randomUUID();
  const mcpHttp = ready.then((r) => Boolean(r.agentCapabilities?.mcpCapabilities?.http));
  let mcpPort = 0;
  const SEND_FILE = {
    name: "send_file",
    description:
      "Send a local file (image, document, archive...) to the user in this Slack thread. " +
      "Your text replies reach the user without it: use it only to deliver files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the session folder" },
        comment: { type: "string", description: "Optional message shown with the file" },
      },
      required: ["path"],
    },
  };

  async function sendFile(t: Thread, args: { path?: string; comment?: string }) {
    const path = resolve(t.cwd, String(args.path ?? ""));
    const { size } = statSync(path);
    if (size > MAX_SEND) throw new Error(`the file is ${size} bytes; the limit is ${MAX_SEND}`);
    const filename = basename(path);
    const up = (await slack.apiCall("files.getUploadURLExternal", { filename, length: size })) as any;
    // Pre-signed URL on Slack's side: no token goes there (ours is the relay token).
    const res = await fetch(up.upload_url, { method: "POST", body: readFileSync(path) });
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
    await slack.apiCall("files.completeUploadExternal", {
      files: JSON.stringify([{ id: up.file_id, title: filename }]),
      channel_id: t.channel,
      thread_ts: t.thread,
      ...(args.comment && { initial_comment: args.comment }),
    });
    return `Sent ${filename} to the user.`;
  }

  const mcp = createServer(async (req, res) => {
    const [, root, key, thread] = (req.url ?? "").split("/");
    const t = threads[thread];
    if (root !== "mcp" || key !== secret || !t) return void res.writeHead(404).end();
    if (req.method !== "POST") return void res.writeHead(405).end(); // no server-initiated stream
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let msg: any;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return void res.writeHead(400).end();
    }
    if (msg.id === undefined) return void res.writeHead(202).end(); // a notification
    const reply = (body: object) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }));
    };
    const p = msg.params ?? {};
    if (msg.method === "initialize") {
      return reply({ result: { protocolVersion: p.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "slack", version: "1" } } });
    }
    if (msg.method === "ping") return reply({ result: {} });
    if (msg.method === "tools/list") return reply({ result: { tools: [SEND_FILE] } });
    if (msg.method === "tools/call" && p.name === "send_file") {
      try {
        return reply({ result: { content: [{ type: "text", text: await sendFile(t, p.arguments ?? {}) }] } });
      } catch (err: any) {
        log("send_file_failed", { error: err?.message ?? String(err) });
        return reply({ result: { content: [{ type: "text", text: `Could not send the file: ${err?.message ?? err}` }], isError: true } });
      }
    }
    reply({ error: { code: -32601, message: `unknown method ${msg.method}` } });
  });

  const tools = async (thread: string): Promise<acp.McpServer[]> =>
    (await mcpHttp) ? [{ type: "http", name: "slack", url: `http://127.0.0.1:${mcpPort}/mcp/${secret}/${thread}`, headers: [] }] : [];

  // Opens a session from an earlier process; the history it replays is not re-posted.
  function open(t: Thread) {
    let p = loaded.get(t.sessionId);
    if (!p) {
      replaying.add(t.sessionId);
      p = tools(t.thread).then((mcpServers) => agent.loadSession({ sessionId: t.sessionId, cwd: t.cwd, mcpServers }));
      p.finally(() => replaying.delete(t.sessionId)).catch(() => loaded.delete(t.sessionId));
      loaded.set(t.sessionId, p);
    }
    return p;
  }

  function prompt(t: Thread, blocks: acp.ContentBlock[], title?: string) {
    if (outputs.has(t.sessionId)) void say(t, "📬 Queued: I'll start on this when the current turn ends.");
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

  async function blocksFor(text: string, files: any[] | undefined): Promise<acp.ContentBlock[]> {
    const notes = await attachments(files);
    return [{ type: "text", text: [text, ...notes].filter(Boolean).join("\n\n") }];
  }

  async function start(channel: string, thread: string, folder: string, text: string, files?: any[]) {
    const cwd = folder === "." ? cfg.baseDir : join(cfg.baseDir, folder);
    let sessionId: string;
    try {
      ({ sessionId } = await agent.newSession({ cwd, mcpServers: await tools(thread) }));
    } catch (err: any) {
      log("session_create_failed", { cwd, error: err?.message ?? String(err) });
      return void (await say({ channel, thread }, `⚠️ Could not start a session in \`${cwd}\`: ${err?.message ?? err}`));
    }
    const t: Thread = { channel, thread, sessionId, cwd };
    threads[thread] = t;
    bySession.set(sessionId, t);
    loaded.set(sessionId, Promise.resolve());
    save();
    await prompt(t, await blocksFor(text, files), `${basename(cwd)}: ${(text || files?.[0]?.name || "").split("\n")[0]}`);
  }

  const stop = (t: Thread) => agent.cancel({ sessionId: t.sessionId });

  // ---------- Slack ----------

  app.message(async ({ message }) => {
    const m = message as any;
    if ((m.subtype && m.subtype !== "file_share") || !(m.text || m.files?.length)) return;
    if (!m.thread_ts) {
      const names = folders();
      if (names.length === 1) return void start(m.channel, m.ts, ".", m.text, m.files);
      pending.set(m.ts, { channel: m.channel, text: m.text, files: m.files });
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
    if (t && m.text?.trim() === "/stop") {
      if (outputs.has(t.sessionId)) await stop(t);
      else await say(t, "Nothing is running.");
      return;
    }
    // Not awaited: the turn can outlive Bolt's handler.
    if (t) return void blocksFor(m.text, m.files).then((blocks) => prompt(t, blocks));
    const where = { channel: m.channel, thread: m.thread_ts };
    if (pending.has(m.thread_ts)) return void (await say(where, "Pick a folder above first."));
    await say(where, "This thread has no agent session. Send a new message to start one.");
  });

  app.event("agent_session_stopped", async ({ event }) => {
    const t = threads[(event as any).thread_ts];
    if (t && outputs.has(t.sessionId)) await stop(t);
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
    void start(first.channel, thread, folder, first.text, first.files);
  });

  app.action(/^perm_/, async ({ ack, body, action }) => {
    await ack();
    const b = body as any;
    const { id, optionId, name } = JSON.parse((action as any).value);
    const resolve = permissions.get(id);
    permissions.delete(id);
    const what = permissionTexts.get(id) ?? "🔐 Permission request";
    permissionTexts.delete(id);
    resolve?.(optionId);
    const text = resolve ? `${what}: ${name}` : `${what}: expired`;
    await slack.chat.update({ channel: b.channel.id, ts: b.message.ts, text, blocks: [] });
  });

  return {
    async start() {
      await ready;
      await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
      mcpPort = (mcp.address() as AddressInfo).port;
      await app.start();
      log("started", { baseDir: cfg.baseDir, threads: bySession.size });
    },
    async stop() {
      stopping = true;
      await app.stop();
      mcp.close();
      proc.kill();
    },
  };
}
