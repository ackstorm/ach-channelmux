// Renders one agent turn into a Slack thread. With native streaming (chat.startStream),
// text grows in one message and each tool call is a task card. If a stream cannot start or
// breaks (feature off, or the relay refusing it because the shared rate budget is spent),
// the rest of the turn goes out as plain messages, one per finished text segment (cut at
// tool calls), split to Slack's 12k limit. The session status (Slack's "Working…" and stop
// button) brackets the turn.

import { realpathSync } from "node:fs";

export const MAX_TEXT = 12_000;
// chat.appendStream is Tier 4 (100+/min) shared by every user: at most one append a second.
const FLUSH_MS = 1_000;
// Slack ends a stream after about 5 minutes; roll over to a new message before that.
const STREAM_MAX_AGE_MS = 240_000;
// Slack drops a session's "processing" status after an hour unless it is sent again.
const STATUS_REFRESH_MS = 30 * 60_000;
const TASK_STATUS: Record<string, string> = { pending: "pending", in_progress: "in_progress", completed: "complete", failed: "error" };

// task_update field limits, probed against Slack (2026-10-08): 800 chars of output passed, 1000 failed
// with msg_too_long; the margins are deliberate.
const TITLE_MAX = 200;
const DETAILS_MAX = 250;
const OUTPUT_MAX = 500;

/** What a tool card shows. Missing fields keep their earlier value. */
export interface ToolInfo {
  title?: string;
  status?: string; // ACP: pending, in_progress, completed, failed
  details?: string; // what ran: command, path, pattern
  output?: string; // what came back: start of the result, edit sizes, exit code
  sources?: { type: "url"; text: string; url: string }[]; // a fetched page, as a link
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
// A text's lines; its final newline ends the last line, it does not start another.
const linesOf = (s?: string | null) => (s ? s.replace(/\n$/, "").split("\n") : []);
// A card's output renders Markdown when expanded (```diff in colour, verified on Slack); fences
// are closed after clipping so a cut never leaves one open.
const fence = (body: string, max: number, lang = "") => `\`\`\`${lang}\n${clip(body.replaceAll("\`\`\`", "ˋˋˋ"), max)}\n\`\`\``;
/** What an edit changed: the lines left once those both versions share at the start and end are set aside.
 * opencode reports a whole file before and after each edit. */
export function changed(oldText: string | null | undefined, newText: string | null | undefined) {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  let end = 0;
  while (end < a.length - at && end < b.length - at && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  // ponytail: one hunk from the first to the last change; edits far apart show the lines between them too.
  return { at, removed: a.slice(at, a.length - end), added: b.slice(at, b.length - end) };
}
const diffLines = (oldText: string | null | undefined, newText: string | null | undefined) => {
  const { at, removed, added } = changed(oldText, newText);
  return [`@@ -${at + 1},${removed.length} +${at + 1},${added.length} @@`, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");
};

// A path relative to the folder; the agent may report it under the folder's real path (a symlink resolved).
const relTo = (cwd: string) => {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {}
  return (p: string) => {
    for (const root of [cwd, real]) if (p.startsWith(`${root}/`)) return p.slice(root.length + 1);
    return p;
  };
};

// ACP tool kinds as verbs; opencode sends "other" for a path outside the folder.
const VERBS: Record<string, string> = { read: "read", edit: "edit", delete: "delete", move: "move", execute: "run", fetch: "fetch", search: "search" };
/** A permission request in words: what the agent wants to do to what, plus the command or the new content. */
export function describePermission(toolCall: any, input: any, cwd: string) {
  const i = input ?? {};
  const path: string | undefined = i.filePath ?? i.path ?? toolCall.locations?.[0]?.path;
  if (typeof i.command === "string") return `🔐 The agent wants to run:\n${fence(i.command, 500)}`;
  const verb = VERBS[toolCall.kind] ?? (path ? "access" : "use");
  const subject = path ? `\`${relTo(cwd)(path)}\`` : `*${toolCall.title ?? "a tool"}*`;
  const content = typeof i.content === "string" ? i.content : typeof i.newString === "string" ? i.newString : undefined;
  const shown = content ?? (path || !input ? "" : JSON.stringify(input));
  return `🔐 The agent wants to ${verb} ${subject}${shown ? `\n${fence(shown, 500)}` : ""}`;
}

/** Turn diffs longer than this (what a card shows) also go to the thread as a changes.diff snippet. */
export const DIFF_IN_CARD = 400;

/** A finished edit's diffs. opencode's write reports none: its input (path and whole content) stands for one. */
export function editsOf(u: any, input: any): { path: string; oldText?: string | null; newText?: string | null }[] {
  if (u.status !== "completed") return [];
  const diffs = (u.content ?? []).filter((c: any) => c.type === "diff");
  const path = input?.filePath ?? input?.path;
  // ponytail: an overwritten file counts as all new lines; its old content is not reported.
  if (!diffs.length && typeof input?.content === "string" && typeof path === "string") return [{ path, oldText: null, newText: input.content }];
  return diffs;
}

/** The full diff of a finished edit, or undefined: "--- path / +++ path" then -/+ lines per file. */
export function fullDiff(u: any, cwd: string, input?: any): string | undefined {
  const rel = relTo(cwd);
  const diffs = editsOf(u, input);
  if (!diffs.length) return undefined;
  return diffs.map((d: any) => `--- ${rel(d.path)}\n+++ ${rel(d.path)}\n${diffLines(d.oldText, d.newText)}`).join("\n");
}

/** Describes an ACP tool_call / tool_call_update for a card. `input` is the tool's latest rawInput. */
export function describeTool(u: any, input: any, cwd: string): ToolInfo {
  const rel = relTo(cwd);
  const i = input ?? {};
  const path: string | undefined = i.filePath ?? i.path ?? u.locations?.[0]?.path;
  const command = typeof i.command === "string" ? i.command : undefined;
  // A subagent's own tools (opencode) come titled "<subagent task>: glob"; they show as "↳ glob".
  const child = u._meta?.["opencode/child-session"]?.title;
  let title: string | undefined = u.title ?? undefined;
  if (child && title?.startsWith(`${child}: `)) title = title.slice(child.length + 2);
  const subject = path ? rel(path) : (i.description ?? i.id); // a subagent's task, a skill's name
  // A shell card is its command; a long or multi-line one (a heredoc) is titled by the agent's own
  // description of it, or its first line, and shown whole in the details.
  const short = command !== undefined && !command.includes("\n") && command.length <= 100;
  if (command) title = short ? command : (typeof i.description === "string" && i.description) || `${command.split("\n")[0]} …`;
  else if (title && subject && u.kind !== "execute" && /^\w+$/.test(title)) title = `${title} ${subject}`; // "read" -> "read calc.py"
  // opencode's code tool ("execute") runs code that calls MCP tools: titled by the tools it calls.
  const called = typeof i.code === "string" ? [...i.code.matchAll(/\btools\.(\w+)(?:\.(\w+)|\[["'](\w+)["']\])/g)].map((m) => `${m[1]}.${m[2] ?? m[3]}`) : [];
  if (called.length) title = [...new Set(called)].join(", ");
  else if (typeof i.code === "string" && i.code.trim()) title = i.code.trim().split("\n")[0]; // no tool called: its first line
  if (child && title) title = `↳ ${title}`;
  const sources = typeof i.url === "string" && /^https?:\/\//.test(i.url) ? [{ type: "url" as const, text: clip(i.url, DETAILS_MAX), url: i.url }] : undefined;
  let details: string | undefined;
  if (i.pattern) details = `${i.pattern}${path ? ` in ${rel(path)}` : ""}`;
  else if (i.url && !sources) details = String(i.url); // a link says it otherwise
  else if (typeof i.code === "string") details = i.code;
  else if (command && !short) details = command;
  let output: string | undefined;
  let status: string | undefined = u.status ?? undefined;
  if (u.status === "completed" || u.status === "failed") {
    const content: any[] = u.content ?? [];
    const diffs = content.filter((c) => c.type === "diff");
    const text = content.filter((c) => c.type === "content" && c.content?.type === "text").map((c) => c.content.text).join("\n").trim()
      .replace(/^<subagent[^>]*>\n?([\s\S]*?)\n?<\/subagent>$/, "$1");
    const exit = u.rawOutput?.metadata?.exit;
    const failed = typeof exit === "number" && exit !== 0 ? `exit ${exit}\n` : "";
    // opencode reports a command that exits non-zero, or a tool error, as completed
    if (failed || u.rawOutput?.metadata?.error === true) status = "failed";
    const room = OUTPUT_MAX - 40; // headers and fences
    if (diffs.length) {
      const head = diffs.map((d) => {
        const { added, removed } = changed(d.oldText, d.newText);
        return `${rel(d.path)}  +${added.length} −${removed.length}`;
      }).join("\n");
      output = `${head}\n${fence(diffs.map((d) => diffLines(d.oldText, d.newText)).join("\n"), room - head.length, "diff")}`;
    } else if (text) output = `${failed}${fence(text, room)}`;
    else if (failed) output = failed.trim();
  }
  return {
    ...(title && { title: clip(title, TITLE_MAX) }),
    ...(status && { status }),
    ...(details && { details: clip(details, DETAILS_MAX) }),
    ...(output && { output: clip(output, OUTPUT_MAX) }),
    ...(sources && { sources }),
  };
}

type Api = (method: string, params: Record<string, unknown>) => Promise<any>;
type Log = (msg: string, extra?: unknown) => void;
type Chunk = { type: string; [k: string]: unknown };

/** The code fence a Markdown text leaves open ("```diff"), or "". */
const openFence = (text: string) => {
  const fences = text.match(/^```.*$/gm) ?? [];
  return fences.length % 2 === 1 ? fences[fences.length - 1] : "";
};

/** Splits Markdown into parts of at most `max` characters, closing and reopening code fences at the cuts. */
export function splitMarkdown(text: string, max = MAX_TEXT): string[] {
  const parts: string[] = [];
  let rest = text;
  let reopen = "";
  while (reopen.length + rest.length > max) {
    const budget = max - reopen.length - 4; // room for "\n```"
    let cut = rest.lastIndexOf("\n", budget);
    if (cut <= 0) cut = budget;
    let part = reopen + rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, "");
    const open = openFence(part);
    if (open) part += "\n```";
    reopen = open ? `${open}\n` : "";
    parts.push(part);
  }
  parts.push(reopen + rest);
  return parts;
}

// A card's text as rich_text elements: fenced code preformatted, the rest plain.
const rich = (s: string) =>
  s.split(/```\w*\n?([\s\S]*?)\n?```/).flatMap((part, i) =>
    part.trim() ? [{ type: i % 2 ? "rich_text_preformatted" : "rich_text_section", elements: [{ type: "text", text: i % 2 ? part : part.trim() }] }] : []);
const taskCard = (id: string, title: string, status: string, fields: Record<string, unknown>) => ({
  type: "task_card", task_id: id, title, status: status === "complete" || status === "error" ? status : "in_progress", ...fields,
});
// A tool's card folded into its run's card: its title, then a clip of what it showed.
const IN_RUN_MAX = 300;
function inRun(t: Chunk) {
  let body = clip([t.details, t.output].filter(Boolean).join("\n"), IN_RUN_MAX);
  if (openFence(body)) body += "\n```";
  const mark = t.status === "complete" ? "✓" : t.status === "error" ? "✗" : "◦";
  const links = ((t.sources as { url: string; text: string }[] | undefined) ?? []).map((x) => ({ type: "link", url: x.url, text: x.text }));
  return [
    { type: "rich_text_section", elements: [{ type: "text", text: `${mark} ` }, { type: "text", text: t.title, style: { bold: true } }] },
    ...rich(body),
    ...(links.length ? [{ type: "rich_text_section", elements: links }] : []),
  ];
}

export function createOutput(api: Api, where: { channel: string; thread?: string }, opts: { title?: string; log?: Log; statusRefreshMs?: number } = {}) {
  const log = opts.log ?? (() => {});
  const { channel, thread } = where;
  let streaming = true; // until a stream call fails, for the rest of this turn
  let stream: { ts: string; started: number } | null = null;
  // Text can go on in a new message (Slack's size or age limit, or plain messages): the Markdown sent into
  // the current one tells whether it ends inside a code fence, which the next one then reopens.
  let sent = "";
  let reopen = "";
  let pending = "";
  let afterTool = false;
  let quiet = false; // a tool ran and no text has come since
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refresh: ReturnType<typeof setInterval> | undefined;
  let suspended = false;
  const held = new Set<string>(); // cards updated during a pause: a new message would show them running under the question
  let thinking: { id: string; text: string } | null = null; // the model's thinking since its last text or tool
  let thoughts = 0;
  const tasks = new Map<string, Chunk>(); // ACP tool call id -> last known card, for tool()'s prev lookup
  const sentTasks = new Map<string, Chunk>(); // last status actually delivered; replayed into a rolled-over stream
  let layout: ({ text: string } | { card: string })[] = []; // the current stream message as sent, in order
  let chain: Promise<unknown> = Promise.resolve();
  const run = (fn: () => Promise<unknown>) =>
    (chain = chain.then(fn).catch((err) => log("output_failed", { error: String(err) })));
  const status = (s: string, extra: Record<string, unknown> = {}) =>
    api("agents.sessions.setStatus", { channel_id: channel, ...(thread && { thread_ts: thread }), status: s, ...extra }).catch((err) =>
      log("status_failed", { status: s, error: String(err) }),
    );

  async function stopStream(blocks?: unknown[]) {
    if (!stream) return;
    const ts = stream.ts;
    stream = null;
    await api("chat.stopStream", { channel, ts, ...(blocks && { blocks }) }); // also sets the session back to active
    await rewrite(ts, blocks);
  }

  // A stopped message is sent again with each run of tools (no text between them) folded into one card that
  // counts them and holds each one's title and a clip of its card: fewer cards, less space between them.
  // A live stream cannot remove cards; a stopped one can be rewritten whole (verified on Slack).
  // ponytail: a rewrite Slack refuses (size, more than 50 blocks) leaves the message as streamed.
  async function rewrite(ts: string, extra: unknown[] = []) {
    // Each card whole (sentTasks keeps only what each update changed), with the status this message got: one
    // still running here goes on in the next message, as settle() says.
    const byId = new Map([...tasks].map(([key, t]) => {
      const status = sentTasks.get(t.id as string)?.status as string;
      const done = status === "complete" || status === "error";
      return [t.id as string, { thought: key.startsWith("thought"), t: { ...t, ...(done ? { status } : { status: "complete", output: "↓ continues below" }) } }];
    }));
    const items: ({ text: string } | { card: Chunk } | { run: Chunk[] })[] = [];
    let run: Chunk[] | null = null;
    for (const x of layout) {
      if ("text" in x) {
        if (x.text.trim()) items.push(x), (run = null);
        continue;
      }
      const { thought, t } = byId.get(x.card)!;
      if (thought) items.push({ card: t }); // Thinking keeps its own card, and the run goes on past it
      else if (run) run.push(t);
      else items.push({ run: (run = [t]) });
    }
    if (!items.some((x) => "run" in x && x.run.length > 1)) return;
    const card = (t: Chunk) =>
      taskCard(t.id as string, t.title as string, t.status as string, {
        ...(t.details ? { details: { type: "rich_text", elements: rich(t.details as string) } } : {}),
        ...(t.output ? { output: { type: "rich_text", elements: rich(t.output as string) } } : {}),
        ...(t.sources ? { sources: t.sources } : {}),
      });
    const blocks = items.map((x) => {
      if ("text" in x) return { type: "markdown", text: openFence(x.text) ? `${x.text.trim()}\n\`\`\`` : x.text.trim() };
      if ("card" in x || x.run.length === 1) return card("card" in x ? x.card : x.run[0]);
      const failed = x.run.filter((t) => t.status === "error").length;
      const done = x.run.every((t) => t.status === "complete" || t.status === "error");
      const title = `🔧 ${x.run.length} tools used${failed ? ` · ${failed} failed` : ""}`;
      return taskCard(x.run[0].id as string, title, done ? "complete" : "in_progress", { output: { type: "rich_text", elements: x.run.flatMap(inRun) } });
    });
    await api("chat.update", { channel, ts, text: sent.trim().slice(0, 3000) || "🔧", blocks: [...blocks, ...extra] })
      .catch((err) => log("rewrite_failed", { error: String(err) }));
  }

  // What the stream message got, in order, for its rewrite.
  function record(chunks: Chunk[]) {
    for (const c of chunks) {
      const last = layout.at(-1);
      if (c.type === "markdown_text") {
        if (last && "text" in last) last.text += c.text;
        else layout.push({ text: c.text as string });
      } else if (!layout.some((x) => "card" in x && x.card === c.id)) layout.push({ card: c.id as string });
    }
  }

  const textOf = (chunks: Chunk[]) => chunks.map((c) => (c.type === "markdown_text" ? c.text : "")).join("");

  const running = () => [...sentTasks.values()].filter((t) => t.status === "pending" || t.status === "in_progress");

  // A new stream message carries the cards still running and, before text, the fence the last one left open.
  async function start(chunks: Chunk[]) {
    const open = running().filter((t) => !chunks.some((c) => c.id === t.id));
    const lead = reopen && chunks[0]?.type === "markdown_text" ? [{ type: "markdown_text", text: `${reopen}\n` }] : [];
    reopen = "";
    const r = await api("chat.startStream", { channel, ...(thread && { thread_ts: thread }), task_display_mode: "timeline", chunks: [...open, ...lead, ...chunks] });
    stream = { ts: r.ts, started: Date.now() };
    sent = textOf(lead);
    layout = [];
    record([...open, ...lead]);
  }

  // Ends the stream message for a new one to go on; a fence left open is closed when the message still takes it.
  async function roll(close: boolean) {
    const fence = openFence(sent);
    if (fence && close && stream) await api("chat.appendStream", { channel, ts: stream.ts, chunks: [{ type: "markdown_text", text: "\n```" }] }).then(() => record([{ type: "markdown_text", text: "\n```" }]), () => {});
    if (close) await settle();
    await stopStream();
    reopen = fence;
  }

  // A card still running when its message ends would stay unfinished there (red after a pause, a spinner
  // after a rollover): it is closed with a pointer, and the next message shows it running again.
  async function settle() {
    const open = running();
    if (!stream || !open.length) return;
    const chunks = open.map((t) => ({ type: "task_update", id: t.id, title: t.title, status: "complete", output: "↓ continues below" }));
    await api("chat.appendStream", { channel, ts: stream.ts, chunks }).catch(() => {});
  }

  async function send(chunks: Chunk[]): Promise<boolean> {
    if (!streaming) return false;
    try {
      if (stream && Date.now() - stream.started > STREAM_MAX_AGE_MS) await roll(true);
      if (stream) {
        try {
          await api("chat.appendStream", { channel, ts: stream.ts, chunks });
        } catch (err) {
          // A message full to Slack's size limit: the turn goes on in a new one.
          if (!String(err).includes("msg_too_long")) throw err;
          await roll(false);
          await start(chunks);
        }
      } else {
        await start(chunks);
      }
      sent += textOf(chunks);
      record(chunks);
      for (const c of chunks) if (c.type === "task_update") sentTasks.set(c.id as string, c);
      return true;
    } catch (err) {
      log("stream_fallback", { error: String(err) });
      streaming = false;
      reopen ||= openFence(sent);
      await stopStream().catch(() => {});
      await status("processing");
      return false;
    }
  }

  async function flush() {
    clearTimeout(timer);
    timer = undefined;
    const text = pending;
    pending = "";
    if (!text.trim()) return;
    const pieces = text.match(/[\s\S]{1,12000}/g)!;
    if (await send(pieces.map((t) => ({ type: "markdown_text", text: t })))) return;
    // Plain messages from here; the first one reopens a fence the stream left open.
    const body = reopen ? `${reopen}\n${text.replace(/^\n+/, "")}` : text.trim();
    reopen = "";
    for (const part of splitMarkdown(body)) await api("chat.postMessage", { channel, thread_ts: thread, markdown_text: part });
  }

  function tool(id: string, info: ToolInfo) {
    if (thinking && id !== thinking.id) endThought();
    const prev = tasks.get(id);
    const details = info.details ?? (prev?.details as string | undefined);
    const output = info.output ?? (prev?.output as string | undefined);
    const sources = info.sources ?? prev?.sources;
    const task: Chunk = {
      type: "task_update",
      // ACP ids can be long (opencode's run ~150 chars with + and /); Slack only needs them unique per message.
      id: prev?.id ?? `t${tasks.size + 1}`,
      title: clip(String(info.title ?? prev?.title ?? "tool"), TITLE_MAX),
      status: TASK_STATUS[info.status ?? ""] ?? prev?.status ?? "in_progress",
      ...(details && { details }),
      ...(output && { output }),
      ...(sources ? { sources } : {}),
    };
    // Agents repeat unchanged updates; each would cost an append from the shared budget.
    const same = (k: string) => JSON.stringify(prev?.[k]) === JSON.stringify(task[k]);
    if (prev && ["title", "status", "details", "output", "sources"].every(same)) return chain;
    tasks.set(id, task);
    afterTool = true;
    quiet = true;
    // Slack appends a card's details, output and sources to what it already shows: send them only when they change.
    const chunk = { ...task };
    for (const k of ["details", "output", "sources"]) if (same(k)) delete chunk[k];
    return run(async () => {
      if (suspended) return void held.add(id);
      await flush();
      await send([chunk]);
    });
  }
  // The held cards, whole: the message they go to has not shown them yet.
  async function release() {
    const cards = [...held].map((id) => tasks.get(id)!);
    held.clear();
    if (cards.length) await send(cards);
  }

  // The model's thinking is one folded card per stretch: opened when it starts, filled with its
  // end when text or a tool follows (two appends, not one per chunk).
  function endThought() {
    if (!thinking) return;
    const { id, text } = thinking;
    thinking = null;
    const tail = text.trim().replaceAll("\`\`\`", "ˋˋˋ");
    void tool(id, { status: "completed", ...(tail && { output: tail.length > OUTPUT_MAX ? `…${tail.slice(-(OUTPUT_MAX - 1))}` : tail }) });
  }

  return {
    begin: () => {
      refresh = setInterval(() => !suspended && run(() => status("processing")), opts.statusRefreshMs ?? STATUS_REFRESH_MS);
      return run(() => status("processing", opts.title ? { title: opts.title.slice(0, 200) } : {}));
    },
    text(s: string) {
      if (s.trim()) {
        endThought();
        quiet = false;
      }
      if (afterTool) {
        s = `\n\n${s}`;
        afterTool = false;
      }
      pending += s;
      if (streaming && !timer) timer = setTimeout(() => run(flush), FLUSH_MS);
    },
    thought(s: string) {
      if (thinking) return void (thinking.text += s);
      thinking = { id: `thought${++thoughts}`, text: s };
      void tool(thinking.id, { title: "Thinking", status: "in_progress" });
    },
    tool,
    /** True when the turn's last output was a tool call, with no reply after it. */
    get quiet() {
      return quiet;
    },
    /** Before posting buttons (blocks only go out when a stream stops). */
    pause: () => {
      suspended = true;
      return run(async () => {
        await flush();
        await settle();
        await stopStream().catch(() => {});
        await status("suspended");
      });
    },
    resume: () => {
      suspended = false;
      return run(async () => {
        await status("processing");
        await release();
      });
    },
    /** Blocks (e.g. the footer line) go under the streamed reply; without a stream they are dropped. */
    end: (blocks?: unknown[]) => {
      clearInterval(refresh);
      endThought();
      suspended = false;
      return run(async () => {
        await release();
        await flush();
        if (stream) await stopStream(blocks).catch(() => status("active"));
        else await status("active");
      });
    },
  };
}

export type Output = ReturnType<typeof createOutput>;
