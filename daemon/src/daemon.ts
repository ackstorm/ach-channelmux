// Agent daemon: a Bolt app that connects to the relay as if it were Slack and runs each
// DM thread as an ACP session (e.g. `opencode acp`). A new thread opens a picker (a Slack modal)
// for the folder, then for a new or existing session in it.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  /** The picker browses this folder and everything below it. */
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
  const pending = new Map<string, { channel: string; text: string; files?: any[] }>(); // thread ts -> first message, until the picker starts a session
  const loaded = new Map<string, Promise<unknown>>(); // sessions open in this agent process
  const replaying = new Set<string>(); // sessions being loaded: their history updates are dropped
  const queues = new Map<string, Promise<void>>(); // one turn at a time per session
  const outputs = new Map<string, Output>(); // session -> its running turn
  const permissions = new Map<string, (optionId: string) => void>(); // request id -> resolver
  const permissionTexts = new Map<string, string>(); // request id -> "what" (kept out of the button value, which Slack caps at 2000 chars)
  const inputs = new Map<string, unknown>(); // toolCallId -> rawInput (OpenCode sends it in updates, not in the permission request)
  const lastReply = new Map<string, string>(); // session -> its last agent reply, seen while its history replays

  function save() {
    mkdirSync(dirname(cfg.stateFile), { recursive: true });
    writeFileSync(cfg.stateFile, JSON.stringify(threads));
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
      if (replaying.has(sessionId)) {
        if (update.sessionUpdate === "user_message_chunk") lastReply.set(sessionId, "");
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          lastReply.set(sessionId, (lastReply.get(sessionId) ?? "") + update.content.text);
        }
        return;
      }
      const out = outputs.get(sessionId);
      if (!out) return;
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
      lastReply.delete(t.sessionId);
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

  // ---------- picker: folder, then a new or existing session (one Slack modal) ----------

  interface Pick {
    channel: string;
    thread: string;
    picker: string; // ts of the "Where should I work?" message
    cwd: string; // relative to baseDir; "" is baseDir
    back?: string; // folder screen that "Other folder" returns to
  }
  const canList = ready.then((r) => Boolean(r.agentCapabilities?.sessionCapabilities?.list));
  const abs = (rel: string) => (rel ? join(cfg.baseDir, rel) : cfg.baseDir);
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory(); // follows symlinks
    } catch {
      return false;
    }
  };
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const inside = (root: string, p: string) => {
    const r = relative(root, p);
    return r.startsWith("..") || isAbsolute(r) ? null : r;
  };
  const ago = (iso?: string | null) => {
    const min = iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000)) : NaN;
    if (Number.isNaN(min)) return "";
    return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
  };

  function subfolders(rel: string) {
    const dir = abs(rel);
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith(".") && d.name !== "node_modules" && isDir(join(dir, d.name)))
      .map((d) => d.name)
      .sort();
  }

  // The agent's sessions under baseDir, newest first. The agent may store a session's real path,
  // so paths are mapped back through baseDir's own real path and its top-level symlinks.
  async function sessions() {
    if (!(await canList)) return [];
    // ponytail: first page only (opencode: the 100 most recent sessions).
    const { sessions: all } = await agent.listSessions({});
    const roots: [string, string][] = [[cfg.baseDir, ""]];
    const realBase = real(cfg.baseDir);
    if (realBase) roots.push([realBase, ""]);
    for (const d of readdirSync(cfg.baseDir, { withFileTypes: true })) {
      const target = d.isSymbolicLink() ? real(join(cfg.baseDir, d.name)) : null;
      if (target) roots.push([target, d.name]);
    }
    const relOf = (cwd: string) => {
      for (const [root, prefix] of roots) {
        const r = inside(root, cwd);
        if (r !== null) return prefix ? join(prefix, r) : r;
      }
      return null;
    };
    return all
      .map((x) => ({ ...x, rel: relOf(x.cwd) }))
      .filter((x): x is typeof x & { rel: string } => x.rel !== null && isDir(abs(x.rel)))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: true });
  const section = (text: string, accessory?: unknown) => ({ type: "section", text: { type: "mrkdwn", text }, ...(accessory ? { accessory } : {}) });
  const button = (text: string, action_id: string, value: string) => ({ type: "button", text: plain(text.slice(0, 75)), action_id, value });
  const nameOf = (rel: string) => basename(abs(rel));
  const parentOf = (rel: string) => (rel.includes("/") ? dirname(rel) : "");
  const modal = (callback_id: string, title: string, submit: string, p: Pick, blocks: unknown[]) => ({
    type: "modal" as const,
    callback_id,
    title: plain(title),
    submit: plain(submit.slice(0, 24)),
    close: plain("Close"),
    private_metadata: JSON.stringify(p),
    blocks: blocks as any[],
  });

  async function folderView(p: Pick) {
    const blocks: unknown[] = [section(`📁 \`${abs(p.cwd)}\``)];
    if (p.cwd) blocks.push({ type: "actions", elements: [button(`⬅️ Back to ${nameOf(parentOf(p.cwd))}`, "picker_up", "up")] });
    else {
      const recent = new Map<string, { n: number; when: string }>();
      for (const x of await sessions()) {
        const r = recent.get(x.rel) ?? { n: 0, when: ago(x.updatedAt) };
        recent.set(x.rel, { ...r, n: r.n + 1 });
      }
      if (recent.size) {
        blocks.push({ type: "header", text: plain("Last used") });
        for (const [rel, r] of [...recent].slice(0, 5)) {
          const info = `${r.n} session${r.n > 1 ? "s" : ""}${r.when ? ` · last used ${r.when}` : ""}`;
          // Slack rejects an empty button value: the base folder ("") goes as ".".
          blocks.push(section(`*${rel || nameOf("")}*\n${info}`, button("Choose", "picker_pick", rel || ".")));
        }
      }
    }
    blocks.push({ type: "header", text: plain(p.cwd ? "Subfolders" : "Folders") });
    const subs = subfolders(p.cwd);
    // ponytail: a modal holds 100 blocks; folders past the first 80 are not offered.
    for (const n of subs.slice(0, 80)) blocks.push(section(`📁 ${n}`, button("Open ›", "picker_open", n)));
    if (!subs.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "No subfolders here." }] });
    return modal("picker_folder", "Choose folder", `Use ${nameOf(p.cwd)}`, p, blocks);
  }

  async function sessionView(p: Pick) {
    const list = (await sessions()).filter((x) => x.rel === p.cwd).slice(0, 9); // radio buttons hold 10 options
    const options = [
      { text: plain("🆕 New session"), value: "new" },
      ...list.map((x) => {
        const info = [ago(x.updatedAt), bySession.has(x.sessionId) && "open in another thread, moves here"].filter(Boolean).join(" · ");
        return { text: plain((x.title || x.sessionId).slice(0, 75)), ...(info && { description: plain(info) }), value: x.sessionId };
      }),
    ];
    return modal("picker_session", "Choose session", "Start", p, [
      section(`📁 \`${abs(p.cwd)}\``),
      { type: "actions", elements: [button("⬅️ Other folder", "picker_other", "other")] },
      { type: "input", block_id: "session", label: plain("Session"), element: { type: "radio_buttons", action_id: "session", options, initial_option: options[0] } },
    ]);
  }

  // Runs the thread's first message in the picked session: a new one, or an existing one moved here.
  async function start(p: Pick, choice: string) {
    const first = pending.get(p.thread);
    if (!first) return;
    pending.delete(p.thread);
    const where = { channel: p.channel, thread: p.thread };
    const cwd = abs(p.cwd);
    let t: Thread;
    let head: string;
    try {
      if (choice === "new") {
        const { sessionId } = await agent.newSession({ cwd, mcpServers: await tools(p.thread) });
        t = { ...where, sessionId, cwd };
        loaded.set(sessionId, Promise.resolve());
        head = `📁 \`${cwd}\` · new session`;
      } else {
        const title = (await sessions()).find((x) => x.sessionId === choice)?.title ?? choice;
        const old = bySession.get(choice);
        if (old) delete threads[old.thread];
        loaded.delete(choice); // reload: its tools are bound to the thread
        t = { ...where, sessionId: choice, cwd };
        threads[p.thread] = t;
        bySession.set(choice, t);
        await open(t);
        const last = (lastReply.get(choice) ?? "").trim();
        const quote = last ? `\n${(last.length > 500 ? `${last.slice(0, 500)}…` : last).replace(/^/gm, "> ")}` : "";
        head = `📁 \`${cwd}\` · continuing *${title}*${quote}`;
      }
    } catch (err: any) {
      log("session_start_failed", { cwd, error: err?.message ?? String(err) });
      return void (await say(where, `⚠️ Could not start a session in \`${cwd}\`: ${err?.message ?? err}`));
    }
    threads[p.thread] = t;
    bySession.set(t.sessionId, t);
    save();
    head += `\nResume it in a terminal: \`opencode -s ${t.sessionId}\``;
    await slack.chat.update({ channel: p.channel, ts: p.picker, text: head, blocks: [] });
    await prompt(t, await blocksFor(first.text, first.files), `${basename(cwd)}: ${(first.text || first.files?.[0]?.name || "").split("\n")[0]}`);
  }

  const stop = (t: Thread) => agent.cancel({ sessionId: t.sessionId });

  // ---------- Slack ----------

  app.message(async ({ message }) => {
    const m = message as any;
    if ((m.subtype && m.subtype !== "file_share") || !(m.text || m.files?.length)) return;
    if (!m.thread_ts) {
      pending.set(m.ts, { channel: m.channel, text: m.text, files: m.files });
      await say({ channel: m.channel, thread: m.ts }, "Where should I work?", [
        section("Where should I work?"),
        { type: "actions", elements: [{ ...button("📂 Choose folder", "picker_open_modal", m.ts), style: "primary" }] },
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
    if (pending.has(m.thread_ts)) return void (await say(where, "Choose a folder above first."));
    await say(where, "This thread has no agent session. Send a new message to start one.");
  });

  app.event("agent_session_stopped", async ({ event }) => {
    const t = threads[(event as any).thread_ts];
    if (t && outputs.has(t.sessionId)) await stop(t);
  });

  // The picker: block actions redraw the modal in place; its submits move to the next screen.
  const pickOf = (body: any): Pick => JSON.parse(body.view.private_metadata);
  const redraw = async (body: any, view: Promise<ReturnType<typeof modal>>) =>
    slack.views.update({ view_id: body.view.id, view: await view });

  app.action("picker_open_modal", async ({ ack, body, action }) => {
    await ack();
    const b = body as any;
    const thread = (action as any).value as string;
    const first = pending.get(thread);
    if (!first) return void (await say({ channel: b.channel.id, thread }, "This picker has expired. Send a new message to start a thread."));
    await slack.views.open({ trigger_id: b.trigger_id, view: await folderView({ channel: first.channel, thread, picker: b.message.ts, cwd: "" }) });
  });
  app.action("picker_open", async ({ ack, body, action }) => {
    await ack();
    const p = pickOf(body);
    const name = (action as any).value as string;
    if (name.includes("/") || name.startsWith(".") || !isDir(join(abs(p.cwd), name))) return;
    await redraw(body, folderView({ ...p, cwd: join(p.cwd, name) }));
  });
  app.action("picker_up", async ({ ack, body }) => {
    await ack();
    const p = pickOf(body);
    await redraw(body, folderView({ ...p, cwd: parentOf(p.cwd) }));
  });
  app.action("picker_pick", async ({ ack, body, action }) => {
    await ack();
    const value = (action as any).value as string;
    const rel = value === "." ? "" : value;
    if (rel.split("/").includes("..") || !isDir(abs(rel))) return;
    await redraw(body, sessionView({ ...pickOf(body), cwd: rel, back: "" }));
  });
  app.action("picker_other", async ({ ack, body }) => {
    await ack();
    const p = pickOf(body);
    await redraw(body, folderView({ ...p, cwd: p.back ?? "" }));
  });
  app.view("picker_folder", async ({ ack, view }) => {
    const p: Pick = JSON.parse(view.private_metadata);
    await ack({ response_action: "update", view: await sessionView({ ...p, back: p.cwd }) });
  });
  app.view("picker_session", async ({ ack, view }) => {
    await ack({ response_action: "clear" });
    const choice = (view.state.values as any).session?.session?.selected_option?.value ?? "new";
    void start(JSON.parse(view.private_metadata), choice);
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
