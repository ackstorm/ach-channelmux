// Agent daemon: a Bolt app that connects to the relay as if it were Slack and runs each
// DM thread as an ACP session (e.g. `opencode acp`). A new message gets a picker in its thread (a Slack modal
// for the folder, then a new or existing session in it); the thread then runs with both set.
// In a channel the relay forwards, a message that mentions the bot does the same; in a
// code channels' origin it opens a Slack code channel instead, which is the session (its key is the channel id).

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import bolt from "@slack/bolt";
import * as acp from "@agentclientprotocol/sdk";
import { DIFF_IN_CARD, changed, createOutput, describePermission, describeTool, editsOf, fullDiff, type Output } from "./output.ts";

const { App, LogLevel } = bolt;

const HELP = [
  "*Commands* (in a thread):",
  "`$model`: model, effort and mode for this session",
  "`$compact`: summarize the conversation to free context",
  "`$clear`: start a new session in this folder",
  "`$fork`: copy this session into a new thread, to try something else",
  "`$stop`: stop the running turn (also Slack's stop button)",
  "`$done`: close this code channel; the session stays, to continue from a new message's Previous session",
  "`! <command>`: run a shell command in the session folder; the agent sees it with your next message",
  "`$help`: this list",
].join("\n");
const BUILTIN = ["stop", "compact", "clear", "fork", "model", "mode", "effort", "settings", "help", "done"];
const SHELL_TIMEOUT_MS = 120_000;
const VOICE_POLLS = 15; // seconds to wait for Slack to transcribe a voice clip
type Where = { channel?: string; ts?: string; thread_ts?: string }; // a Slack message's place
// A user's message waiting for its session's running turn; key: its thread's key in threads.
type Queued = { key: string; channel: string; ts: string; thread_ts?: string; text?: string; files?: any[]; user?: string };
// Slack escapes these three in a message's text; its own markup (<@U1>, <url|label>) uses them unescaped.
const unescape = (s: string) => s.replace(/&(amp|lt|gt);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">" })[e]!);

/** The text of a WebVTT transcript: its cues, without the header, numbers and timings. */
const vttText = (vtt: string) =>
  vtt.split("\n").map((l) => l.trim()).filter((l) => l && l !== "WEBVTT" && !l.includes("-->") && !/^\d+$/.test(l)).join(" ");
const SHELL_SHOWN = 3_000; // output characters shown in Slack (the tail)

const NUDGE =
  "You ended your turn without replying to the user. Reply now with the result of what you just did " +
  "(what you found or changed, and anything they need to decide). Do not run the same tools again.";

// A folder's full path for a label. Too long: the middle gives way to "[...]", keeping the start and the
// folder's own name ("/workspace/local/epepe[...]/ach-project").
export function short(path: string, max = 60) {
  if (path.length <= max) return path;
  const name = basename(path);
  const head = max - name.length - "[...]/".length;
  return head > 0 ? `${path.slice(0, head)}[...]/${name}` : `[...]/${name.slice(-(max - "[...]/".length))}`;
}

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
  /** Speech to text for voice clips Slack did not transcribe: an OpenAI-compatible API (its /audio/transcriptions). */
  stt?: { url: string; model: string; language?: string; prompt?: string; headers: () => Promise<Record<string, string>> };
  /** Text to speech for the agent's send_voice tool: an OpenAI-compatible API (its /audio/speech). */
  tts?: { url: string; model: string; voice: string; prompt?: string; headers: () => Promise<Record<string, string>> };
  /** Called when the agent process exits on its own. */
  onAgentExit?: (code: number | null) => void;
  log?: (msg: string, extra?: unknown) => void;
}

interface Pending {
  channel: string;
  text: string;
  files?: any[];
  user?: string;
  ts?: string;
  picker?: string; // ts of the greeting in the thread, which becomes its header
  top?: boolean; // the session's messages go in the channel itself (a Slack code channel), not in a thread
}

interface Thread {
  channel: string;
  thread: string;
  sessionId: string;
  cwd: string;
  top?: boolean; // see Pending
  opened?: string; // a code channel's: ts of the message that opened it (its key is not a ts)
  base?: string; // a code channel's: the commit its Changes tab diffs against, HEAD when its first turn began
}

// Where a session's messages go: its thread, or the channel itself.
const inThread = (w: { thread: string; top?: boolean }) => (w.top ? undefined : w.thread);
const isDM = (channel: string) => channel.startsWith("D");

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
  let waiting: [string, Pending][] = [];
  let defaults: Record<string, string> = {}; // setting id -> value new sessions start with, chosen on the Home tab
  let knownSettings: acp.SessionConfigOption[] = []; // the agent's settings, as its latest session reported them (for the Home tab after a restart)
  let queuedState: [string, Queued][] = [];
  try {
    const state = JSON.parse(readFileSync(cfg.stateFile, "utf8"));
    ({ threads, pending: waiting = [], defaults = {}, settings: knownSettings = [], queued: queuedState = [] } = state.threads ? state : { threads: state }); // up to 0.2.3 it held only the threads
  } catch {} // first run
  const bySession = new Map(Object.values(threads).map((t) => [t.sessionId, t]));
  const pending = new Map<string, Pending>(waiting); // thread ts -> first message, until the picker starts a session
  const queued = new Map<string, Queued>(queuedState); // message ts -> a message waiting for its session's running turn
  const loaded = new Map<string, Promise<unknown>>(); // sessions open in this agent process
  const replaying = new Set<string>(); // sessions being loaded: their history updates are dropped
  const queues = new Map<string, Promise<void>>(); // one turn at a time per session
  const outputs = new Map<string, Output>(); // session -> its running turn
  const turnOf = new Map<string, number>(); // session -> its running (or last) turn's number
  let turns = 0;
  const retries = new Map<string, { thread: string; content: acp.ContentBlock[] | Promise<acp.ContentBlock[]>; ts?: string }>(); // Retry button -> the failed prompt
  const permissions = new Map<string, { sessionId: string; resolve: (optionId?: string) => void }>(); // request id -> its answer (none: cancelled)
  const permissionTexts = new Map<string, string>(); // request id -> "what" (kept out of the button value, which Slack caps at 2000 chars)
  const inputs = new Map<string, unknown>(); // toolCallId -> rawInput (OpenCode sends it in updates, not in the permission request)
  const history = new Map<string, { who: "You" | "Agent"; text: string; tool?: boolean }[]>(); // session -> its last messages, seen while its history replays
  const configs = new Map<string, acp.SessionConfigOption[]>(); // session -> its settings (model, effort, mode)
  const setConfigs = (sessionId: string, options: acp.SessionConfigOption[]) => {
    configs.set(sessionId, options);
    homeChanged();
  };
  const configWaiters = new Map<string, () => void>(); // session -> resolves on its next config_option_update
  const agentCommands = new Map<string, acp.AvailableCommand[]>(); // session -> the agent's own commands (opencode: init, review, compact)
  const usage = new Map<string, { used: number; size: number; cost?: { amount: number; currency: string } | null }>(); // session -> context use, cost so far
  const turnDiffs = new Map<string, string[]>(); // session -> full diffs of the running turn's edits
  const turnEdits = new Map<string, Map<string, [number, number]>>(); // session -> path -> lines added, removed
  const shellNotes = new Map<string, string[]>(); // session -> "! commands" run since its last turn, told to the agent with the next one

  function save() {
    mkdirSync(dirname(cfg.stateFile), { recursive: true });
    // ponytail: only the 50 newest unanswered pickers survive a restart.
    writeFileSync(cfg.stateFile, JSON.stringify({ threads, pending: [...pending].slice(-50), queued: [...queued], defaults, settings: latestSettings() }));
  }

  const say = (t: { channel: string; thread: string; top?: boolean }, text: string, blocks?: unknown[]) =>
    slack.chat.postMessage({ channel: t.channel, thread_ts: inThread(t), text, ...(blocks && { blocks: blocks as any }) });

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
      if (update.sessionUpdate === "config_option_update") {
        setConfigs(sessionId, update.configOptions);
        configWaiters.get(sessionId)?.();
      }
      if (update.sessionUpdate === "available_commands_update") agentCommands.set(sessionId, update.availableCommands);
      if (update.sessionUpdate === "usage_update") usage.set(sessionId, update);
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        const raw = (update as any).rawInput;
        if (raw && Object.keys(raw).length) inputs.set(update.toolCallId, raw); // opencode starts with {} and fills it later
      }
      // A subagent's reply (opencode streams it on the parent session) is its card's output, not ours.
      if (update.sessionUpdate === "agent_message_chunk" && (update as any)._meta?.["opencode/child-session"]) return;
      if (replaying.has(sessionId)) {
        const h = history.get(sessionId) ?? [];
        const last = h.at(-1);
        // A turn's text before a tool call ("Let me check…") gives way to the text after it: its answer.
        if (update.sessionUpdate === "tool_call" && last?.who === "Agent") last.tool = true;
        const who = update.sessionUpdate === "user_message_chunk" ? "You" : update.sessionUpdate === "agent_message_chunk" ? "Agent" : null;
        if (who && update.content.type === "text") {
          if (last?.who !== who) h.push({ who, text: "" });
          else if (last.tool) Object.assign(last, { text: "", tool: false });
          h.at(-1)!.text += update.content.text;
          history.set(sessionId, h.slice(-6)); // the last 3 exchanges
        }
        return;
      }
      const out = outputs.get(sessionId);
      if (!out) return;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") out.text(update.content.text);
      else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") out.thought(update.content.text);
      else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        const cwd = bySession.get(sessionId)?.cwd ?? "";
        void out.tool(update.toolCallId, describeTool(update, inputs.get(update.toolCallId), cwd));
        const diff = fullDiff(update, cwd, inputs.get(update.toolCallId));
        if (diff) {
          turnDiffs.set(sessionId, [...(turnDiffs.get(sessionId) ?? []), diff]);
          const files = turnEdits.get(sessionId) ?? new Map<string, [number, number]>();
          for (const d of editsOf(update, inputs.get(update.toolCallId))) {
            const [added, removed] = files.get(d.path) ?? [0, 0];
            const c = changed(d.oldText, d.newText);
            files.set(d.path, [added + c.added.length, removed + c.removed.length]);
          }
          turnEdits.set(sessionId, files);
        }
      }
    },
    async requestPermission({ sessionId, toolCall, options }) {
      const t = bySession.get(sessionId);
      if (!t) return { outcome: { outcome: "cancelled" } };
      await outputs.get(sessionId)?.pause();
      const id = randomUUID();
      const what = describePermission(toolCall, toolCall.rawInput ?? inputs.get(toolCall.toolCallId), t.cwd);
      permissionTexts.set(id, what);
      const chosen = new Promise<string | undefined>((resolve) => permissions.set(id, { sessionId, resolve }));
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
      return { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } };
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
  async function attachments(files: any[] = [], m: Where = {}): Promise<string[]> {
    const notes: string[] = [];
    for (const f of files) {
      const said = f.subtype === "slack_audio" ? await voice(f, m) : undefined;
      if (said) {
        notes.push(said);
        continue;
      }
      const url = f.url_private_download ?? f.url_private;
      // Our token is the relay token: it goes to the relay's file proxy and nowhere else.
      if (!url?.startsWith(`${cfg.relayUrl.replace(/\/$/, "")}/`) || f.size > MAX_FILE) {
        notes.push(`[Attachment ${f.name} skipped: too large or unavailable]`);
        continue;
      }
      const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.token}` } });
      if (!res.ok) {
        log("file_fetch_failed", { file: f.id, status: res.status });
        continue;
      }
      const body = Buffer.from(await res.arrayBuffer());
      if (f.subtype === "slack_audio" && cfg.stt) {
        const text = await transcribe(body, f.name).catch((err) => void log("stt_failed", { file: f.id, error: String(err) }));
        if (text) {
          notes.push(`[Voice message, transcribed]\n${text}`);
          continue;
        }
      }
      const path = join(mkdtempSync(join(tmpdir(), "ach-channelmux-")), basename(f.name));
      writeFileSync(path, body);
      notes.push(`[Attached file saved at ${path}]`);
    }
    return notes;
  }

  // A Slack voice clip: Slack's own transcript (its preview, or the whole WebVTT when longer), polled
  // for while Slack is still transcribing. Without one, the stt model transcribes it, or the audio is saved like any other file.
  async function voice(f: any, m: Where): Promise<string | undefined> {
    for (let i = 0; f.transcription?.status === "processing" && m.channel && i < VOICE_POLLS; i++) {
      await sleep(1_000);
      const r: any = await slack.conversations.replies({ channel: m.channel, ts: m.thread_ts ?? m.ts!, oldest: m.ts, inclusive: true }).catch(() => ({}));
      f = r.messages?.find((x: any) => x.ts === m.ts)?.files?.find((x: any) => x.id === f.id) ?? f;
    }
    const t = f.transcription;
    if (t?.status !== "complete") return undefined;
    let text: string = t.preview?.content ?? "";
    if (t.preview?.has_more && f.vtt?.startsWith(`${cfg.relayUrl.replace(/\/$/, "")}/`)) {
      const res = await fetch(f.vtt, { headers: { authorization: `Bearer ${cfg.token}` } });
      if (res.ok) text = vttText(await res.text());
    }
    return text ? `[Voice message, transcribed by Slack]\n${text}` : undefined;
  }

  async function transcribe(audio: Buffer, name: string): Promise<string | undefined> {
    const { url, model, language, prompt, headers } = cfg.stt!;
    const form = new FormData();
    form.append("model", model);
    if (language) form.append("language", language);
    if (prompt) form.append("prompt", prompt);
    form.append("file", new Blob([new Uint8Array(audio)]), name);
    const res = await fetch(`${url.replace(/\/$/, "")}/audio/transcriptions`, { method: "POST", headers: await headers(), body: form, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return ((await res.json()) as any).text?.trim();
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

  const ASK_USER = {
    name: "ask_user",
    description:
      "Ask the user a question in this Slack thread and wait for the answer. Give up to 5 short options " +
      "to show as buttons (they can also type any answer). Use it when you need a decision to go on.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, in Markdown" },
        options: { type: "array", items: { type: "string" }, description: "Up to 5 short answers to choose from" },
      },
      required: ["question"],
    },
  };

  const SEND_VOICE = {
    name: "send_voice",
    description:
      "Speak a short message to the user as an audio clip in this Slack thread. Use it when the user asks for " +
      "audio or talks to you with voice notes; keep it under a minute. Your text replies reach the user without it.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "What to say, as plain spoken text (no Markdown)" } },
      required: ["text"],
    },
  };

  // ask_user: the question waits per thread; a button or the user's next message in the thread answers it.
  const questions = new Map<string, { text: string; ts?: string; resolve: (answer: string) => void }>();
  async function ask(t: Thread, args: { question?: string; options?: unknown }) {
    // One question per thread: a second one (two subagents asking at once) would leave the first unanswered.
    if (questions.has(t.thread)) throw new Error("another question is already waiting for the user's answer; ask again after it");
    const out = outputs.get(t.sessionId);
    await out?.pause();
    const text = `❓ ${String(args.question ?? "").slice(0, 2900)}`;
    const options = (Array.isArray(args.options) ? args.options : []).map((o) => String(o).trim().slice(0, 2000)).filter(Boolean).slice(0, 5);
    const answered = new Promise<string>((resolve) => questions.set(t.thread, { text, resolve }));
    let posted: any;
    try {
      posted = await say(t, text, [
        section(text),
        ...(options.length ? [{ type: "actions", elements: options.map((o, i) => button(o, `ask_${i}`, o)) }] : []),
        { type: "context", elements: [{ type: "mrkdwn", text: options.length ? "Tap an answer or reply in this thread." : "Reply in this thread." }] },
      ]);
    } catch (err) {
      questions.delete(t.thread);
      await out?.resume();
      throw err;
    }
    const q = questions.get(t.thread);
    if (q) q.ts = posted.ts;
    const answer = await answered;
    await out?.resume();
    return answer;
  }
  async function answer(thread: string, text: string) {
    const q = questions.get(thread);
    const t = threads[thread];
    if (!q || !t) return false;
    questions.delete(thread);
    q.resolve(text);
    if (q.ts) await slack.chat.update({ channel: t.channel, ts: q.ts, text: `${q.text}\n→ *${text.slice(0, 500)}*`, blocks: [] }).catch(() => {});
    return true;
  }

  // Uploads to the thread. A snippet_type (e.g. "diff") makes Slack show it as a code snippet.
  async function upload(t: Thread, filename: string, data: Buffer, opts: { comment?: string; snippet?: string } = {}) {
    const up = (await slack.apiCall("files.getUploadURLExternal", { filename, length: data.length, ...(opts.snippet && { snippet_type: opts.snippet }) })) as any;
    // Pre-signed URL on Slack's side: no token goes there (ours is the relay token).
    const res = await fetch(up.upload_url, { method: "POST", body: new Uint8Array(data) });
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
    await slack.apiCall("files.completeUploadExternal", {
      files: JSON.stringify([{ id: up.file_id, title: filename }]),
      channel_id: t.channel,
      thread_ts: inThread(t),
      ...(opts.comment && { initial_comment: opts.comment }),
    });
  }

  async function sendFile(t: Thread, args: { path?: string; comment?: string }) {
    const path = resolve(t.cwd, String(args.path ?? ""));
    const { size } = statSync(path);
    if (size > MAX_SEND) throw new Error(`the file is ${size} bytes; the limit is ${MAX_SEND}`);
    await upload(t, basename(path), readFileSync(path), { comment: args.comment });
    return `Sent ${basename(path)} to the user.`;
  }

  async function sendVoice(t: Thread, args: { text?: string }) {
    const { url, model, voice, prompt, headers } = cfg.tts!;
    const text = String(args.text ?? "").trim();
    if (!text) throw new Error("nothing to say");
    // The style goes before the text: models like Gemini's take it there (they ignore OpenAI's instructions).
    const res = await fetch(`${url.replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      headers: { ...(await headers()), "content-type": "application/json" },
      body: JSON.stringify({ model, voice, input: prompt ? `${prompt}: ${text}` : text }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`speech service: HTTP ${res.status}`);
    // ponytail: wav or mp3 (OpenAI's default) only; map more types if a model sends them.
    const ext = res.headers.get("content-type")?.includes("wav") ? "wav" : "mp3";
    await upload(t, `voice.${ext}`, Buffer.from(await res.arrayBuffer()));
    return "Sent the voice message to the user.";
  }

  const mcp = createServer(async (req, res) => {
    const [, root, key, thread] = new URL(req.url ?? "/", "http://mcp").pathname.split("/");
    // The agent may connect while it creates the session, before the thread is known (opencode 2.0.26 does,
    // and drops a server that refuses it): only a tool call needs the thread, looked up when it comes.
    // opencode also keeps one server per folder, not per session: every session there calls the URL the
    // last one registered. A call belongs to the thread whose turn is running in that folder.
    // ponytail: two turns at once in one folder go to the URL's thread; per-session routing needs the agent's help.
    const named = threads[thread];
    const running = named ? Object.values(threads).filter((x) => x.cwd === named.cwd && outputs.has(x.sessionId)) : [];
    const t = running.length === 1 ? running[0] : named;
    if (root !== "mcp" || key !== secret || !thread) return void res.writeHead(404).end();
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
    if (msg.method === "tools/call" && !t) log("mcp_unknown_thread", { thread, tool: p.name });
    if (msg.method === "initialize") {
      return reply({ result: { protocolVersion: p.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "slack", version: "1" } } });
    }
    if (msg.method === "ping") return reply({ result: {} });
    if (msg.method === "tools/list") {
      const waiting = listed.get(thread);
      for (const cwd of [waiting?.cwd, named?.cwd]) if (cwd) warm.add(cwd);
      waiting?.done();
    }
    if (msg.method === "tools/list") return reply({ result: { tools: [SEND_FILE, ASK_USER, ...(cfg.tts ? [SEND_VOICE] : [])] } });
    if (msg.method === "tools/call" && p.name === "ask_user") {
      try {
        return reply({ result: { content: [{ type: "text", text: await ask(t, p.arguments ?? {}) }] } });
      } catch (err: any) {
        log("ask_user_failed", { error: err?.message ?? String(err) });
        return reply({ result: { content: [{ type: "text", text: `Could not ask: ${err?.message ?? err}` }], isError: true } });
      }
    }
    if (msg.method === "tools/call" && p.name === "send_file") {
      try {
        return reply({ result: { content: [{ type: "text", text: await sendFile(t, p.arguments ?? {}) }] } });
      } catch (err: any) {
        log("send_file_failed", { error: err?.message ?? String(err) });
        return reply({ result: { content: [{ type: "text", text: `Could not send the file: ${err?.message ?? err}` }], isError: true } });
      }
    }
    if (msg.method === "tools/call" && p.name === "send_voice" && cfg.tts) {
      try {
        return reply({ result: { content: [{ type: "text", text: await sendVoice(t, p.arguments ?? {}) }] } });
      } catch (err: any) {
        log("send_voice_failed", { error: err?.message ?? String(err) });
        return reply({ result: { content: [{ type: "text", text: `Could not send the voice message: ${err?.message ?? err}` }], isError: true } });
      }
    }
    reply({ error: { code: -32601, message: `unknown method ${msg.method}` } });
  });

  const tools = async (thread: string): Promise<acp.McpServer[]> =>
    (await mcpHttp) ? [{ type: "http", name: "slack", url: `http://127.0.0.1:${mcpPort}/mcp/${secret}/${thread}`, headers: [] }] : [];

  // opencode connects a folder's MCP servers as the folder warms up, which can be after it has answered
  // session/new or session/load: a turn sent then starts without our tools. The first session in a folder
  // (per run) waits until the agent lists them, at most a few seconds, then until opencode has refreshed
  // its tool catalog with them (it debounces that by 100 ms, then reloads its tools).
  // ponytail: a fixed margin for that refresh; the agent does not say when its catalog is ready.
  const CATALOG_SETTLE_MS = 500;
  const warm = new Set<string>(); // folders where the agent has listed our tools this run
  const listed = new Map<string, { cwd: string; done: () => void }>(); // thread -> waiting for that list
  async function withTools<T>(thread: string, cwd: string, call: (mcpServers: acp.McpServer[]) => Promise<T>): Promise<T> {
    const mcpServers = await tools(thread);
    if (!mcpServers.length || warm.has(cwd)) return call(mcpServers);
    const ready = new Promise<void>((done) => {
      listed.set(thread, { cwd, done: () => setTimeout(done, CATALOG_SETTLE_MS) });
      setTimeout(done, 5_000).unref?.(); // an agent that never lists them only costs the wait
    });
    try {
      return await call(mcpServers);
    } finally {
      await ready;
      listed.delete(thread);
    }
  }

  // Opens a session from an earlier process; the history it replays is not re-posted.
  function open(t: Thread) {
    let p = loaded.get(t.sessionId);
    if (!p) {
      replaying.add(t.sessionId);
      history.delete(t.sessionId);
      p = withTools(t.thread, t.cwd, (mcpServers) => agent.loadSession({ sessionId: t.sessionId, cwd: t.cwd, mcpServers }))
        .then((r) => r?.configOptions && !configs.has(t.sessionId) && setConfigs(t.sessionId, r.configOptions));
      p.finally(() => replaying.delete(t.sessionId)).catch(() => loaded.delete(t.sessionId));
      loaded.set(t.sessionId, p);
    }
    return p;
  }

  // How a turn ended, as a reaction on the message that asked for it.
  const OUTCOME = { done: "white_check_mark", failed: "x", stopped: "black_square_for_stop" } as const;
  // One line under each reply: "📁 `repo` · 🌿 `main` · Model two · 2 files changed +12 −3 · Context 24k / 200k (12%)
  // · Cost $0.012" (the branch only in a git repo, the counts only after edits, context and cost once the agent
  // reports them). A code channel's context bar shows folder, branch and model: there only the rest.
  // ponytail: counts the edits the agent reported; changes made by shell commands are not in it.
  async function footer(t: Thread, edits?: Map<string, [number, number]>) {
    let added = 0;
    let removed = 0;
    for (const [a, r] of edits?.values() ?? []) [added, removed] = [added + a, removed + r];
    const files = edits && `${edits.size} file${edits.size > 1 ? "s" : ""} changed +${added} −${removed}`;
    const where = t.top ? [] : [`📁 \`${basename(t.cwd)}\``, await branchOf(t.cwd).then((b) => b && `🌿 \`${b}\``), modelName(t)];
    return [...where, files, ...usageOf(t)].filter(Boolean).join(" · ");
  }
  // The session's model by its short name (no provider prefix); undefined when the agent has no model setting.
  const modelName = (t: Thread) => {
    const o = (configs.get(t.sessionId) ?? []).find((x) => x.category === "model");
    return o && currentName(o).replace(/^[^/]+\//, "");
  };
  // The folder's git branch; "" outside a git repo.
  const branchOf = (cwd: string) => promisify(execFile)("git", ["-C", cwd, "branch", "--show-current"], { timeout: 5_000 }).then((r) => r.stdout.trim(), () => "");
  // The folder's last commit; undefined outside a git repo or before its first commit.
  const headOf = (cwd: string) => promisify(execFile)("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 5_000 }).then((r) => r.stdout.trim(), () => undefined);

  // A code channel's context bar: its folder, git branch and model. Slack replaces the whole set each time.
  async function contextBar(t: Thread) {
    if (!t.top) return;
    const branch = await branchOf(t.cwd);
    const model = modelName(t);
    const items = [
      { key: "folder", label: short(t.cwd), icon: "folder" },
      ...(branch ? [{ key: "branch", label: branch, icon: "branch" }] : []),
      ...(model ? [{ key: "model", label: model, icon: "terminal" }] : []),
    ];
    await slack.apiCall("agents.conversations.setProperties", { channel_id: t.channel, code_channel: { context_bar_items: items } }).catch((err) => log("context_bar_failed", { error: String(err) }));
  }

  // A code channel's Changes tab, after a turn that edited: the folder's diff since the session's first turn here
  // (the agent may commit as it goes), or since its last commit when the folder had none then.
  // ponytail: the whole working tree, changes made outside the session included; a diff of the session's own
  // edits needs their full record (opencode reports whole files).
  async function changesTab(t: Thread) {
    const branch = await branchOf(t.cwd);
    const diff = branch && (await promisify(execFile)("git", ["-C", t.cwd, "diff", t.base ?? "HEAD"], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout, () => ""));
    if (!diff) return; // not a git repo (or no commit yet), or nothing changed
    await slack.apiCall("agents.conversations.setView", { channel_id: t.channel, view_key: "changes", type: "diff", content: diff.slice(0, 200_000), base_branch: branch, head_branch: branch })
      .catch((err) => log("changes_tab_failed", { error: String(err) }));
  }

  // Blocks may still be on their way (a voice clip's transcript): the turn waits in the queue, keeping order.
  // from: the user's message, kept in STATE_FILE while it waits, so a restart runs it still.
  // command: the agent's own command (e.g. /compact), which may end without a reply.
  function prompt(t: Thread, content: acp.ContentBlock[] | Promise<acp.ContentBlock[]>, opts: { title?: string; ts?: string; from?: Queued; command?: boolean } = {}) {
    const { title, ts, from, command } = opts;
    let notice: Promise<any> | undefined;
    if (outputs.has(t.sessionId)) {
      const text = "📬 Queued: I'll start on this when the current turn ends.";
      // The button stops only the turn running now, not whichever runs when it is tapped.
      notice = say(t, text, [section(text, button("Send now", "queue_now", JSON.stringify({ thread: t.thread, turn: turnOf.get(t.sessionId) })))]);
      if (from) queued.set(from.ts, from), save();
    }
    const turn = (queues.get(t.sessionId) ?? Promise.resolve()).then(async () => {
      if (stopping) return; // a stopped daemon starts no turn: its message stays queued for the next one
      // Its turn has come: the notice loses its button.
      void notice?.then((m) => slack.chat.update({ channel: t.channel, ts: m.ts, text: "📬 Queued, now running.", blocks: [] })).catch(() => {});
      // ponytail: out of the queue once it runs, so a turn cut short by a restart is not run again (it may have
      // made half its edits); the user sends it again.
      if (from && queued.delete(from.ts)) save();
      if (t.top && !t.base) {
        t.base = await headOf(t.cwd);
        if (t.base) save();
      }
      const out = createOutput((m, p) => slack.apiCall(m, p), { channel: t.channel, thread: inThread(t) }, { title, log });
      let outcome: keyof typeof OUTCOME = "failed";
      outputs.set(t.sessionId, out);
      turnOf.set(t.sessionId, ++turns);
      await out.begin();
      try {
        await open(t);
        const ran = shellNotes.get(t.sessionId);
        shellNotes.delete(t.sessionId);
        const context: acp.ContentBlock[] = ran ? [{ type: "text", text: `[Shell commands the user ran in this folder since your last turn]\n${ran.join("\n\n")}` }] : [];
        let r = await agent.prompt({ sessionId: t.sessionId, prompt: [...context, ...(await content)] });
        // Some models end a turn right after their tool calls, with no reply: ask once for one.
        if (r.stopReason === "end_turn" && out.quiet && !command) {
          log("nudged", { session: t.sessionId });
          r = await agent.prompt({ sessionId: t.sessionId, prompt: [{ type: "text", text: NUDGE }] });
          // Still nothing (some models end with an empty reply): say so, or the turn looks finished and answered.
          if (r.stopReason === "end_turn" && out.quiet) out.text("_The agent ended its turn without a reply._");
        }
        if (r.stopReason === "cancelled") out.text("\n\n_Stopped._");
        outcome = r.stopReason === "cancelled" ? "stopped" : "done";
      } catch (err: any) {
        log("prompt_failed", { session: t.sessionId, error: err?.message ?? String(err) });
        out.text(`\n\n⚠️ ${err?.message ?? err}`);
        outcome = "failed";
      } finally {
        const edits = turnEdits.get(t.sessionId);
        turnEdits.delete(t.sessionId);
        const line = await footer(t, edits);
        await out.end(line ? [{ type: "context", elements: [{ type: "mrkdwn", text: line }] }] : undefined);
        // Edits too long for their cards: the whole turn's changes as one diff snippet.
        const diffs = turnDiffs.get(t.sessionId);
        turnDiffs.delete(t.sessionId);
        if (diffs && diffs.join("\n").length > DIFF_IN_CARD) {
          await upload(t, "changes.diff", Buffer.from(diffs.join("\n")), { snippet: "diff" }).catch((err) => log("diff_upload_failed", { error: String(err) }));
        }
        if (t.top && edits) await changesTab(t);
        await contextBar(t); // the turn may have changed the branch
        if (outcome === "failed") {
          // The error is in the reply; a button sends the same message again.
          const id = randomUUID();
          retries.set(id, { thread: t.thread, content, ts });
          await say(t, "The turn failed.", [section("⚠️ The turn failed.", button("Retry", "retry", id))]).catch(() => {});
        }
        outputs.delete(t.sessionId);
        // Last: once it shows, the turn is over ($fork, $clear and $done no longer refuse).
        if (ts) void slack.reactions.add({ channel: t.channel, timestamp: ts, name: OUTCOME[outcome] }).catch(() => {});
      }
    });
    queues.set(t.sessionId, turn);
    return turn;
  }

  // Who wrote a message, for the <slack> envelope: name and time zone, fetched once per user.
  // first: how to greet them. Slack's first name field, else their display name, else the whole name: a full
  // name's first word may be half a first name ("Juan" of "Juan Carlos Moreno").
  type Person = { name?: string; first?: string; tz?: string };
  const people = new Map<string, Promise<Person>>();
  const person = (user?: string): Promise<Person> => {
    if (!user) return Promise.resolve({});
    if (!people.has(user)) {
      const info = slack.users
        .info({ user })
        .then((r: any): Person => {
          const p = r.user?.profile ?? {};
          const name = p.real_name || r.user?.real_name || r.user?.name;
          return { name, first: p.first_name || p.display_name || name, tz: r.user?.tz };
        })
        .catch((): Person => ({}));
      people.set(user, info);
    }
    return people.get(user)!;
  };
  const attr = (s: string) => s.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);
  const when = (ts: string | undefined, tz?: string) => {
    const date = new Date(Number(ts) * 1000 || Date.now());
    try {
      // "2026-10-08 23:55 CEST" (sv-SE gives ISO-like dates; dateStyle cannot be combined with timeZoneName)
      return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(date);
    } catch {
      return date.toISOString();
    }
  };

  // A Slack message for the agent, wrapped so the session shows what came from Slack, from whom
  // and when (the relay preamble explains the envelope). Attachment notes go inside.
  async function blocksFor(m: Where & { text?: string; files?: any[]; user?: string }): Promise<acp.ContentBlock[]> {
    const [notes, who] = await Promise.all([attachments(m.files, m), person(m.user)]);
    const body = [m.text, ...notes].filter(Boolean).join("\n\n").replaceAll("</slack>", "<\\/slack>");
    const from = who.name ? ` from="${attr(who.name)}"` : "";
    return [{ type: "text", text: `<slack${from} at="${when(m.ts, who.tz)}">\n${body}\n</slack>` }];
  }

  // ---------- picker: a greeting in the thread, then a two-step modal: the folder, then the session ----------

  interface Pick {
    channel: string;
    thread: string;
    cwd: string; // relative to baseDir; "" is baseDir
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

  // Folders under baseDir, three levels down, whose path contains the query (any case).
  function search(query: string) {
    const q = query.toLowerCase();
    const found: string[] = [];
    // ponytail: walks the tree on every keystroke; index it if big trees make the search slow.
    const walk = (rel: string, depth: number) => {
      let subs: string[];
      try {
        subs = subfolders(rel);
      } catch {
        return; // unreadable
      }
      for (const n of subs) {
        if (found.length >= 100) return; // Slack shows at most 100 options
        const r = rel ? join(rel, n) : n;
        if (r.toLowerCase().includes(q)) found.push(r);
        if (depth < 3) walk(r, depth + 1);
      }
    };
    walk("", 1);
    return found;
  }

  // Folders the message names, by whole folder name (any case, ignoring - _ .): last used first, then
  // BASE_DIR three levels down. At most 3. A short plain name ("test", "snake") is too often just a word
  // in the sentence: only names of 6+ characters, or with - _ . or a digit, count.
  const nameable = (name: string) => name.length >= 6 || /[-_.\d]/.test(name);
  function named(text: string, list: { rel: string }[]) {
    const norm = (w: string) => w.toLowerCase().replace(/[-_.]/g, "");
    const words = new Set(text.split(/[^\p{L}\p{N}._-]+/u).map(norm).filter((w) => w.length >= 3));
    // ponytail: the walk stops at search's 100 folders; a bigger tree may miss a named folder.
    const rels = [...new Set([...list.map((x) => x.rel), ...search("")])];
    return rels.filter((r) => r && nameable(basename(r)) && words.has(norm(basename(r)))).slice(0, 3);
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
      // opencode names a session it has not titled yet "New session - <ISO time>": shown as untitled.
      .map((x) => ({ ...x, title: /^New session - \d{4}-\d\d-\d\dT[\d:.]+Z$/.test(x.title ?? "") ? null : x.title, rel: relOf(x.cwd) }))
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

  // Step 1, the folder. At the base: suggested and recent folders, a search, then browsing; inside a folder it only
  // browses. "Use <folder>" takes the searched or ticked one, else the one browsed.
  async function folderView(p: Pick, error?: string, ticked?: string, naming = false) {
    const blocks: unknown[] = [];
    let on: string | undefined; // the ticked folder
    // At the base: the folders the message names (🪄), then recent ones, one list with the first ticked: 5, a line
    // each, so browsing shows below without scrolling. Older ones are a search away.
    if (!p.cwd) {
      const first = pending.get(p.thread);
      const at = first?.text.indexOf("\n\n[Context from the Slack relay") ?? -1;
      const list = await sessions();
      const found = first ? named(at >= 0 ? first.text.slice(0, at) : first.text, list) : [];
      // Slack rejects an empty option value: the base folder ("") goes as ".".
      const options = [...new Set([...found, ...list.map((x) => x.rel)])].slice(0, 5).map((r) => ({ text: plain(`${short(abs(r))}${found.includes(r) ? "  🪄" : ""}`), value: r || "." }));
      // A tick redraws the modal (dispatch_action), so the submit button names the folder it takes.
      const tick = options.find((o) => o.value === ticked) ?? options[0];
      on = tick?.value;
      if (options.length) blocks.push({ type: "input", block_id: "recent", optional: true, dispatch_action: true, label: plain("Suggested and recent"), ...(found.length && { hint: plain("🪄 Suggested from your message") }), element: { type: "radio_buttons", action_id: "picker_recent", options, initial_option: tick } });
    }
    // No emoji in the placeholder: Slack's mobile app shows it as its :name:.
    if (!p.cwd) blocks.push({ type: "input", block_id: "search", optional: true, label: plain("Or search all folders"), element: { type: "external_select", action_id: "picker_search", placeholder: plain("Type a name…"), min_query_length: 1 } });
    // The folder browsed, Back beside it inside one; then its subfolders and New folder as one run of buttons.
    blocks.push(section(`📁 \`${abs(p.cwd)}\``, p.cwd ? button(`⬅️ ${nameOf(parentOf(p.cwd))}`, "picker_up", "up") : undefined));
    const subs = subfolders(p.cwd);
    // Rows of 25 (Slack's limit per block), each action_id unique in its block. ponytail: the first 99 subfolders only.
    const buttons = [...subs.slice(0, 99).map((n, j) => button(`📁 ${n} ›`, `picker_open_${j}`, n)), ...(naming ? [] : [button("➕ New folder", "picker_naming", "new")])];
    for (let i = 0; i < buttons.length; i += 25) blocks.push({ type: "actions", elements: buttons.slice(i, i + 25) });
    // Enter creates the folder and opens it. The block id follows the folder, so a new one starts empty.
    if (naming)
      blocks.push({
        type: "input",
        block_id: `mkdir:${p.cwd}`.slice(0, 255),
        optional: true,
        dispatch_action: true,
        label: plain(`➕ New folder in ${nameOf(p.cwd)}`),
        element: { type: "plain_text_input", action_id: "picker_mkdir", focus_on_load: true, placeholder: plain("Name, then Enter"), dispatch_action_config: { trigger_actions_on: ["on_enter_pressed"] } },
      });
    if (error) blocks.push({ type: "context", elements: [{ type: "plain_text", text: `⚠️ ${error}` }] });
    // Slack's submit label holds 24 characters. At the base a ticked suggestion wins over the base folder itself.
    const use = `Use ${nameOf(on === undefined ? p.cwd : on === "." ? "" : on)}`;
    return modal("picker_folder", "Choose folder", use.length > 24 ? `${use.slice(0, 23)}…` : use, p, blocks);
  }

  // The folder's sessions a picker offers. In a channel only those whose thread is there: the owner's DM
  // sessions stay private.
  const previous = async (p: Pick) =>
    (await sessions()).filter((x) => x.rel === p.cwd && (isDM(p.channel) || bySession.get(x.sessionId)?.channel === p.channel));

  // Step 2, on top of step 1 (Slack's back arrow returns there): a new session, or one of the folder's last 10.
  async function sessionView(p: Pick) {
    const list = (await previous(p)).slice(0, 10);
    const options = [
      { text: plain("🆕 New session"), value: "new" },
      ...list.map((x) => {
        const info = [ago(x.updatedAt), bySession.has(x.sessionId) && "open in another thread, moves here"].filter(Boolean).join(" · ");
        return { text: plain((x.title || "Untitled").slice(0, 75)), ...(info && { description: plain(info) }), value: x.sessionId };
      }),
    ];
    return modal("picker_session", "Choose session", "Start", p, [
      section(`📁 \`${abs(p.cwd)}\``),
      list.length
        ? { type: "input", block_id: "session", label: plain("Session"), element: { type: "static_select", action_id: "session", options, initial_option: options[0] } }
        : section("_No sessions here yet: a new one starts._"),
    ]);
  }

  // A thread's header: its folder, its session (title and id, to resume it elsewhere), its previous thread.
  const header = (cwd: string, title: string, id: string, before?: string) =>
    `📁 \`${cwd}\`\n💬 ${title} · \`${id}\`${before ? `\n↩️ <${before}|previous thread>` : ""}`;

  // Runs the thread's first message in the picked session: a new one, or an existing one moved here.
  async function start(p: Pick, choice: string) {
    const first = pending.get(p.thread);
    if (!first) return;
    pending.delete(p.thread);
    save();
    const where = { channel: p.channel, thread: p.thread, top: first.top, ...(first.top && { opened: first.ts }) };
    const cwd = abs(p.cwd);
    let t: Thread;
    let head: string;
    let recap = "";
    try {
      if (choice === "new") {
        const { sessionId, configOptions } = await withTools(p.thread, cwd, (mcpServers) => agent.newSession({ cwd, mcpServers }));
        await applyDefaults(sessionId, configOptions);
        t = { ...where, sessionId, cwd };
        loaded.set(sessionId, Promise.resolve());
        head = header(cwd, "New session", sessionId);
      } else {
        const title = (await sessions()).find((x) => x.sessionId === choice)?.title || "Untitled";
        const old = bySession.get(choice);
        const before = old && (await slack.chat.getPermalink({ channel: old.channel, message_ts: old.thread }).then((r) => r.permalink, () => undefined));
        if (old) delete threads[old.thread];
        loaded.delete(choice); // reload: its tools are bound to the thread
        t = { ...where, sessionId: choice, cwd };
        threads[p.thread] = t;
        bySession.set(choice, t);
        await open(t);
        // The last exchanges, one paragraph each, out of the envelopes and context blocks we added.
        const lines = (history.get(choice) ?? []).flatMap(({ who, text }) => {
          // Code reads badly on one line: a block shows as [code].
          let s = text.replace(/<\/?slack[^>]*>/g, "").replace(/```[\s\S]*?(```|$)/g, " [code] ").replace(/\[Context from the Slack relay[\s\S]*?\[End of relay context\]/g, "").replace(/\s+/g, " ").trim();
          if (!s) return [];
          if (s.length > 300) s = `${s.slice(0, 300)}…`;
          for (const mark of ["**", "`"]) if (s.split(mark).length % 2 === 0) s += mark; // a cut never leaves one open
          return [`> **${who}:** ${s}`];
        });
        if (lines.length) recap = `**📜 Session recap**\n\n${lines.join("\n>\n")}`;
        head = header(cwd, `*${title}*`, choice, before);
      }
    } catch (err: any) {
      log("session_start_failed", { cwd, error: err?.message ?? String(err) });
      // In place of the greeting's "Starting…", or posted if it is gone.
      const text = `⚠️ Could not start a session in \`${cwd}\`: ${err?.message ?? err}`;
      const shown = first.picker && (await slack.chat.update({ channel: p.channel, ts: first.picker, text, blocks: [] }).then(() => true, () => false));
      return void (shown || (await say(where, text)));
    }
    threads[p.thread] = t;
    bySession.set(t.sessionId, t);
    save();
    await contextBar(t);
    // The greeting becomes the header; a new one is posted if it is gone.
    const headed = first.picker && (await slack.chat.update({ channel: p.channel, ts: first.picker, text: head, blocks: [] }).then(() => true, () => false));
    if (!headed) await slack.chat.postMessage({ channel: p.channel, thread_ts: inThread(where), text: head, unfurl_links: false });
    if (recap) await slack.chat.postMessage({ channel: p.channel, thread_ts: inThread(where), markdown_text: recap } as any); // Slack refuses text with markdown_text
    // No reaction on a code channel's first message: it is in the channel it was opened from.
    await prompt(t, await blocksFor(first), { title: `${basename(cwd)} - ${(first.text || first.files?.[0]?.name || "").split("\n")[0].replaceAll(/[:·]/g, "")}`, ts: first.top ? undefined : first.ts }); // Slack shows ":" and "·" as "_" in titles
  }

  const stop = async (t: Thread) => {
    await answer(t.thread, "(The user stopped the turn without answering.)");
    // ACP: a cancelled turn's pending permission requests are answered "cancelled".
    for (const [id, p] of permissions) {
      if (p.sessionId !== t.sessionId) continue;
      permissions.delete(id);
      p.resolve();
    }
    await agent.cancel({ sessionId: t.sessionId });
  };

  // ---------- commands: $model, $compact, $clear, $stop, $help, ! shell ----------

  async function command(t: Thread, text: string) {
    const s = text.trim();
    if (s.startsWith("!")) {
      void shell(t, s.slice(1).trim());
      return true;
    }
    const m = /^\$([a-z][\w-]*)(?:\s+([\s\S]+))?$/i.exec(s);
    const name = s === "/stop" ? "stop" : m?.[1].toLowerCase();
    if (!name) return false;
    const args = m?.[2]?.trim();
    if (!BUILTIN.includes(name) || args) {
      // The agent's own commands ($review branch -> "/review branch"); known once its session is loaded.
      await loadedWithSettings(t);
      const own = agentCommands.get(t.sessionId)?.find((c) => c.name.toLowerCase() === name);
      if (own) {
        void prompt(t, [{ type: "text", text: `/${own.name}${args ? ` ${args}` : ""}` }], { command: true });
        return true;
      }
      if (args) return false; // "$HOME is unset": a message, not a command
    }
    if (name === "stop") await (outputs.has(t.sessionId) ? stop(t) : say(t, "Nothing is running."));
    else if (name === "compact") void prompt(t, [{ type: "text", text: "/compact" }], { command: true }); // the agent's own command
    else if (name === "clear") await clear(t);
    else if (name === "fork") await fork(t);
    else if (name === "done") await closeChannel(t);
    else if (["model", "mode", "effort", "settings"].includes(name)) await settings(t);
    else await loadedWithSettings(t).then(() => say(t, `${name === "help" ? "" : `Unknown command \`$${name}\`.\n`}${HELP}${agentHelp(t)}`));
    return true;
  }

  // $model: each setting with its own menu (picking a value changes it at once), then context and cost.
  // The agent's mode (opencode: build/plan) is left out: it is not a setting users change from Slack.
  const selects = (t: Thread) => (configs.get(t.sessionId) ?? []).filter((o) => o.type === "select" && o.category !== "mode") as any[];
  const choicesOf = (o: any) => (o.options as any[]).flatMap((x) => x.options ?? [x]) as { value: string; name: string; description?: string }[];
  const currentName = (o: any) => choicesOf(o).find((c) => c.value === o.currentValue)?.name ?? String(o.currentValue);
  const tokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const usageOf = (t: Thread) => {
    const u = usage.get(t.sessionId);
    const context = u?.size ? [`*Context* ${tokens(u.used)} / ${tokens(u.size)} (${u.used && u.used < u.size / 100 ? "<1" : Math.round((100 * u.used) / u.size)}%)`] : [];
    if (u?.cost) context.push(`*Cost* ${u.cost.currency === "USD" ? "$" : `${u.cost.currency} `}${u.cost.amount.toFixed(u.cost.amount < 1 ? 3 : 2)}`);
    return context;
  };
  // The message's text: what a notification or a client without blocks shows.
  const summary = (t: Thread) => `⚙️ ${[...selects(t).map((o) => `*${o.name}* \`${currentName(o).replace(/^[^/]+\//, "")}\``), ...usageOf(t)].join("   ·   ")}`;
  const panel = (t: Thread) => [
    ...selects(t).map((o) => section(`*${o.name}*`, { ...settingMenu(o), action_id: `cfg:${o.id}` })),
    ...(usageOf(t).length ? [{ type: "context", elements: [{ type: "mrkdwn", text: usageOf(t).join("   ·   ") }] }] : []),
  ];

  const agentHelp = (t: Thread) => {
    const own = (agentCommands.get(t.sessionId) ?? []).filter((c) => !BUILTIN.includes(c.name.toLowerCase()));
    return own.length ? `\n\n*The agent's commands:*\n${own.map((c) => `\`$${c.name}\`: ${c.description}`).join("\n")}` : "";
  };

  // Loads a thread's session if needed. A session loaded just now: opencode answers with a provisional
  // settings list and sends the full one (its providers' models) a moment later, as a config_option_update.
  async function loadedWithSettings(t: Thread) {
    if (!loaded.has(t.sessionId)) {
      const update = new Promise<void>((r) => {
        configWaiters.set(t.sessionId, r);
        setTimeout(r, 2_000);
      });
      await open(t);
      await update;
      configWaiters.delete(t.sessionId);
    }
  }

  async function settings(t: Thread) {
    await loadedWithSettings(t);
    if (!selects(t).length) return void (await say(t, "This agent has no settings to change."));
    await say(t, summary(t), panel(t));
  }

  // A setting as a menu: provider-prefixed values ("ackstorm/claude-fable-5") are grouped by provider.
  function settingMenu(o: any) {
    const choices = choicesOf(o).slice(0, 100);
    const option = (c: { value: string; name: string }) => ({ text: plain(c.name.replace(/^[^/]+\//, "").slice(0, 75)), value: String(c.value) });
    const providers = [...new Set(choices.map((c) => (c.name.includes("/") ? c.name.split("/")[0] : "")))];
    const grouped = providers.length > 1 && providers.every(Boolean);
    const current = choices.find((c) => c.value === o.currentValue);
    return {
      type: "static_select",
      action_id: "value",
      ...(grouped
        ? { option_groups: providers.map((g) => ({ label: plain(g.slice(0, 75)), options: choices.filter((c) => c.name.startsWith(`${g}/`)).map(option) })) }
        : { options: choices.map(option) }),
      ...(current && { initial_option: option(current) }),
    };
  }

  // A new session starts with the Home tab's defaults (e.g. the model), where the agent offers them. The model goes
  // first: opencode sets the effort back to its default when the model changes.
  async function applyDefaults(sessionId: string, options?: acp.SessionConfigOption[] | null) {
    let current = options;
    for (const [configId, value] of Object.entries(defaults).sort(([a], [b]) => Number(b === "model") - Number(a === "model"))) {
      const o: any = current?.find((x) => x.id === configId);
      if (!o || o.currentValue === value || !choicesOf(o).some((c) => c.value === value)) continue;
      const r = await agent.setSessionConfigOption({ sessionId, configId, value }).catch((err) => void log("default_failed", { configId, error: String(err) }));
      if (r) current = r.configOptions;
    }
    if (current) setConfigs(sessionId, current);
  }

  // ---------- Home tab: status, defaults for new sessions, recent threads ----------

  // The settings the agent offers, as its latest session reported them; saved, so a restart still knows them.
  const latestSettings = () => [...configs.values()].at(-1) ?? knownSettings;

  async function homeView() {
    const options = latestSettings().filter((o) => o.type === "select" && o.category !== "mode") as any[];
    const titles = new Map((await sessions().catch(() => [])).map((x) => [x.sessionId, x.title]));
    const since = (t: Thread) => Number(t.opened ?? t.thread) || 0;
    const recent = Object.values(threads).sort((a, b) => since(b) - since(a)).slice(0, 5);
    const rows = await Promise.all(recent.map(async (t) => {
      const link = t.top ? undefined : await slack.chat.getPermalink({ channel: t.channel, message_ts: t.thread }).then((r) => r.permalink, () => undefined);
      const title = (titles.get(t.sessionId) || "Untitled").replace(/[<>|]/g, " "); // they would break the link
      const when = since(t) ? ago(new Date(since(t) * 1000).toISOString()) : "";
      // A code channel links as itself: Slack shows its name, which is the message that opened it.
      return `📁 *${basename(t.cwd)}* · ${t.top ? `<#${t.channel}>` : link ? `<${link}|${title}>` : title}${when ? ` · ${when}` : ""}`;
    }));
    const note = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
    const header = (text: string) => ({ type: "header", text: plain(text) });
    // A default shows by its short name (no provider prefix), the menu only changes it.
    const chosen = (o: any) => {
      const c = choicesOf(o).find((x) => x.value === defaults[o.id]);
      return c ? `\`${c.name.replace(/^[^/]+\//, "")}\`` : "agent default";
    };
    return {
      type: "home" as const,
      blocks: [
        header("Your agent"),
        section(`🟢 Online · ${basename(cfg.agentCmd[0])} · ${cfg.baseDir}`),
        note(`on ${hostname()}`),
        header("Defaults for new sessions"),
        ...(options.length
          ? options.map((o) => section(`*${o.name}*   ${chosen(o)}`, { ...settingMenu(o), action_id: `home_default:${o.id}`, initial_option: undefined, placeholder: plain("Change…") }))
          : [note("Start a thread first: the agent's settings show up here.")]),
        header("Recent threads"),
        section(rows.join("\n") || "None yet."),
        { type: "divider" },
        note("Message me to start · each thread is one agent session · `$help` in a thread lists its commands"),
      ] as any[],
    };
  }
  // The menus the Home tab shows: a change redraws it for whoever opened it, as Slack keeps showing its last copy.
  const homeMenus = () => JSON.stringify(latestSettings().filter((o) => o.type === "select").map((o) => [o.id, choicesOf(o).map((c) => c.value)]));
  let homeUser: string | undefined;
  let homeShown = "";
  const publishHome = async (user: string) => {
    homeUser = user;
    homeShown = homeMenus();
    await slack.views.publish({ user_id: user, view: await homeView() }).catch((err) => log("home_failed", { error: String(err) }));
  };
  function homeChanged() {
    if (homeUser && homeMenus() !== homeShown) void publishHome(homeUser);
  }
  app.event("app_home_opened", async ({ event }) => {
    if ((event as any).tab === "home") await publishHome((event as any).user);
  });
  app.action(/^home_default:/, async ({ ack, body, action }) => {
    await ack();
    const a = action as any;
    defaults[a.action_id.slice("home_default:".length)] = a.selected_option.value;
    save();
    await publishHome((body as any).user.id);
  });

  async function clear(t: Thread) {
    if (outputs.has(t.sessionId)) return void (await say(t, "A turn is running: `$stop` it first."));
    const { sessionId, configOptions } = await withTools(t.thread, t.cwd, (mcpServers) => agent.newSession({ cwd: t.cwd, mcpServers }));
    await applyDefaults(sessionId, configOptions);
    bySession.delete(t.sessionId);
    const fresh = { ...t, sessionId };
    threads[t.thread] = fresh;
    bySession.set(sessionId, fresh);
    loaded.set(sessionId, Promise.resolve());
    save();
    await say(t, `🧹 ${header(t.cwd, "New session", sessionId)}`);
    await contextBar(fresh); // its model may differ
  }

  // $fork: a copy of the session in a new thread (its root is our message), to try something else.
  async function fork(t: Thread) {
    if (outputs.has(t.sessionId)) return void (await say(t, "A turn is running: `$stop` it first."));
    await open(t);
    const title = (await sessions()).find((x) => x.sessionId === t.sessionId)?.title;
    const root: any = await slack.chat.postMessage({ channel: t.channel, text: `🍴 Fork of ${title ? `*${title}*` : "a session"} in \`${t.cwd}\`. Reply in this thread to continue it.` });
    try {
      const { sessionId, configOptions } = await withTools(root.ts, t.cwd, (mcpServers) => agent.unstable_forkSession({ sessionId: t.sessionId, cwd: t.cwd, mcpServers }));
      if (configOptions) setConfigs(sessionId, configOptions);
      const copy = { channel: t.channel, thread: root.ts, sessionId, cwd: t.cwd };
      threads[root.ts] = copy;
      bySession.set(sessionId, copy);
      loaded.set(sessionId, Promise.resolve());
      save();
      const link = await slack.chat.getPermalink({ channel: t.channel, message_ts: root.ts }).then((r) => r.permalink, () => undefined);
      await say(t, `🍴 Forked: ${link ? `<${link}|the copy>` : "the copy"} is a new thread in the main view.`);
    } catch (err: any) {
      await slack.chat.update({ channel: t.channel, ts: root.ts, text: `Could not fork the session: ${err?.message ?? err}` });
    }
  }

  // $done: a summary in the code channel, then the channel archived with it. The session stays, for a picker's Previous session.
  async function closeChannel(t: Thread) {
    if (!t.top) return void (await say(t, "`$done` closes a code channel; this is not one."));
    if (outputs.has(t.sessionId)) return void (await say(t, "A turn is running: `$stop` it first."));
    const summary: any = await say(t, `✅ Session closed · \`${t.sessionId}\` — continue it from any new message's Previous session.`);
    try {
      await slack.apiCall("agents.conversations.archive", { channel_id: t.channel, summary_message_ts: summary.ts });
    } catch (err: any) {
      // The channel stays the session: the summary says why it did not close.
      const text = `⚠️ Could not close the code channel: ${err?.data?.error ?? err?.message ?? err}`;
      return void (await slack.chat.update({ channel: t.channel, ts: summary.ts, text }).catch(() => {}));
    }
    delete threads[t.thread];
    bySession.delete(t.sessionId);
    save();
  }

  async function shell(t: Thread, cmd: string) {
    if (!cmd) return void (await say(t, "Usage: `! <command>`, e.g. `! git status`"));
    const { out, code } = await new Promise<{ out: string; code: number | null }>((done) => {
      let out = "";
      const p = spawn("bash", ["-lc", cmd], { cwd: t.cwd, timeout: SHELL_TIMEOUT_MS });
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("error", (err) => done({ out: String(err), code: null }));
      p.on("close", (code) => done({ out, code }));
    });
    const tail = out.length > SHELL_SHOWN ? `…\n${out.slice(-SHELL_SHOWN)}` : out;
    const status = code === 0 ? "" : `\n${code === null ? "timed out or failed to start" : `exit ${code}`}`;
    const fenced = `\`\`\`\n$ ${cmd}\n${tail.replaceAll("\`\`\`", "ˋˋˋ")}\n\`\`\`${status}`;
    await slack.chat.postMessage({ channel: t.channel, thread_ts: inThread(t), markdown_text: fenced } as any);
    shellNotes.set(t.sessionId, [...(shellNotes.get(t.sessionId) ?? []), fenced]);
  }

  // ---------- Slack ----------

  app.message(async ({ message, context }) => {
    const m = message as any;
    // A code channel is one session: its messages, top-level or in a thread inside it, are that session's.
    const code = threads[m.channel] || pending.has(m.channel) ? m.channel : undefined;
    if (m.subtype === "message_changed") {
      // Edits never reach the agent: only their author sees this, in the message's thread. Only for a session's
      // or a picker's messages: in a channel the others were never for the agent.
      const e = m.message;
      if (!code && !threads[e.thread_ts ?? e.ts] && !pending.has(e.thread_ts ?? e.ts)) return;
      return void (await slack.chat.postEphemeral({ channel: m.channel, user: e.user, thread_ts: e.thread_ts ?? e.ts, text: "✏️ Edits don't reach the agent. Send a new message instead." }).catch(() => {}));
    }
    if ((m.subtype && m.subtype !== "file_share") || !(m.text || m.files?.length)) return;
    // The session: a thread's own (in a code channel, a $fork's), else the code channel's. None: a new message.
    const key: string | undefined = m.thread_ts && (threads[m.thread_ts] || !code) ? m.thread_ts : code;
    // In a channel a new message is for the agent only when it mentions the bot, which is not part of what it says.
    const mention = `<@${context.botUserId}>`;
    if (!key && !isDM(m.channel)) {
      if (!m.text?.includes(mention)) return;
      m.text = m.text.replaceAll(mention, "").trim();
    }
    if (m.text) m.text = unescape(m.text);
    if (!key && /^\s*\$[a-z][\w-]*\s*(\n|$)/i.test(m.text ?? "")) {
      // A command outside a thread: there is no session to run it on.
      const help = /^\s*\$help\s*(\n|$)/i.test(m.text) ? HELP : `Commands work inside a thread with a session.\n${HELP}`;
      return void (await say({ channel: m.channel, thread: m.ts }, help));
    }
    if (!key) {
      const first = { channel: m.channel, text: m.text, files: m.files, user: m.user, ts: m.ts };
      return void (await (m.code_channel_origin ? openCodeChannel(first) : offerPicker(first)));
    }
    const t = threads[key];
    if (t && m.text && (await command(t, m.text))) return;
    if (questions.has(key)) {
      // The reply to an ask_user question, including a voice clip's transcript or a file's path.
      const notes = await attachments(m.files, m);
      if (await answer(key, [m.text, ...notes].filter(Boolean).join("\n\n"))) return;
    }
    // Not awaited: the turn can outlive Bolt's handler.
    if (t) {
      const from = { key, channel: m.channel, ts: m.ts, thread_ts: m.thread_ts, text: m.text, files: m.files, user: m.user };
      return void prompt(t, blocksFor(from), { ts: m.ts, from });
    }
    const where = { channel: m.channel, thread: m.thread_ts ?? m.ts };
    const held = pending.get(key);
    if (held) return void (await say(where, "Choose a folder and a session above first."));
    if (!isDM(m.channel)) return; // a channel's other threads are not the agent's: no reply there
    await say(where, "This thread has no agent session. Send a new message to start one.");
  });

  // A new message waits for the picker: a greeting in its thread (in a code channel, top-level) whose button opens
  // the modal. Its first reply notifies; the main view keeps only the message.
  async function offerPicker(p: Pending & { ts: string }, key = p.ts) {
    pending.set(key, p);
    save();
    // A greeting by first name, then what to do: this message is not the agent, it only opens one.
    const name = (await person(p.user)).first;
    const hi = `👋 Hi${name ? ` ${name}` : ""}! Pick the folder to work in, then the session.`;
    const r: any = await slack.chat.postMessage({ channel: p.channel, thread_ts: p.top ? undefined : p.ts, text: hi, blocks: [
      section(`${hi}\nYour message goes to the agent once it starts.`),
      { type: "actions", elements: [{ ...button("📂 Choose folder", "picker_open_modal", key), style: "primary" }] },
    ] as any });
    p.picker = r.ts;
    save();
    return r;
  }

  // A mention in a code channels' origin opens a Slack code channel (its author is invited), which is the session:
  // the picker goes there. If Slack refuses, the session runs in the message's thread, as in any channel.
  async function openCodeChannel(first: Pending & { ts: string }) {
    const where = { channel: first.channel, thread: first.ts };
    let id: string | undefined;
    try {
      // Named after the message without the mention (and the relay's context block): Slack's own name keeps "@bot".
      const at = first.text.indexOf("\n\n[Context from the Slack relay");
      const name = (at >= 0 ? first.text.slice(0, at) : first.text).split("\n")[0].trim().slice(0, 80);
      const r: any = await slack.apiCall("agents.conversations.create", { origin_channel_id: first.channel, origin_message_ts: first.ts, session_id: first.ts, is_private: true, ...(name && { name }) });
      id = r.channel_id;
    } catch (err: any) {
      log("code_channel_failed", { error: err?.data?.error ?? String(err) });
      await say(where, `⚠️ Could not open a code channel (${err?.data?.error ?? err?.message ?? err}): working in this thread instead.`);
    }
    if (!id) return offerPicker(first);
    await say(where, `🧑‍💻 Working in <#${id}>`);
    return offerPicker({ ...first, channel: id, top: true }, id);
  }

  // "Send to agent" on any message: its text, with a link back, starts a new thread in our DM.
  app.shortcut("send_to_agent", async ({ ack, body }) => {
    await ack();
    const b = body as any;
    const link = b.team?.domain ? `https://${b.team.domain}.slack.com/archives/${b.channel.id}/p${String(b.message.ts).replace(".", "")}` : "";
    // The relay may have appended its context block: the agent gets it, the quote does not.
    const full: string = unescape(b.message.text ?? "");
    const at = full.indexOf("\n\n[Context from the Slack relay");
    const text = (at >= 0 ? full.slice(0, at) : full) || "(a message without text)";
    const context = at >= 0 ? full.slice(at) : "";
    const quoted = text.split("\n").map((l: string) => `> ${l}`).join("\n");
    // Posting to the user's id lands in our DM with them, which the reply names.
    const root: any = await slack.chat.postMessage({ channel: b.user.id, text: `📎 ${link ? `<${link}|Shared message>` : "Shared message"}:\n${quoted}` });
    const first = { channel: root.channel, text: `${text}${link ? `\n\n[Shared from this Slack message: ${link}]` : ""}${context}`, user: b.user.id, ts: root.ts };
    await offerPicker(first);
    await slack.views.open({ trigger_id: b.trigger_id, view: await folderView({ channel: first.channel, thread: root.ts, cwd: "" }) });
  });

  // The picker: block actions redraw the modal in place; "Use" pushes the session step, "Start" runs.
  const pickOf = (body: any): Pick => JSON.parse(body.view.private_metadata);
  // A redraw keeps the user's tick: Slack keeps it in the radio list, and the submit button must name it too.
  const tickOf = (body: any): string | undefined => body.view.state?.values?.recent?.picker_recent?.selected_option?.value;
  const redraw = async (body: any, view: Promise<ReturnType<typeof modal>>) =>
    slack.views.update({ view_id: body.view.id, view: await view });

  const expired = (channel: string) => slack.chat.postMessage({ channel, text: "This picker has expired. Send a new message to start a thread." });
  app.action("picker_open_modal", async ({ ack, body, action }) => {
    await ack();
    const b = body as any;
    const thread = (action as any).value as string;
    const first = pending.get(thread);
    if (!first) return void (await expired(b.channel.id));
    await slack.views.open({ trigger_id: b.trigger_id, view: await folderView({ channel: first.channel, thread, cwd: "" }) });
  });
  app.action(/^picker_open_\d+$/, async ({ ack, body, action }) => {
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
  app.action("picker_recent", async ({ ack, body, action }) => {
    await ack();
    await redraw(body, folderView(pickOf(body), undefined, (action as any).selected_option?.value));
  });
  app.options("picker_search", async ({ ack, body }) => {
    const found = search((body as any).value ?? "").filter((r) => r.length <= 150); // Slack's limit on an option's value
    await ack({ options: found.map((r) => ({ text: plain(r.length > 75 ? `…${r.slice(-74)}` : r), value: r })) });
  });
  app.action("picker_naming", async ({ ack, body }) => {
    await ack();
    await redraw(body, folderView(pickOf(body), undefined, tickOf(body), true));
  });
  app.action("picker_mkdir", async ({ ack, body, action }) => {
    await ack();
    const p = pickOf(body);
    const name = (((action as any).value as string) ?? "").trim();
    if (!/^[^/\\.][^/\\]*$/.test(name)) return void (await redraw(body, folderView(p, `"${name}" can't be a folder here: one name, no slashes, not starting with a dot.`, tickOf(body), true)));
    try {
      mkdirSync(join(abs(p.cwd), name), { recursive: true }); // an existing folder just opens
    } catch (err: any) {
      return void (await redraw(body, folderView(p, `Couldn't create "${name}": ${err.code ?? err}`, tickOf(body), true)));
    }
    await redraw(body, folderView({ ...p, cwd: join(p.cwd, name) }));
  });
  // "Use": the searched folder, else the ticked suggestion (at the base), else the one being browsed.
  app.view("picker_folder", async ({ ack, view }) => {
    const p: Pick = JSON.parse(view.private_metadata);
    const v = view.state.values as any;
    const picked: string = v.search?.picker_search?.selected_option?.value ?? v.recent?.picker_recent?.selected_option?.value ?? p.cwd;
    const rel = picked === "." ? "" : picked;
    // The error shows in the redrawn modal: an "errors" response needs an input block, and Search is only at the base.
    const fail = async (error: string) => ack({ response_action: "update", view: await folderView(isDir(abs(p.cwd)) ? p : { ...p, cwd: "" }, error, tickOf({ view })) });
    if (rel.split("/").includes("..") || !isDir(abs(rel))) return void (await fail("That folder is gone."));
    if (!pending.has(p.thread)) return void (await fail("This picker has expired. Send a new message."));
    await ack({ response_action: "push", view: await sessionView({ ...p, cwd: rel }) });
  });
  // "Start": the chosen session, or a new one.
  app.view("picker_session", async ({ ack, view }) => {
    const choice = (view.state.values as any).session?.session?.selected_option?.value ?? "new";
    await ack({ response_action: "clear" });
    const p: Pick = JSON.parse(view.private_metadata);
    // Starting takes a moment (a cold folder connects its tools first): the greeting says so at once, and loses its
    // button; Slack's own "Working…" follows when the turn begins.
    const first = pending.get(p.thread);
    const title = (view.state.values as any).session?.session?.selected_option?.text?.text;
    const what = choice === "new" ? "a new session" : `*${title ?? "the session"}*`;
    void (async () => {
      if (first?.picker) await slack.chat.update({ channel: p.channel, ts: first.picker, text: `⏳ Starting ${what} in \`${nameOf(p.cwd)}\`…`, blocks: [] }).catch(() => {});
      await start(p, choice); // the header replaces it
    })().catch((err) => log("session_start_failed", { error: String(err) }));
  });

  app.action(/^cfg:/, async ({ ack, body, action }) => {
    await ack();
    const b = body as any;
    const a = action as any;
    const t = threads[b.message?.thread_ts ?? b.channel?.id];
    const o = t && selects(t).find((x) => `cfg:${x.id}` === a.action_id);
    if (!o || a.selected_option.value === o.currentValue) return;
    try {
      const before = selects(t);
      let r = await agent.setSessionConfigOption({ sessionId: t.sessionId, configId: o.id, value: a.selected_option.value });
      // A new model sets the effort back to the agent's default (opencode): the one in use is set again where offered.
      for (const was of o.category === "model" ? before.filter((x) => x.category === "thought_level") : []) {
        const now: any = r.configOptions.find((x) => x.id === was.id);
        if (now && now.currentValue !== was.currentValue && choicesOf(now).some((c) => c.value === was.currentValue)) {
          r = await agent.setSessionConfigOption({ sessionId: t.sessionId, configId: was.id, value: was.currentValue });
        }
      }
      setConfigs(t.sessionId, r.configOptions);
    } catch (err: any) {
      await say(t, `⚠️ Could not change ${o.name}: ${err?.message ?? err}`);
    }
    // Redrawn either way: a failed change shows the value still in use.
    await slack.chat.update({ channel: t.channel, ts: b.message.ts, text: summary(t), blocks: panel(t) as any[] });
    await contextBar(t);
  });

  // "Send now" on a queued notice: stop the running turn, so the queue moves on.
  app.action("queue_now", async ({ ack, body, action }) => {
    await ack();
    const { thread, turn } = JSON.parse((action as any).value);
    const t = threads[thread];
    if (!t || !outputs.has(t.sessionId) || turnOf.get(t.sessionId) !== turn) return;
    await stop(t);
    const b = body as any;
    await slack.chat.update({ channel: t.channel, ts: b.message.ts, text: "📬 Sent now: the previous turn was stopped.", blocks: [] });
  });

  app.action("retry", async ({ ack, body, action }) => {
    await ack();
    const b = body as any;
    const r = retries.get((action as any).value);
    retries.delete((action as any).value);
    const t = r && threads[r.thread];
    await slack.chat.update({ channel: b.channel.id, ts: b.message.ts, text: t ? "⚠️ The turn failed. Retrying…" : "⚠️ The turn failed. (Retry expired: send the message again.)", blocks: [] });
    if (t) void prompt(t, r.content, { ts: r.ts });
  });

  app.action(/^ask_/, async ({ ack, body, action }) => {
    await ack();
    const b = body as any;
    await answer(b.message.thread_ts ?? b.channel.id, (action as any).value);
  });

  app.action(/^perm_/, async ({ ack, body, action }) => {
    await ack();
    const b = body as any;
    const { id, optionId, name } = JSON.parse((action as any).value);
    const resolve = permissions.get(id)?.resolve;
    permissions.delete(id);
    const what = permissionTexts.get(id) ?? "🔐 Permission request";
    permissionTexts.delete(id);
    resolve?.(optionId);
    const text = `${what}\n→ *${resolve ? name : "expired"}*`;
    await slack.chat.update({ channel: b.channel.id, ts: b.message.ts, text, blocks: [] });
  });

  return {
    async start() {
      await ready;
      await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
      mcpPort = (mcp.address() as AddressInfo).port;
      await app.start();
      log("started", { baseDir: cfg.baseDir, threads: bySession.size });
      // Messages that were waiting when the daemon stopped, in the order they came.
      for (const m of [...queued.values()]) {
        const t = threads[m.key];
        if (t) void prompt(t, blocksFor(m), { ts: m.ts, from: m });
        else queued.delete(m.ts);
      }
    },
    async stop() {
      stopping = true;
      await app.stop();
      mcp.close();
      proc.kill();
    },
  };
}
