// Shared Slack Web API budget. Every daemon behind the relay shares the app's per-method
// rate limits (per method, per workspace, per app), so upstream calls queue per method,
// paced to the method's tier. A 429 pauses the method for Retry-After and retries. Queued
// chat.update / chat.appendStream calls for the same message merge. chat.startStream is
// refused when the wait would be long, so the daemon streams nothing and falls back to
// plain messages for that turn.

export type UpstreamCall = (
  method: string,
  params: Record<string, unknown>,
) => Promise<{ status: number; retryAfter?: number; body: any }>;

/** Calls per minute: Slack's documented tier floors. Methods not listed are not paced. */
export const RATES: Record<string, number> = {
  "chat.startStream": 20,
  "chat.stopStream": 20,
  "chat.appendStream": 100,
  "chat.update": 50,
  "chat.delete": 50,
  "reactions.add": 50,
  "reactions.remove": 50,
  "agents.sessions.setStatus": 50,
  "agents.sessions.rename": 50, // tier not documented; assume Tier 3
};

export interface LimiterOptions {
  /** Replaces RATES (calls per minute). {} disables pacing; 429s are still retried. */
  rates?: Record<string, number>;
  /** chat.startStream is refused when it would wait longer than this. Default 2 s. */
  maxStreamStartWaitMs?: number;
  /** Retries after a 429. Default 3. */
  maxRetries?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

interface Job {
  params: Record<string, any>;
  waiters: ((body: any) => void)[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chunksOf = (p: Record<string, any>): unknown[] =>
  p.chunks === undefined
    ? [{ type: "markdown_text", text: p.markdown_text ?? "" }]
    : typeof p.chunks === "string" ? JSON.parse(p.chunks) : p.chunks;

export function createLimiter(call: UpstreamCall, opts: LimiterOptions = {}) {
  const rates = opts.rates ?? RATES;
  const maxStartWait = opts.maxStreamStartWaitMs ?? 2000;
  const maxRetries = opts.maxRetries ?? 3;
  const log = opts.log ?? (() => {});
  const lanes = new Map<string, { queue: Job[]; next: number; busy: boolean }>();

  async function send(method: string, params: Record<string, unknown>) {
    for (let attempt = 0; ; attempt++) {
      const r = await call(method, params);
      if (r.status !== 429) return r.body;
      const waitMs = (r.retryAfter ?? 1) * 1000;
      log("ratelimited", { method, wait_ms: waitMs, attempt });
      const lane = lanes.get(method);
      if (lane) lane.next = Math.max(lane.next, Date.now() + waitMs);
      if (attempt >= maxRetries) return { ok: false, error: "ratelimited" };
      await sleep(waitMs);
    }
  }

  async function drain(method: string, lane: { queue: Job[]; next: number; busy: boolean }) {
    lane.busy = true;
    while (lane.queue.length) {
      const wait = lane.next - Date.now();
      if (wait > 0) await sleep(wait);
      const job = lane.queue.shift()!;
      lane.next = Date.now() + 60_000 / rates[method];
      const body = await send(method, job.params).catch((err) => ({ ok: false, error: String(err) }));
      for (const w of job.waiters) w(body);
    }
    lane.busy = false;
  }

  // Merge into a queued (not yet sent) call for the same message.
  function merge(queue: Job[], method: string, params: Record<string, any>, waiter: (body: any) => void) {
    if (method !== "chat.update" && method !== "chat.appendStream") return false;
    const job = queue.find((j) => j.params.channel === params.channel && j.params.ts === params.ts);
    if (!job) return false;
    job.params =
      method === "chat.update"
        ? params
        : { ...job.params, markdown_text: undefined, chunks: [...chunksOf(job.params), ...chunksOf(params)] };
    job.waiters.push(waiter);
    return true;
  }

  return function limited(method: string, params: Record<string, unknown>): Promise<any> {
    const rate = rates[method];
    if (!rate) return send(method, params);
    let lane = lanes.get(method);
    if (!lane) lanes.set(method, (lane = { queue: [], next: 0, busy: false }));
    const wait = Math.max(0, lane.next - Date.now()) + (lane.queue.length * 60_000) / rate;
    if (method === "chat.startStream" && wait > maxStartWait) {
      log("stream_refused", { wait_ms: Math.round(wait) });
      return Promise.resolve({ ok: false, error: "ratelimited" });
    }
    return new Promise((resolve) => {
      if (!merge(lane.queue, method, params, resolve)) lane.queue.push({ params, waiters: [resolve] });
      if (!lane.busy) void drain(method, lane);
    });
  };
}
