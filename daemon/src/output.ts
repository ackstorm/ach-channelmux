// Renders one agent turn into a Slack thread. With native streaming (chat.startStream),
// text grows in one message and each tool call is a task card. If a stream cannot start or
// breaks (feature off, or the relay refusing it because the shared rate budget is spent),
// the rest of the turn goes out as plain messages, one per finished text segment (cut at
// tool calls), split to Slack's 12k limit. The session status (Slack's "Working…" and stop
// button) brackets the turn.

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
const lineCount = (s?: string | null) => (s ? s.split("\n").length : 0);
// A card's output renders Markdown when expanded (```diff in colour, verified on Slack); fences
// are closed after clipping so a cut never leaves one open.
const fence = (body: string, max: number, lang = "") => `\`\`\`${lang}\n${clip(body.replaceAll("\`\`\`", "ˋˋˋ"), max)}\n\`\`\``;
const diffLines = (oldText: string | null | undefined, newText: string | null | undefined) =>
  [...(oldText ? oldText.split("\n").map((l) => `-${l}`) : []), ...(newText ? newText.split("\n").map((l) => `+${l}`) : [])].join("\n");

/** Turn diffs longer than this (what a card shows) also go to the thread as a changes.diff snippet. */
export const DIFF_IN_CARD = 400;

/** The full diff of a finished edit, or undefined: "--- path / +++ path" then -/+ lines per file. */
export function fullDiff(u: any, cwd: string): string | undefined {
  if (u.status !== "completed") return undefined;
  const rel = (p: string) => (p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);
  const diffs = (u.content ?? []).filter((c: any) => c.type === "diff");
  if (!diffs.length) return undefined;
  return diffs.map((d: any) => `--- ${rel(d.path)}\n+++ ${rel(d.path)}\n${diffLines(d.oldText, d.newText)}`).join("\n");
}

/** Describes an ACP tool_call / tool_call_update for a card. `input` is the tool's latest rawInput. */
export function describeTool(u: any, input: any, cwd: string): ToolInfo {
  const rel = (p: string) => (p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);
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
      const head = diffs.map((d) => `${rel(d.path)}  +${lineCount(d.newText)} −${lineCount(d.oldText)}`).join("\n");
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
    const fences = part.match(/^```.*$/gm) ?? [];
    const open = fences.length % 2 === 1 ? fences[fences.length - 1] : "";
    if (open) part += "\n```";
    reopen = open ? `${open}\n` : "";
    parts.push(part);
  }
  parts.push(reopen + rest);
  return parts;
}

export function createOutput(api: Api, where: { channel: string; thread: string }, opts: { title?: string; log?: Log; statusRefreshMs?: number } = {}) {
  const log = opts.log ?? (() => {});
  const { channel, thread } = where;
  let streaming = true; // until a stream call fails, for the rest of this turn
  let stream: { ts: string; started: number } | null = null;
  let pending = "";
  let afterTool = false;
  let quiet = false; // a tool ran and no text has come since
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refresh: ReturnType<typeof setInterval> | undefined;
  let suspended = false;
  let thinking: { id: string; text: string } | null = null; // the model's thinking since its last text or tool
  let thoughts = 0;
  const tasks = new Map<string, Chunk>(); // ACP tool call id -> last known card, for tool()'s prev lookup
  const sentTasks = new Map<string, Chunk>(); // last status actually delivered; replayed into a rolled-over stream
  let chain: Promise<unknown> = Promise.resolve();
  const run = (fn: () => Promise<unknown>) =>
    (chain = chain.then(fn).catch((err) => log("output_failed", { error: String(err) })));
  const status = (s: string, extra: Record<string, unknown> = {}) =>
    api("agents.sessions.setStatus", { channel_id: channel, thread_ts: thread, status: s, ...extra }).catch((err) =>
      log("status_failed", { status: s, error: String(err) }),
    );

  async function stopStream(blocks?: unknown[]) {
    if (!stream) return;
    const ts = stream.ts;
    stream = null;
    await api("chat.stopStream", { channel, ts, ...(blocks && { blocks }) }); // also sets the session back to active
  }

  async function send(chunks: Chunk[]): Promise<boolean> {
    if (!streaming) return false;
    try {
      if (stream && Date.now() - stream.started > STREAM_MAX_AGE_MS) await stopStream();
      if (stream) {
        await api("chat.appendStream", { channel, ts: stream.ts, chunks });
      } else {
        const open = [...sentTasks.values()].filter((t) => t.status === "pending" || t.status === "in_progress");
        const r = await api("chat.startStream", { channel, thread_ts: thread, task_display_mode: "timeline", chunks: [...open, ...chunks] });
        stream = { ts: r.ts, started: Date.now() };
      }
      for (const c of chunks) if (c.type === "task_update") sentTasks.set(c.id as string, c);
      return true;
    } catch (err) {
      log("stream_fallback", { error: String(err) });
      streaming = false;
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
    for (const part of splitMarkdown(text.trim())) await api("chat.postMessage", { channel, thread_ts: thread, markdown_text: part });
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
    // Slack adds a card's sources to those it already shows: send them only when they change.
    const { sources: _, ...withoutSources } = task;
    const chunk = same("sources") ? withoutSources : task;
    return run(async () => {
      await flush();
      await send([chunk]);
    });
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
        await stopStream().catch(() => {});
        await status("suspended");
      });
    },
    resume: () => {
      suspended = false;
      return run(() => status("processing"));
    },
    /** Blocks (e.g. feedback buttons) go under the streamed reply; without a stream they are dropped. */
    end: (blocks?: unknown[]) => {
      clearInterval(refresh);
      endThought();
      return run(async () => {
        await flush();
        if (stream) await stopStream(blocks).catch(() => status("active"));
        else await status("active");
      });
    },
  };
}

export type Output = ReturnType<typeof createOutput>;
