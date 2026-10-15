// Renders one agent turn into a Slack thread. With native streaming (chat.startStream),
// text grows in one message and each stretch (the model's thinking and the tools it calls between
// two texts) is one task card. If a stream cannot start or breaks (feature off, or the relay refusing
// it because the shared rate budget is spent), the rest of the turn goes out as plain messages, one per
// finished text segment (cut at tool calls), split to Slack's 12k limit. Above the reply box, the
// thread's status line says what the agent is doing ("Running npm test…") until the reply's text starts.

import { realpathSync } from "node:fs";

export const MAX_TEXT = 12_000;
// chat.appendStream is Tier 4 (100+/min) shared by every user: at most one append a second.
const FLUSH_MS = 1_000;
// Slack ends a stream after about 5 minutes; roll over to a new message before that.
const STREAM_MAX_AGE_MS = 240_000;
// Slack drops a session's "processing" status after an hour unless it is sent again.
const STATUS_REFRESH_MS = 30 * 60_000;

// task_update field limits, probed against Slack (2026-10-08): 800 chars of output passed, 1000 failed
// with msg_too_long; the margins are deliberate.
const TITLE_MAX = 200;
const OUTPUT_MAX = 500;

/** What a tool card shows. Missing fields keep their earlier value. */
export interface ToolInfo {
  title?: string;
  status?: string; // ACP: pending, in_progress, completed, failed
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
  const subject = path ? rel(path) : (i.url ?? i.description ?? i.id); // a subagent's task, a skill's name
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
  let status: string | undefined = u.status ?? undefined;
  // opencode reports a command that exits non-zero, or a tool error, as completed
  const exit = u.rawOutput?.metadata?.exit;
  if (u.status === "completed" && ((typeof exit === "number" && exit !== 0) || u.rawOutput?.metadata?.error === true)) status = "failed";
  return { ...(title && { title: clip(title, TITLE_MAX) }), ...(status && { status }) };
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

const USING = "Using tool: ";
const THOUGHT_MAX = 3_000; // a rewritten card's thinking; Slack took 24k characters in a chat.update (probed 2026-10-15)
const txt = (text: string, style?: Record<string, boolean>) => ({ type: "text", text, ...(style && { style }) });
// "**Heading**" in the model's thinking as bold text, the rest as typed.
const bold = (s: string) => s.split(/\*\*([^*\n]+)\*\*/).flatMap((p, i) => (p ? [txt(p, i % 2 ? { bold: true } : undefined)] : []));
const taskCard = (id: string, title: string, status: string, fields: Record<string, unknown>) => ({
  type: "task_card", task_id: id, title, status: status === "complete" ? "complete" : "in_progress", ...fields,
});
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// A stretch is the model's thinking and the tools it calls between two texts, or up to a question: card s<n> sums it
// up, and stays in the message that first showed it. The tool running now is in the status line, not in a card:
// a stream cannot remove a card, and one for the running tool stayed under the reply until the message stopped.
type Entry = { thought: string } | { tool: string };
type Stretch = { n: number; entries: Entry[]; tools: string[]; thought: boolean; thinkMs: number; closed: boolean; out: string; sent: number };

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
  let thinking: { text: string; heading: string; shown: number; since: number } | null = null; // the model's thinking since its last text or tool
  const stretches: Stretch[] = [];
  let current: Stretch | null = null; // the open stretch
  const stretchOf = new Map<string, Stretch>(); // ACP tool call id -> its stretch
  const tools = new Map<string, { title: string; status: string }>(); // ACP status: in_progress, completed, failed
  const queued = new Map<string, { title: string; status: string }>(); // card id -> its title and status last queued
  type Layout = ({ text: string } | { card: string })[];
  let layout: Layout = []; // the current stream message as sent, in order
  // The status line above the reply box: shown while the message has no text yet (Slack shows its own once text
  // streams), and only with the session "active", which an open stream needs after it starts (verified 2026-10-15).
  let line = "";
  let lineShown = "";
  const shownIn = new Map<string, string>(); // card id -> the message it is in
  const stopped = new Map<string, Layout>(); // earlier messages of the turn, by ts
  const rewritten = new Map<string, string>(); // message ts -> its blocks as last rewritten
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
    stopped.set(ts, layout);
    await api("chat.stopStream", { channel, ts, ...(blocks && { blocks }) }); // also sets the session back to active
    await rewrite(ts, layout, blocks);
  }

  const stretchOfCard = (card: string) => stretches[Number(card.slice(1)) - 1];
  const done = (t: string) => ["completed", "failed"].includes(tools.get(t)!.status);

  // What a stretch did, in order: each thought, and each run of tools as a list of their titles.
  function inside(s: Stretch) {
    const elements: any[] = [];
    for (const e of s.entries) {
      if ("thought" in e) elements.push({ type: "rich_text_section", elements: bold(clip(e.thought, THOUGHT_MAX)) });
      else {
        const t = tools.get(e.tool)!;
        const item = { type: "rich_text_section", elements: [txt(t.title, { code: true }), ...(t.status === "failed" ? [txt(" (failed)", { italic: true })] : [])] };
        const last = elements.at(-1);
        if (last?.type === "rich_text_list") last.elements.push(item);
        else elements.push({ type: "rich_text_list", style: "bullet", elements: [item] });
      }
    }
    return elements.length ? { output: { type: "rich_text", elements } } : {};
  }

  // A stopped message is sent again with each stretch as one card: its thinking and its tools inside, no running card.
  // ponytail: a rewrite Slack refuses (size, more than 50 blocks) leaves the message as streamed.
  async function rewrite(ts: string, lay: Layout, extra: unknown[] = []) {
    if (!lay.some((x) => "card" in x)) return;
    const blocks = lay.flatMap((x): unknown[] => {
      if ("text" in x) {
        const t = x.text.trim();
        return t ? [{ type: "markdown", text: openFence(x.text) ? `${t}\n\`\`\`` : t }] : [];
      }
      const s = stretchOfCard(x.card);
      const h = head(s);
      return [taskCard(x.card, h.title, h.status, inside(s))];
    });
    if (!blocks.length && !extra.length) return;
    const text = lay.map((x) => ("text" in x ? x.text : "")).join("").trim();
    const body = JSON.stringify([...blocks, ...extra]);
    if (rewritten.get(ts) === body) return;
    rewritten.set(ts, body);
    await api("chat.update", { channel, ts, text: text.slice(0, 3000) || "🔧", blocks: [...blocks, ...extra] })
      .catch((err) => log("rewrite_failed", { error: String(err) }));
  }

  // What the stream message got, in order, for its rewrite.
  function record(chunks: Chunk[]) {
    for (const c of chunks) {
      const last = layout.at(-1);
      if (c.type === "markdown_text") {
        if (last && "text" in last) last.text += c.text;
        else layout.push({ text: c.text as string });
      } else {
        if (!layout.some((x) => "card" in x && x.card === c.id)) layout.push({ card: c.id as string });
        if (stream) shownIn.set(c.id as string, stream.ts);
      }
    }
  }

  const textOf = (chunks: Chunk[]) => chunks.map((c) => (c.type === "markdown_text" ? c.text : "")).join("");

  // A card stays in the message that first showed it: a stopped one is rewritten as it now stands.
  const behind = (id: string) => {
    const ts = shownIn.get(id);
    return ts !== undefined && stopped.has(ts);
  };

  // A new stream message; before its text, the fence the last one left open. The session goes "active" for the
  // status line to show, and the line is set again: it belongs to the thread, not to a message.
  async function start(chunks: Chunk[]) {
    const r = await api("chat.startStream", { channel, ...(thread && { thread_ts: thread }), task_display_mode: "timeline", chunks });
    stream = { ts: r.ts, started: Date.now() };
    sent = "";
    layout = [];
    lineShown = "";
    await status("active");
  }
  // The status line as it should be now; Slack shows its own once the message has text.
  async function showLine() {
    const want = stream && !sent.trim() ? line : "";
    if (want === lineShown || (!want && !lineShown && !stream)) return;
    lineShown = want;
    await api("assistant.threads.setStatus", { channel_id: channel, thread_ts: thread, status: want, ...(want && { loading_messages: [want] }) })
      .catch((err) => log("line_failed", { error: String(err) }));
  }

  // Ends the stream message for a new one to go on; a fence left open is closed when the message still takes it.
  async function roll(close: boolean) {
    const fence = openFence(sent);
    if (fence && close && stream) await api("chat.appendStream", { channel, ts: stream.ts, chunks: [{ type: "markdown_text", text: "\n```" }] }).then(() => record([{ type: "markdown_text", text: "\n```" }]), () => {});
    await stopStream();
    reopen = fence;
  }

  async function send(chunks: Chunk[]): Promise<boolean> {
    if (!streaming) return false;
    try {
      if (stream && Date.now() - stream.started > STREAM_MAX_AGE_MS) await roll(true);
      // A card left in an earlier message is not shown again here: that message is rewritten as it now stands.
      // The fence the last message left open is reopened before the first text of this one, not before its cards.
      const drop = async () => {
        const stale = new Set(chunks.filter((c) => behind(c.id as string)).map((c) => shownIn.get(c.id as string)!));
        for (const ts of stale) await rewrite(ts, stopped.get(ts)!);
        chunks = chunks.filter((c) => !behind(c.id as string));
        const at = chunks.findIndex((c) => c.type === "markdown_text");
        if (reopen && at >= 0) {
          chunks = [...chunks.slice(0, at), { type: "markdown_text", text: `${reopen}\n` }, ...chunks.slice(at)];
          reopen = "";
        }
      };
      await drop();
      if (stream && chunks.length) {
        try {
          await api("chat.appendStream", { channel, ts: stream.ts, chunks });
        } catch (err) {
          // A message full to Slack's size limit: the turn goes on in a new one.
          if (!String(err).includes("msg_too_long")) throw err;
          await roll(false);
          await drop();
          if (chunks.length) await start(chunks);
        }
      } else if (chunks.length) {
        await start(chunks);
      }
      sent += textOf(chunks);
      record(chunks);
      await showLine();
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

  // The text pending now, taken: what comes after it waits for its turn.
  function take() {
    clearTimeout(timer);
    timer = undefined;
    const text = pending;
    pending = "";
    return text;
  }
  const flush = () => put(take());
  async function put(text: string) {
    if (!text.trim()) return;
    const pieces = text.match(/[\s\S]{1,12000}/g)!;
    if (await send(pieces.map((t) => ({ type: "markdown_text", text: t })))) return;
    // Plain messages from here; the first one reopens a fence the stream left open.
    const body = reopen ? `${reopen}\n${text.replace(/^\n+/, "")}` : text.trim();
    reopen = "";
    for (const part of splitMarkdown(body)) await api("chat.postMessage", { channel, thread_ts: thread, markdown_text: part });
  }

  function tool(id: string, info: ToolInfo) {
    endThought();
    const prev = tools.get(id);
    const next = {
      title: clip(info.title ?? prev?.title ?? "tool", TITLE_MAX - USING.length),
      status: info.status ? (info.status === "pending" ? "in_progress" : info.status) : (prev?.status ?? "in_progress"),
    };
    // Agents repeat unchanged updates; each would cost an append from the shared budget.
    if (prev && prev.title === next.title && prev.status === next.status) return chain;
    tools.set(id, next);
    afterTool = true;
    quiet = true;
    let s = stretchOf.get(id);
    if (!s) {
      s = current ??= newStretch();
      s.tools.push(id);
      s.entries.push({ tool: id });
      stretchOf.set(id, s);
    }
    const cs = cards(s);
    if (s.closed) {
      // Its message may have stopped already: it is rewritten with the tool as it now stands.
      const ts = shownIn.get(`s${s.n}`);
      if (ts && stopped.has(ts)) run(() => rewrite(ts, stopped.get(ts)!));
    }
    if (!s.closed) say(done(id) ? "" : `Running ${next.title}…`);
    return emit(cs);
  }

  function newStretch() {
    const s: Stretch = { n: stretches.length + 1, entries: [], tools: [], thought: false, thinkMs: 0, closed: false, out: "", sent: 0 };
    stretches.push(s);
    return s;
  }

  // The summary card: thinking now; the one tool of a stretch without thinking; else what the stretch did, counting
  // the tools before the one running. It spins until the stretch ends.
  function head(s: Stretch) {
    const status = s.closed ? "complete" : "in_progress";
    if (thinking && s === current) return { title: clip(thinking.heading ? `Thinking · ${thinking.heading}` : "Thinking…", TITLE_MAX), status };
    if (!s.thought && !s.closed && s.tools.length === 1) return { title: clip(`${USING}${tools.get(s.tools[0])!.title}`, TITLE_MAX), status };
    const running = s.closed ? undefined : s.tools.find((t) => !done(t));
    const counted = s.tools.filter((t) => t !== running);
    const failed = counted.filter((t) => tools.get(t)!.status === "failed").length;
    const parts = [s.thought ? `Thought for ${Math.max(1, Math.round(s.thinkMs / 1000))}s` : "", counted.length ? `${plural(counted.length, "tool")} used` : "", failed ? `${failed} failed` : ""].filter(Boolean);
    return { title: parts.join(" · ") || "Thinking…", status };
  }
  // The stretch's card as it stands.
  function cards(s: Stretch) {
    const out = s.out.slice(s.sent); // Slack appends a card's output to what it shows: send only the new part
    s.sent = s.out.length;
    return [update(`s${s.n}`, head(s), out ? { output: out } : {})];
  }
  // What the status line should say: set now, shown when the stream allows it.
  function say(text: string) {
    line = clip(text, TITLE_MAX);
    run(showLine);
  }
  // A card's update, or null when it shows nothing new.
  function update(card: string, state: { title: string; status: string }, content: Record<string, unknown>): Chunk | null {
    const was = queued.get(card);
    if (was?.title === state.title && was.status === state.status && !Object.keys(content).length) return null;
    queued.set(card, { title: state.title, status: state.status });
    return { type: "task_update", id: card, title: state.title, status: state.status, ...content };
  }
  // The text before the cards goes first: the text pending when they are queued (or `before`), not when they go out,
  // or text that came meanwhile would jump ahead of them.
  function emit(updates: (Chunk | null)[], before?: string) {
    const chunks = updates.filter((c) => c !== null);
    const text = before ?? take();
    if (!chunks.length) return text ? run(() => put(text)) : chain;
    return run(async () => {
      if (suspended) {
        pending = text + pending; // nothing goes out under a question
        return void chunks.forEach((c) => held.add(c.id as string));
      }
      await put(text);
      await send(chunks);
    });
  }
  // A card whole, for a message that has not shown it.
  function whole(card: string): Chunk {
    const s = stretchOfCard(card);
    s.sent = s.out.length;
    const { title, status } = head(s);
    return { type: "task_update", id: card, title, status, ...(s.out && { output: s.out }) };
  }
  // The held cards, whole: the message they go to has not shown them yet.
  async function release() {
    const cards = [...held].map(whole);
    held.clear();
    if (cards.length) await send(cards);
  }
  // Text, a question or the turn's end closes the stretch: its summary counts all its tools, before the text that follows.
  function close() {
    endThought();
    const s = current;
    if (!s) return;
    current = null;
    s.closed = true;
    say("");
    const before = pending;
    pending = "";
    void emit(cards(s), before);
  }

  // The model's thinking joins its stretch: the card follows the heading it is on while it thinks, and when a tool
  // or text follows, the thinking's tail goes into the card's output (two updates, not one per chunk).
  function endThought() {
    if (!thinking || !current) return false;
    const { text, since } = thinking;
    thinking = null;
    current.thinkMs += Date.now() - since;
    const body = text.trim();
    if (body) {
      current.entries.push({ thought: body });
      const tail = body.replaceAll("\`\`\`", "ˋˋˋ");
      current.out += `${current.out ? "\n\n" : ""}${tail.length > OUTPUT_MAX ? `…${tail.slice(-(OUTPUT_MAX - 1))}` : tail}`;
    }
    return true;
  }

  return {
    begin: () => {
      refresh = setInterval(() => !suspended && run(() => status("processing")), opts.statusRefreshMs ?? STATUS_REFRESH_MS);
      return run(() => status("processing", opts.title ? { title: opts.title.slice(0, 200) } : {}));
    },
    text(s: string) {
      if (s.trim()) {
        close();
        quiet = false;
      }
      if (afterTool) {
        s = `\n\n${s}`;
        afterTool = false;
      }
      pending += s;
      if (streaming && !timer) timer = setTimeout(() => run(flush), FLUSH_MS);
    },
    // While the model thinks, its card's title follows the heading it is on ("**Planning the Steps**", as Gemini
    // writes them), at most once a second.
    thought(s: string) {
      if (!thinking) {
        const st = (current ??= newStretch());
        st.thought = true;
        thinking = { text: "", heading: "", shown: -Infinity, since: Date.now() }; // its first heading shows at once
        afterTool = true;
        quiet = true;
        say("Thinking…");
        void emit(cards(st));
      }
      thinking.text += s;
      const heading = [...thinking.text.matchAll(/\*\*([^*\n]+)\*\*/g)].at(-1)?.[1].trim() ?? "";
      if (heading && heading !== thinking.heading && Date.now() - thinking.shown >= FLUSH_MS) {
        Object.assign(thinking, { heading, shown: Date.now() });
        say(`Thinking · ${heading}…`);
        void emit(cards(current!));
      }
    },
    tool,
    /** True when the turn has no reply text yet, or none after its last tool call. */
    get quiet() {
      return quiet;
    },
    /** Before posting buttons (blocks only go out when a stream stops). A question ends the stretch like text does. */
    pause: () => {
      close();
      return run(async () => {
        suspended = true;
        await flush();
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
      close();
      suspended = false;
      return run(async () => {
        await release();
        await flush();
        line = "";
        await showLine();
        if (stream) await stopStream(blocks).catch(() => status("active"));
        else await status("active");
      });
    },
  };
}

export type Output = ReturnType<typeof createOutput>;
