import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimiter } from "../src/limiter.ts";

// Fake upstream: records calls; `plan` returns HTTP statuses in order (default 200).
function fake(plan: number[] = [], delayMs = 0) {
  const calls: { method: string; params: any; at: number }[] = [];
  const call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params, at: Date.now() });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const status = plan.shift() ?? 200;
    return status === 429 ? { status, retryAfter: 0.05, body: { ok: false, error: "ratelimited" } } : { status, body: { ok: true } };
  };
  return { calls, call };
}

test("paces calls of a method to its rate", async () => {
  const f = fake();
  const slack = createLimiter(f.call, { rates: { "x.paced": 600 } }); // one per 100 ms
  await Promise.all([1, 2, 3].map(() => slack("x.paced", {})));
  const gaps = f.calls.slice(1).map((c, i) => c.at - f.calls[i].at);
  assert.ok(gaps.every((g) => g >= 90), `gaps ${gaps}`);
});

test("methods without a rate are not paced", async () => {
  const f = fake();
  const slack = createLimiter(f.call, { rates: {} });
  const t0 = Date.now();
  await Promise.all([1, 2, 3].map(() => slack("chat.update", {})));
  assert.ok(Date.now() - t0 < 50);
});

test("queued edits of one message merge into the latest", async () => {
  const f = fake([], 30);
  const slack = createLimiter(f.call, { rates: { "chat.update": 6000 } });
  const r = await Promise.all(["a", "b", "c"].map((text) => slack("chat.update", { channel: "D1", ts: "1.0", text })));
  assert.deepEqual(f.calls.map((c) => c.params.text), ["a", "c"]); // "a" was in flight; "b" was replaced by "c"
  assert.ok(r.every((x) => x.ok));
});

test("queued appends to one stream concatenate their chunks", async () => {
  const f = fake([], 30);
  const slack = createLimiter(f.call, { rates: { "chat.appendStream": 6000 } });
  const task = { type: "task_update", id: "t", title: "ls", status: "in_progress" };
  await Promise.all([
    slack("chat.appendStream", { channel: "D1", ts: "1.0", markdown_text: "one" }),
    slack("chat.appendStream", { channel: "D1", ts: "1.0", markdown_text: "two" }),
    slack("chat.appendStream", { channel: "D1", ts: "1.0", chunks: JSON.stringify([task]) }),
  ]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].params.chunks, [{ type: "markdown_text", text: "two" }, task]);
});

test("a 429 waits Retry-After and retries", async () => {
  const f = fake([429]);
  const slack = createLimiter(f.call, { rates: {} });
  assert.deepEqual(await slack("chat.postMessage", {}), { ok: true });
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].at - f.calls[0].at >= 45);
});

test("chat.startStream is refused, not queued, when the wait would be long", async () => {
  const f = fake();
  const slack = createLimiter(f.call, { rates: { "chat.startStream": 60 }, maxStreamStartWaitMs: 200 });
  const [a, b] = await Promise.all([slack("chat.startStream", {}), slack("chat.startStream", {})]);
  assert.deepEqual(a, { ok: true });
  assert.deepEqual(b, { ok: false, error: "ratelimited" });
  assert.equal(f.calls.length, 1);
});
