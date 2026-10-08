import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutput, describeTool, splitMarkdown } from "../src/output.ts";

function fakeApi(fail: Record<string, string> = {}) {
  const calls: { method: string; params: any }[] = [];
  let n = 0;
  const api = async (method: string, params: any) => {
    calls.push({ method, params });
    if (fail[method]) throw new Error(`An API error occurred: ${fail[method]}`);
    return { ok: true, ts: `9.${++n}` };
  };
  return { api, calls };
}
const where = { channel: "D1", thread: "1.0" };
const chunks = (calls: { params: any }[]) => calls.flatMap((c) => c.params.chunks ?? []);

test("splitMarkdown keeps every part under the limit with balanced code fences", () => {
  const text = "intro\n```ts\n" + "const x = 1;\n".repeat(20) + "```\nend";
  const parts = splitMarkdown(text, 80);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.length <= 80, `part of ${p.length}`);
    assert.equal((p.match(/^```/gm) ?? []).length % 2, 0, p);
  }
  assert.equal(parts.join("\n").split("const x = 1;").length - 1, 20);
});

test("a turn streams text and tool cards into one message, then stops the stream", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where, { title: "repo: fix the bug" });
  await out.begin();
  out.text("On it, ");
  out.text("checking.");
  await out.tool("t0", { title: "ls", status: "pending" });
  await out.tool("t0", { status: "completed" });
  out.text("Done.");
  await out.end();
  assert.deepEqual(calls.map((c) => c.method), [
    "agents.sessions.setStatus", "chat.startStream", "chat.appendStream", "chat.appendStream", "chat.appendStream", "chat.stopStream",
  ]);
  assert.deepEqual(calls[0].params, { channel_id: "D1", thread_ts: "1.0", status: "processing", title: "repo: fix the bug" });
  assert.equal(chunks(calls).filter((c: any) => c.type === "markdown_text").map((c: any) => c.text).join(""), "On it, checking.\n\nDone.");
  assert.deepEqual(chunks(calls).filter((c: any) => c.type === "task_update").map((c: any) => [c.title, c.status]), [["ls", "pending"], ["ls", "complete"]]);
});

test("when streaming is refused the turn goes out as one message per text segment", async () => {
  const { api, calls } = fakeApi({ "chat.startStream": "ratelimited" });
  const out = createOutput(api, where);
  await out.begin();
  out.text("On it, checking.");
  await out.tool("t0", { title: "ls", status: "in_progress" });
  out.text("Done.");
  await out.end();
  assert.deepEqual(calls.filter((c) => c.method === "chat.postMessage").map((c) => c.params.markdown_text), ["On it, checking.", "Done."]);
  assert.equal(calls.at(-1)!.method, "agents.sessions.setStatus");
  assert.equal(calls.at(-1)!.params.status, "active");
});

test("long text without streaming is split to Slack's limit", async () => {
  const { api, calls } = fakeApi({ "chat.startStream": "feature_not_enabled" });
  const out = createOutput(api, where);
  out.text("word ".repeat(6000)); // 30k chars
  await out.end();
  const posts = calls.filter((c) => c.method === "chat.postMessage");
  assert.equal(posts.length, 3);
  assert.ok(posts.every((p) => p.params.markdown_text.length <= 12_000));
});

test("pause ends the stream and suspends the session; later text opens a new stream", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where);
  out.text("Need approval.");
  await out.pause();
  await out.resume();
  out.text("Approved, continuing.");
  await out.end();
  assert.deepEqual(calls.map((c) => c.method + (c.params.status ? `:${c.params.status}` : "")), [
    "chat.startStream", "chat.stopStream", "agents.sessions.setStatus:suspended",
    "agents.sessions.setStatus:processing", "chat.startStream", "chat.stopStream",
  ]);
});

test("task cards get short ids and repeated identical updates are not sent", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where);
  const long = "call_239715__thought__" + "AY89a1+PJ/".repeat(15);
  await out.tool(long, { title: "ls -la", status: "in_progress" });
  await out.tool(long, { title: "ls -la", status: "in_progress" });
  await out.tool(long, { status: "completed" });
  await out.end();
  const tasks = chunks(calls).filter((c: any) => c.type === "task_update");
  assert.deepEqual(tasks.map((c: any) => [c.id, c.status]), [["t1", "in_progress"], ["t1", "complete"]]);
});

test("describeTool turns opencode's tool updates into card title, details and output", () => {
  const cwd = "/w/proj";
  // Shapes recorded from opencode 2.0.24 over ACP.
  const read = describeTool({ title: "read", status: "completed", locations: [{ path: "/w/proj/calc.py" }], content: [{ type: "content", content: { type: "text", text: "1: def add(a, b):" } }] }, { path: "calc.py" }, cwd);
  assert.deepEqual(read, { title: "read calc.py", status: "completed", output: "```\n1: def add(a, b):\n```" });
  const edit = describeTool({ title: "edit", status: "completed", content: [{ type: "content", content: { type: "text", text: "Edited calc.py" } }, { type: "diff", path: "/w/proj/calc.py", oldText: "    return a - b", newText: "    return a + b\n" }] }, { path: "calc.py", oldString: "x", newString: "y" }, cwd);
  assert.deepEqual(edit, { title: "edit calc.py", status: "completed", output: "calc.py  +2 −1\n```diff\n-    return a - b\n+    return a + b\n+\n```" });
  const shell = describeTool({ title: "python3 t.py", status: "completed", rawOutput: { metadata: { exit: 1 } }, content: [{ type: "content", content: { type: "text", text: "Traceback" } }] }, { command: "python3 t.py", cwd }, cwd);
  assert.deepEqual(shell, { title: "python3 t.py", status: "completed", output: "exit 1\n```\nTraceback\n```" });
  assert.equal(describeTool({ status: "completed" }, { command: "ls" }, cwd).title, "ls"); // the final update carries no title
  const pending = describeTool({ title: "shell", kind: "execute", status: "pending", locations: [{ path: cwd }] }, { cwd }, cwd);
  assert.deepEqual(pending, { title: "shell", status: "pending" }); // not "shell /w/proj"
  const grep = describeTool({ title: "grep", kind: "search", status: "pending" }, { pattern: "TODO", path: "/w/proj/src" }, cwd);
  assert.deepEqual(grep, { title: "grep src", status: "pending", details: "TODO in src" });
  const long = describeTool({ title: "t", status: "completed", content: [{ type: "content", content: { type: "text", text: "z".repeat(2000) } }] }, {}, cwd).output!;
  assert.ok(long.length <= 500 && long.endsWith("…\n```"), "clipped inside a closed fence");
});

test("a card's details and output reach the stream, and a repeated identical update is not resent", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where);
  await out.tool("x", { title: "shell", status: "pending", details: "$ ls" });
  await out.tool("x", { status: "completed", output: "a.txt" });
  await out.tool("x", { status: "completed", output: "a.txt" });
  await out.end();
  const tasks = chunks(calls).filter((c: any) => c.type === "task_update");
  assert.deepEqual(tasks.map((c: any) => [c.status, c.details, c.output]), [["pending", "$ ls", undefined], ["complete", "$ ls", "a.txt"]]);
});
