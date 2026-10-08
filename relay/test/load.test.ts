// Load: 200 daemons share one Slack app. Mock Slack enforces per-method windows; the relay
// must pace, merge and refuse so that daemons never see a rate-limit error on posts and edits.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createGateway } from "../src/gateway.ts";
import { createMockSlack, APP_TOKEN, BOT_TOKEN } from "./mock-slack.ts";

const N = 200;
const slack = createMockSlack(Object.fromEntries(Array.from({ length: N }, (_, i) => [`U${i}`, `u${i}@example.com`])));
slack.limits = { "chat.update": { max: 50, windowMs: 1000 }, "chat.startStream": { max: 5, windowMs: 1000 } };
const PORT = await new Promise<number>((r) => {
  const s = createServer().listen(0, () => {
    const p = (s.address() as any).port;
    s.close(() => r(p));
  });
});
const GW = `http://127.0.0.1:${PORT}`;
let gw: ReturnType<typeof createGateway>;

before(async () => {
  await slack.start();
  gw = createGateway({
    port: PORT,
    publicUrl: GW,
    upstreamApiUrl: `${slack.url}/api/`,
    appToken: APP_TOKEN,
    botToken: BOT_TOKEN,
    resolveToken: async (t) => (t.startsWith("tok-") ? `u${t.slice(4)}@example.com` : null),
    rates: { "chat.update": 2400, "chat.startStream": 240 }, // 40/s and 4/s, under the mock's windows
    maxStreamStartWaitMs: 500,
    workingNoticeMs: 0,
    log: () => {},
  });
  await gw.start();
});
after(async () => {
  await gw.stop();
  await slack.stop();
});

const api = async (i: number, method: string, params: Record<string, string>) =>
  (
    await fetch(`${GW}/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer tok-${i}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    })
  ).json();

test("200 daemons posting, editing and streaming at once stay within Slack's limits", { timeout: 60_000 }, async () => {
  const results = await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const channel = `D_U${i}`;
      const post = await api(i, "chat.postMessage", { channel, text: "working" });
      const edits = await Promise.all([1, 2, 3, 4, 5].map((n) => api(i, "chat.update", { channel, ts: post.ts, text: `step ${n}` })));
      const stream = await api(i, "chat.startStream", { channel, thread_ts: post.ts, markdown_text: "hi" });
      return { post, edits, stream };
    }),
  );
  assert.ok(results.every((r) => r.post.ok && r.edits.every((e: any) => e.ok)), "every post and edit succeeded");
  const updates = slack.calls.filter((c) => c.method === "chat.update").length;
  assert.ok(updates < (N * 5) / 2, `${updates} chat.update calls reached Slack (merging)`);
  const refused = results.filter((r) => !r.stream.ok);
  assert.ok(refused.length > 0 && refused.every((r) => r.stream.error === "ratelimited"), "excess streams refused fast");
  assert.equal(slack.rateLimited, 0, "the relay never exceeded Slack's limits");
});
