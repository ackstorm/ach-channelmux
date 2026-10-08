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
const TASK_STATUS: Record<string, string> = { pending: "pending", in_progress: "in_progress", completed: "complete", failed: "error" };

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

export function createOutput(api: Api, where: { channel: string; thread: string }, opts: { title?: string; log?: Log } = {}) {
  const log = opts.log ?? (() => {});
  const { channel, thread } = where;
  let streaming = true; // until a stream call fails, for the rest of this turn
  let stream: { ts: string; started: number } | null = null;
  let pending = "";
  let afterTool = false;
  let quiet = false; // a tool ran and no text has come since
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tasks = new Map<string, Chunk>(); // ACP tool call id -> last known card, for tool()'s prev lookup
  const sentTasks = new Map<string, Chunk>(); // last status actually delivered; replayed into a rolled-over stream
  let chain: Promise<unknown> = Promise.resolve();
  const run = (fn: () => Promise<unknown>) =>
    (chain = chain.then(fn).catch((err) => log("output_failed", { error: String(err) })));
  const status = (s: string, extra: Record<string, unknown> = {}) =>
    api("agents.sessions.setStatus", { channel_id: channel, thread_ts: thread, status: s, ...extra }).catch((err) =>
      log("status_failed", { status: s, error: String(err) }),
    );

  async function stopStream() {
    if (!stream) return;
    const ts = stream.ts;
    stream = null;
    await api("chat.stopStream", { channel, ts }); // also sets the session back to active
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

  return {
    begin: () => run(() => status("processing", opts.title ? { title: opts.title.slice(0, 200) } : {})),
    text(s: string) {
      if (s.trim()) quiet = false;
      if (afterTool) {
        s = `\n\n${s}`;
        afterTool = false;
      }
      pending += s;
      if (streaming && !timer) timer = setTimeout(() => run(flush), FLUSH_MS);
    },
    tool(id: string, title: string | undefined, acpStatus: string | undefined) {
      const prev = tasks.get(id);
      const task: Chunk = {
        type: "task_update",
        // ACP ids can be long (opencode's run ~150 chars with + and /); Slack only needs them unique per message.
        id: prev?.id ?? `t${tasks.size + 1}`,
        title: String(title ?? prev?.title ?? "tool").slice(0, 256),
        status: TASK_STATUS[acpStatus ?? ""] ?? prev?.status ?? "in_progress",
      };
      // Agents repeat unchanged updates; each would cost an append from the shared budget.
      if (prev && prev.title === task.title && prev.status === task.status) return chain;
      tasks.set(id, task);
      afterTool = true;
      quiet = true;
      return run(async () => {
        await flush();
        await send([task]);
      });
    },
    /** True when the turn's last output was a tool call, with no reply after it. */
    get quiet() {
      return quiet;
    },
    /** Before posting buttons (blocks only go out when a stream stops). */
    pause: () =>
      run(async () => {
        await flush();
        await stopStream().catch(() => {});
        await status("suspended");
      }),
    resume: () => run(() => status("processing")),
    end: () =>
      run(async () => {
        await flush();
        if (stream) await stopStream().catch(() => status("active"));
        else await status("active");
      }),
  };
}

export type Output = ReturnType<typeof createOutput>;
