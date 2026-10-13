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
/** Both versions line by line, each line kept (" "), removed ("-") or added ("+"): a longest common subsequence
 * of the lines between those both share at the start and end. opencode reports a whole file before and after each edit. */
function lineOps(oldText: string | null | undefined, newText: string | null | undefined): [string, string][] {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  let end = 0;
  while (end < a.length - at && end < b.length - at && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(at, a.length - end);
  const y = b.slice(at, b.length - end);
  const ops: [string, string][] = a.slice(0, at).map((l) => [" ", l]);
  if (x.length * y.length > 4_000_000) {
    // ponytail: past 4M line pairs (16 MB), one block of removed then added lines; Myers' diff if that shows up.
    ops.push(...x.map((l): [string, string] => ["-", l]), ...y.map((l): [string, string] => ["+", l]));
  } else {
    // common[i * w + j]: the longest common subsequence of x[i..] and y[j..]
    const w = y.length + 1;
    const common = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) common[i * w + j] = x[i] === y[j] ? common[(i + 1) * w + j + 1] + 1 : Math.max(common[(i + 1) * w + j], common[i * w + j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) ops.push([" ", x[i++]]), j++;
      else if (i < x.length && (j === y.length || common[(i + 1) * w + j] >= common[i * w + j + 1])) ops.push(["-", x[i++]]);
      else ops.push(["+", y[j++]]);
    }
  }
  ops.push(...a.slice(a.length - end).map((l): [string, string] => [" ", l]));
  return ops;
}
/** The lines an edit removed and added. */
export function changed(oldText: string | null | undefined, newText: string | null | undefined) {
  const ops = lineOps(oldText, newText);
  return { removed: ops.filter(([op]) => op === "-").map(([, l]) => l), added: ops.filter(([op]) => op === "+").map(([, l]) => l) };
}
const CONTEXT = 3; // unchanged lines around each change, as git shows them
/** Unified diff hunks: changes closer than twice the context share one. */
const diffLines = (oldText: string | null | undefined, newText: string | null | undefined) => {
  const ops = lineOps(oldText, newText);
  const hunks: [number, number][] = []; // first and last change of each
  ops.forEach(([op], i) => {
    if (op === " ") return;
    const last = hunks.at(-1);
    if (last && i - last[1] <= 2 * CONTEXT + 1) last[1] = i;
    else hunks.push([i, i]);
  });
  const count = (part: [string, string][], skip: string) => part.filter(([op]) => op !== skip).length;
  return hunks.map(([first, last]) => {
    const from = Math.max(0, first - CONTEXT);
    const body = ops.slice(from, last + CONTEXT + 1);
    const before = ops.slice(0, from);
    return [`@@ -${count(before, "+") + 1},${count(body, "+")} +${count(before, "-") + 1},${count(body, "-")} @@`, ...body.map(([op, l]) => `${op}${l}`)].join("\n");
  }).join("\n");
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
const CONTENT = ["details", "output", "sources"];
const taskCard = (id: string, title: string, status: string, fields: Record<string, unknown>) => ({
  type: "task_card", task_id: id, title, status: status === "complete" || status === "error" ? status : "in_progress", ...fields,
});
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
  let quiet = true; // no reply text yet, or none since the last tool
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refresh: ReturnType<typeof setInterval> | undefined;
  let suspended = false;
  const held = new Set<string>(); // cards updated during a pause: a new message would show them running under the question
  let thinking: { id: string; text: string } | null = null; // the model's thinking since its last text or tool
  let texts = 0; // texts so far: the thinking between two texts is one card
  const tasks = new Map<string, Chunk>(); // ACP tool call id (or thoughtN) -> its card's last known fields, whole
  // A run is the tools called between two texts; it takes two cards, each on its own line. a<n> shows its first
  // tool, then counts the tools before the one running now, which b<n> shows (each tool's content under its title:
  // Slack appends content to a card); text or the turn's end makes a<n> count them all. A stream can neither
  // remove b<n> nor clear a<n>'s content: the message is rewritten without them once it stops.
  type Run = { n: number; tools: string[]; closed: boolean };
  const runs: Run[] = [];
  let current: Run | null = null;
  const runOf = new Map<string, Run>(); // ACP tool call id -> its run
  const queued = new Map<string, { title: string; status: string }>(); // card id -> its title and status last queued
  const filled = new Set<string>(); // "<card>:<field>" and "<card>:<tool>:<field>" given content in a b<n> card
  const sentTasks = new Map<string, Chunk>(); // card id -> last update delivered; replayed into a rolled-over stream
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

  // A stopped message is sent again with each run's cards as one, its count, with nothing inside.
  // ponytail: a rewrite Slack refuses (size, more than 50 blocks) leaves the message as streamed.
  async function rewrite(ts: string, extra: unknown[] = []) {
    const runOfCard = (card: string) => runs[Number(card.slice(1)) - 1];
    const folded = (card: string) => card[0] === "b" || (card[0] === "a" && (runOfCard(card).closed || runOfCard(card).tools.length > 1));
    if (!layout.some((x) => "card" in x && folded(x.card))) return;
    const blocks = layout.flatMap((x): unknown[] => {
      if ("text" in x) {
        const t = x.text.trim();
        return t ? [{ type: "markdown", text: openFence(x.text) ? `${t}\n\`\`\`` : t }] : [];
      }
      if (x.card[0] === "b") return [];
      const { title, status } = sentTasks.get(x.card) as { title: string; status: string };
      // One still running here goes on in the next message, as settle() says.
      const done = finished(status);
      if (folded(x.card)) return [taskCard(x.card, title, done ? status : "complete", {})];
      const t = { ...tasks.get(x.card[0] === "a" ? runOfCard(x.card).tools[0] : x.card)!, ...(done ? {} : { output: "↓ continues below" }) };
      return [taskCard(x.card, t.title as string, done ? status : "complete", {
        ...(t.details ? { details: { type: "rich_text", elements: rich(t.details as string) } } : {}),
        ...(t.output ? { output: { type: "rich_text", elements: rich(t.output as string) } } : {}),
        ...(t.sources ? { sources: t.sources } : {}),
      })];
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

  const finished = (status: unknown) => status === "complete" || status === "error";
  const running = () => [...sentTasks.values()].filter((t) => !finished(t.status));

  // A new stream message carries, whole, the cards still running and the open run's, and, before text, the fence
  // the last one left open.
  async function start(chunks: Chunk[]) {
    const keep = current ? [`a${current.n}`, `b${current.n}`] : [];
    const open = [...sentTasks.values()].filter((t) => (!finished(t.status) || keep.includes(t.id as string)) && !chunks.some((c) => c.id === t.id)).map((t) => whole(t.id as string));
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
    // A text that only grew sends what it gained.
    const gain = (k: string) => (typeof prev?.[k] === "string" && (task[k] as string).startsWith(prev[k] as string) ? (task[k] as string).slice((prev[k] as string).length) : task[k]);
    const added = Object.fromEntries(CONTENT.filter((k) => task[k] && !same(k)).map((k) => [k, gain(k)]));
    if (id.startsWith("thought")) return emit([update(id, task as { title: string; status: string }, added)]);
    let r = runOf.get(id);
    if (!r) {
      r = current ??= runs[runs.push({ n: runs.length + 1, tools: [], closed: false }) - 1];
      r.tools.push(id);
      runOf.set(id, r);
    }
    return show(r, id, added);
  }

  // A run's cards as they stand, with what tool `id` added to its own.
  function show(r: Run, id?: string, added: Record<string, unknown> = {}) {
    const a = update(`a${r.n}`, head(r), !r.closed && r.tools.length === 1 ? added : {});
    if (r.tools.length < 2) return emit([a]);
    const last = r.tools.at(-1)!;
    const b = update(`b${r.n}`, now(r), !r.closed && id === last ? headed(`b${r.n}`, last, added) : {});
    return emit([a, b]);
  }
  // The first card's title and status: its tool alone and running, else the count of those before the running one.
  function head(r: Run) {
    if (!r.closed && r.tools.length === 1) return now(r);
    const counted = r.closed ? r.tools : r.tools.slice(0, -1);
    const states = counted.map((t) => tasks.get(t)!.status);
    const failed = states.filter((x) => x === "error").length;
    const title = `🔧 ${counted.length} tool${counted.length === 1 ? "" : "s"} used${failed ? ` · ${failed} failed` : ""}`;
    return { title, status: states.every(finished) ? "complete" : "in_progress" };
  }
  // The running tool's title and status; closed, its card is done (and goes when the message is rewritten).
  function now(r: Run) {
    const t = tasks.get(r.tools.at(-1)!)!;
    return { title: t.title as string, status: r.closed ? "complete" : (t.status as string) };
  }
  // What a tool adds to the running-tool card, the first part of each field under the tool's title.
  function headed(card: string, tool: string, added: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(added)) {
      if (k === "sources") {
        out[k] = v;
        continue;
      }
      const gap = filled.has(`${card}:${k}`) ? "\n" : "";
      const title = filled.has(`${card}:${tool}:${k}`) ? "" : `── ${tasks.get(tool)!.title}\n`;
      filled.add(`${card}:${k}`).add(`${card}:${tool}:${k}`);
      out[k] = `${gap}${title}${v}`;
    }
    return out;
  }
  // A card's update, or null when it shows nothing new.
  function update(card: string, state: { title: string; status: string }, content: Record<string, unknown>): Chunk | null {
    const was = queued.get(card);
    if (was?.title === state.title && was.status === state.status && !Object.keys(content).length) return null;
    queued.set(card, { title: state.title, status: state.status });
    return { type: "task_update", id: card, title: state.title, status: state.status, ...content };
  }
  function emit(updates: (Chunk | null)[]) {
    const chunks = updates.filter((c) => c !== null);
    if (!chunks.length) return chain;
    return run(async () => {
      if (suspended) return void chunks.forEach((c) => held.add(c.id as string));
      await flush();
      await send(chunks);
    });
  }
  // A card whole, for a message that has not shown it.
  function whole(card: string): Chunk {
    if (card.startsWith("thought")) return { ...tasks.get(card)!, id: card };
    const r = runs[Number(card.slice(1)) - 1];
    const b = card[0] === "b";
    const tool = b ? r.tools.at(-1)! : r.tools[0];
    const t = tasks.get(tool)!;
    const shows = !r.closed && (b || r.tools.length === 1);
    const content = Object.fromEntries((shows ? CONTENT : []).filter((k) => t[k]).map((k) => [k, b && k !== "sources" ? `── ${t.title}\n${t[k]}` : t[k]]));
    if (b) for (const k of Object.keys(content)) filled.add(`${card}:${k}`).add(`${card}:${tool}:${k}`);
    return { type: "task_update", id: card, ...(b ? now(r) : head(r)), ...content };
  }
  // The held cards, whole: the message they go to has not shown them yet.
  async function release() {
    const cards = [...held].map(whole);
    held.clear();
    if (cards.length) await send(cards);
  }
  // Text, or the turn's end, closes the run: its first card counts all its tools.
  function close() {
    const r = current;
    if (!r) return;
    current = null;
    r.closed = true;
    void show(r);
  }

  // The model's thinking between two texts is one folded card: it runs while the model thinks, and each stretch's
  // end goes into it when a tool or text follows (two appends a stretch, not one per chunk).
  function endThought() {
    if (!thinking) return;
    const { id, text } = thinking;
    thinking = null;
    const tail = text.trim().replaceAll("\`\`\`", "ˋˋˋ");
    const before = tasks.get(id)?.output as string | undefined;
    const add = tail.length > OUTPUT_MAX ? `…${tail.slice(-(OUTPUT_MAX - 1))}` : tail;
    void tool(id, { status: "completed", ...((add || before) && { output: before && add ? `${before}\n\n${add}` : before || add }) });
  }

  return {
    begin: () => {
      refresh = setInterval(() => !suspended && run(() => status("processing")), opts.statusRefreshMs ?? STATUS_REFRESH_MS);
      return run(() => status("processing", opts.title ? { title: opts.title.slice(0, 200) } : {}));
    },
    text(s: string) {
      if (s.trim()) {
        endThought();
        close();
        texts++;
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
      thinking = { id: `thought${texts}`, text: s };
      void tool(thinking.id, { title: "Thinking", status: "in_progress" });
    },
    tool,
    /** True when the turn has no reply text yet, or none after its last tool call. */
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
      close();
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
