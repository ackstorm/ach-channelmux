import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changed, createOutput, describePermission, describeTool, fullDiff, splitMarkdown } from "../src/output.ts";
import { WORKING } from "../src/working.ts";

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
  assert.deepEqual(calls.map((c) => c.method + (c.params.status ? `:${c.params.status}` : "")), [
    "agents.sessions.setStatus:processing", "chat.startStream", "agents.sessions.setStatus:active", // active: our status line shows, not Slack's
    "chat.appendStream", "chat.appendStream", "chat.appendStream", "chat.appendStream", "chat.stopStream", "chat.update",
  ]); // the message has text from the start: no status line of ours
  assert.deepEqual(calls[0].params, { channel_id: "D1", thread_ts: "1.0", status: "processing", title: "repo: fix the bug" });
  assert.equal(chunks(calls).filter((c: any) => c.type === "markdown_text").map((c: any) => c.text).join(""), "On it, checking.\n\nDone.");
  assert.deepEqual(chunks(calls).filter((c: any) => c.type === "task_update").map((c: any) => [c.title, c.status, c.output]), [
    ["Using tool: ls", "complete", undefined], // never spinning: the status line says it runs
    ["Using tool: ls", "complete", "`ls`"], // done: it joins the card's details
    ["1 tool used", "complete", undefined],
  ]);
});

test("with a slow Slack, text that comes while cards wait does not jump ahead of them or of the text before them", async () => {
  const calls: { method: string; params: any }[] = [];
  let n = 0;
  const api = async (method: string, params: any) => {
    await new Promise((r) => setTimeout(r, 5));
    calls.push({ method, params });
    return { ok: true, ts: `9.${++n}` };
  };
  const out = createOutput(api, where);
  out.text("On it, checking.");
  void out.tool("t0", { title: "ls", status: "in_progress" });
  void out.tool("t0", { status: "completed" });
  out.text("Done.");
  await out.end();
  const order = calls.flatMap((c) => c.params.chunks ?? []).map((x: any) => (x.type === "markdown_text" ? x.text.trim() : x.title));
  assert.deepEqual(order, ["On it, checking.", "Using tool: ls", "Using tool: ls", "1 tool used", "Done."]);
});

test("blocks given to end() go under the streamed reply; without a stream there is nothing to attach them to", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where);
  await out.begin();
  out.text("Done.");
  await out.end([{ type: "context_actions", elements: [] }]);
  assert.deepEqual(calls.find((c) => c.method === "chat.stopStream")!.params.blocks, [{ type: "context_actions", elements: [] }]);
  const plain = fakeApi({ "chat.startStream": "ratelimited" });
  const out2 = createOutput(plain.api, where);
  await out2.begin();
  out2.text("Done.");
  await out2.end([{ type: "context_actions", elements: [] }]);
  assert.ok(plain.calls.every((c) => !c.params.blocks));
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
    "chat.startStream", "agents.sessions.setStatus:active", "chat.stopStream", "agents.sessions.setStatus:suspended",
    "agents.sessions.setStatus:processing", "chat.startStream", "agents.sessions.setStatus:active", "chat.stopStream",
  ]);
});

test("a question ends the stretch: its tool finishing after the answer updates the first message, not a new card", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where);
  await out.tool("q", { title: "slack.ask_user", status: "in_progress" });
  await out.pause();
  await out.resume();
  await out.tool("q", { status: "completed" });
  await out.tool("e", { title: "edit a.css", status: "completed" });
  out.text("Done.");
  await out.end();
  const first = calls.find((c) => c.method === "chat.stopStream")!.params.ts;
  assert.equal(calls.filter((c) => c.method === "chat.update" && c.params.ts === first).at(-1)!.params.blocks[0].title, "1 tool used");
  const second = calls.filter((c) => c.method === "chat.startStream")[1].params.chunks.map((c: any) => c.id);
  assert.ok(!second.includes("s1") && !second.includes("r1"), String(second));
});

test("a stretch is one card: thinking, then a count of the tools before the one running; finished tools join its details", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { api, calls } = fakeApi();
  const out = createOutput(api, where);
  out.thought("**Reading**\n\nThe user wants X.");
  t.mock.timers.tick(10_000);
  await out.tool("g", { title: "grep X", status: "in_progress" });
  await out.tool("g", { status: "completed" });
  await out.tool("l", { title: "ls", status: "in_progress" });
  await out.tool("l", { status: "failed" });
  out.text("Found it.");
  await out.tool("c", { title: "cat y", status: "completed" });
  out.text("Done.");
  await out.end();
  const titles = chunks(calls).filter((c: any) => c.type === "task_update").map((c: any) => `${c.id} ${c.title}:${c.status}${c.output ? ` + ${c.output.replaceAll("\n", "⏎")}` : ""}`);
  assert.deepEqual(titles, [
    "s1 Thought for 10s:complete + **Reading**⏎⏎The user wants X.", // no card while it thinks; grep runs: the status line names it
    "s1 Thought for 10s · 1 tool used:complete + ⏎`grep X`",
    "s1 Thought for 10s · 2 tools used · 1 failed:complete + ⏎`ls` _(failed)_", // never "error", never spinning
    "s2 Using tool: cat y:complete + `cat y`", // no thinking: the first tool is the card
    "s2 1 tool used:complete",
  ]);
});

test("a stopped message is rewritten with one card per stretch: its thinking in bold and code, a rule, then its tools", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where);
  out.thought("**Reading**\n\nThe user wants `x`.");
  await out.tool("g", { title: "grep X", status: "completed" });
  await out.tool("l", { title: "ls", status: "failed" });
  out.text("Done.");
  await out.end();
  const blocks = calls.at(-1)!.params.blocks;
  assert.deepEqual(blocks.map((b: any) => b.type), ["task_card", "markdown"]);
  assert.equal(blocks[0].status, "complete");
  assert.deepEqual(blocks[0].output.elements, [
    { type: "rich_text_section", elements: [{ type: "text", text: "Reading", style: { bold: true } }, { type: "text", text: "\n\nThe user wants " }, { type: "text", text: "x", style: { code: true } }, { type: "text", text: "." }] },
    { type: "rich_text_section", elements: [{ type: "text", text: "\n────────────\n" }] },
    { type: "rich_text_section", elements: [{ type: "text", text: "Used tools:", style: { bold: true } }, { type: "text", text: "\n" }] },
    { type: "rich_text_list", style: "bullet", elements: [
      { type: "rich_text_section", elements: [{ type: "text", text: "grep X", style: { code: true } }] },
      { type: "rich_text_section", elements: [{ type: "text", text: "ls", style: { code: true } }, { type: "text", text: " (failed)", style: { italic: true } }] },
    ] },
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
  assert.deepEqual(tasks.map((c: any) => [c.id, c.title, c.output]), [["s1", "Using tool: ls -la", undefined], ["s1", "Using tool: ls -la", "`ls -la`"], ["s1", "1 tool used", undefined]]);
});

test("describePermission says what the agent wants to do to what", () => {
  const cwd = "/w/app";
  // opencode's write: kind edit, the new content shown
  assert.equal(describePermission({ title: "notes.txt", kind: "edit" }, { path: "/w/app/notes.txt", content: "hello" }, cwd), "🔐 The agent wants to edit `notes.txt`\n```\nhello\n```");
  // a path outside the folder comes as kind "other"
  assert.equal(describePermission({ title: "/tmp/x.png", kind: "other" }, { path: "/tmp/x.png" }, cwd), "🔐 The agent wants to access `/tmp/x.png`");
  assert.equal(describePermission({ title: "calc.py", kind: "read" }, { filePath: "/w/app/calc.py" }, cwd), "🔐 The agent wants to read `calc.py`");
  // anything else: the tool's title and its input as JSON
  assert.equal(describePermission({ title: "todo", kind: "other" }, { items: 2 }, cwd), '🔐 The agent wants to use *todo*\n```\n{"items":2}\n```');
});

test("describeTool turns opencode's tool updates into card title and status", () => {
  const cwd = "/w/proj";
  // Shapes recorded from opencode 2.0.24 over ACP.
  const read = describeTool({ title: "read", status: "completed", locations: [{ path: "/w/proj/calc.py" }], content: [{ type: "content", content: { type: "text", text: "1: def add(a, b):" } }] }, { path: "calc.py" }, cwd);
  assert.deepEqual(read, { title: "read calc.py", status: "completed" });
  const edit = describeTool({ title: "edit", status: "completed", content: [{ type: "content", content: { type: "text", text: "Edited calc.py" } }, { type: "diff", path: "/w/proj/calc.py", oldText: "    return a - b", newText: "    return a + b\n" }] }, { path: "calc.py", oldString: "x", newString: "y" }, cwd);
  assert.deepEqual(edit, { title: "edit calc.py", status: "completed" });
  // opencode's write reports no diff: its input stands for one (a new file's lines).
  const write = { title: "write", kind: "edit", status: "completed", content: [{ type: "content", content: { type: "text", text: "Created file successfully: hello.txt" } }] };
  assert.equal(fullDiff(write, cwd, { filePath: "/w/proj/hello.txt", content: "hola\nadiós\n" }), "--- hello.txt\n+++ hello.txt\n@@ -1,0 +1,2 @@\n+hola\n+adiós");
  assert.equal(fullDiff({ ...write, status: "in_progress" }, cwd, { filePath: "/w/proj/hello.txt", content: "hola\n" }), undefined);
  const shell = describeTool({ title: "python3 t.py", status: "completed", rawOutput: { metadata: { exit: 1 } }, content: [{ type: "content", content: { type: "text", text: "Traceback" } }] }, { command: "python3 t.py", cwd }, cwd);
  assert.deepEqual(shell, { title: "python3 t.py", status: "failed" }); // exit 1
  assert.equal(describeTool({ status: "completed" }, { command: "ls" }, cwd).title, "ls"); // the final update carries no title
  const pending = describeTool({ title: "shell", kind: "execute", status: "pending", locations: [{ path: cwd }] }, { cwd }, cwd);
  assert.deepEqual(pending, { title: "shell", status: "pending" }); // not "shell /w/proj"
  const grep = describeTool({ title: "grep", kind: "search", status: "pending" }, { pattern: "TODO", path: "/w/proj/src" }, cwd);
  assert.deepEqual(grep, { title: "grep src", status: "pending" });
  // A subagent, the tools it runs, a skill, opencode's code tool.
  const meta = { "opencode/child-session": { id: "ses_c", title: "Count txt files" } };
  const sub = describeTool({ title: "subagent", kind: "think", status: "completed", content: [{ type: "content", content: { type: "text", text: '<subagent sessionID="ses_c" state="completed">\nThere are 2.\n</subagent>' } }] }, { agent: "general", description: "Count txt files", prompt: "..." }, cwd);
  assert.deepEqual(sub, { title: "subagent Count txt files", status: "completed" });
  assert.deepEqual(describeTool({ title: "Count txt files: glob", kind: "search", status: "pending", _meta: meta }, { pattern: "*.txt" }, cwd), { title: "↳ glob", status: "pending" });
  assert.equal(describeTool({ title: "Count txt files: read", kind: "read", status: "pending", _meta: meta }, { path: "a.txt" }, cwd).title, "↳ read a.txt");
  assert.equal(describeTool({ title: "skill", kind: "other", status: "pending" }, { id: "using-superpowers" }, cwd).title, "skill using-superpowers");
  const code = describeTool({ title: "execute", kind: "other", status: "completed", rawOutput: { metadata: { error: true } }, content: [{ type: "content", content: { type: "text", text: "Unknown tool" } }] }, { code: "await x()" }, cwd);
  assert.deepEqual(code, { title: "await x()", status: "failed" }); // a tool error; no tool called: its first line
  const calls = 'await tools.slack["send_voice"]({ text: "hi" })\nawait tools.github.list_issues({})\nawait tools.slack.send_voice({})';
  assert.deepEqual(describeTool({ title: "execute", kind: "other", status: "pending" }, { code: calls }, cwd), { title: "slack.send_voice, github.list_issues", status: "pending" });
  const fetch = describeTool({ title: "webfetch", kind: "fetch", status: "pending" }, { url: "https://example.com/a", format: "markdown" }, cwd);
  assert.deepEqual(fetch, { title: "webfetch https://example.com/a", status: "pending" });
  const heredoc = "cat << 'EOF' > f.py\ndef f():\n    return 1\nEOF";
  assert.deepEqual(describeTool({ title: "bash", kind: "execute", status: "pending" }, { command: heredoc, description: "Create f.py" }, cwd), { title: "Create f.py", status: "pending" });
  assert.equal(describeTool({ title: "bash", kind: "execute", status: "pending" }, { command: heredoc }, cwd).title, "cat << 'EOF' > f.py …");
});

test("a long turn sends its processing status again before Slack drops it", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where, { statusRefreshMs: 30 });
  await out.begin();
  await new Promise((r) => setTimeout(r, 100));
  await out.end();
  const n = calls.filter((c) => c.method === "agents.sessions.setStatus" && c.params.status === "processing").length;
  assert.ok(n >= 3, `processing sent ${n} times`);
});

test("an edit reported as the whole file before and after shows only the lines it changed, with 3 lines around", () => {
  const file = (mid: string) => ["a", "b", "c", mid, "e", "f"].join("\n") + "\n";
  assert.deepEqual(changed(file("d"), file("D")), { removed: ["d"], added: ["D"] });
  assert.deepEqual(changed(file("d"), file("d").replace("e\n", "e\nnew\n")), { removed: [], added: ["new"] });
  const edit = { title: "edit", status: "completed", content: [{ type: "diff", path: "/w/proj/x.js", oldText: file("d"), newText: file("D") }] };
  assert.equal(fullDiff(edit, "/w/proj"), "--- x.js\n+++ x.js\n@@ -1,6 +1,6 @@\n a\n b\n c\n-d\n+D\n e\n f");
});

test("changes far apart in one edit are two hunks, and only the changed lines count", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const after = lines.map((l, i) => (i === 2 ? "TWO" : i === 30 ? "THIRTY" : l));
  after.splice(20, 0, "inserted");
  const old = `${lines.join("\n")}\n`;
  const now = `${after.join("\n")}\n`;
  // The middle change is within twice the context of neither: three hunks, nothing in between them shown.
  assert.deepEqual(changed(old, now), { removed: ["line 2", "line 30"], added: ["TWO", "inserted", "THIRTY"] });
  const edit = { title: "edit", status: "completed", content: [{ type: "diff", path: "/w/x.js", oldText: old, newText: now }] };
  assert.equal(fullDiff(edit, "/w"), [
    "--- x.js", "+++ x.js",
    "@@ -1,6 +1,6 @@", " line 0", " line 1", "-line 2", "+TWO", " line 3", " line 4", " line 5",
    "@@ -18,6 +18,7 @@", " line 17", " line 18", " line 19", "+inserted", " line 20", " line 21", " line 22",
    "@@ -28,7 +29,7 @@", " line 27", " line 28", " line 29", "-line 30", "+THIRTY", " line 31", " line 32", " line 33",
  ].join("\n"));
});

test("a path the agent reports under the folder's real path (a symlink) is shown relative to the folder", () => {
  const base = mkdtempSync(join(tmpdir(), "output-test-"));
  mkdirSync(join(base, "real", "proj"), { recursive: true });
  symlinkSync(join(base, "real"), join(base, "link"));
  const cwd = join(base, "link", "proj");
  const edit = { title: "edit", status: "completed", content: [{ type: "diff", path: join(base, "real", "proj", "x.js"), oldText: "a\n", newText: "b\n" }] };
  assert.equal(fullDiff(edit, cwd), "--- x.js\n+++ x.js\n@@ -1,1 +1,1 @@\n-a\n+b");
});

// A fake Slack whose next appendStream answers with the given error once.
function failingOnce(error: string) {
  const calls: { method: string; params: any }[] = [];
  let n = 0;
  let fail = "";
  const api = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "chat.appendStream" && fail) {
      const e = fail;
      fail = "";
      throw new Error(`An API error occurred: ${e}`);
    }
    return { ok: true, ts: `9.${++n}` };
  };
  return { api, calls, failNext: () => (fail = error) };
}
const texts = (calls: { method: string; params: any }[], method: string) =>
  calls.filter((c) => c.method === method).map((c) => (c.params.chunks ?? []).filter((x: any) => x.type === "markdown_text").map((x: any) => x.text).join("") || c.params.markdown_text);

test("a stream message full to Slack's size limit goes on in a new one, reopening the code fence it was in", async () => {
  const { api, calls, failNext } = failingOnce("msg_too_long");
  const out = createOutput(api, where);
  await out.begin();
  out.text("The diff:\n\n```diff\n+a\n");
  await out.tool("t1", { title: "ls", status: "in_progress" }); // flushes the text into the stream
  failNext();
  out.text("+b\n```\nDone.");
  await out.end();
  assert.deepEqual(calls.map((c) => c.method).filter((m) => m.startsWith("chat.")), [
    "chat.startStream", "chat.appendStream", "chat.appendStream", "chat.stopStream", "chat.update", "chat.startStream", "chat.stopStream",
  ]);
  const second = calls.filter((c) => c.method === "chat.startStream")[1].params.chunks;
  assert.deepEqual(second.map((c: any) => c.type), ["markdown_text", "markdown_text"]); // text closed the run: its card stays above
  assert.equal(texts(calls, "chat.startStream")[1], "```diff\n\n\n+b\n```\nDone.");
});

test("a stream rolled over for its age closes an open code fence and the next message reopens it", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { api, calls } = fakeApi();
  const out = createOutput(api, where);
  await out.begin();
  out.text("```ts\nconst a = 1;\n");
  t.mock.timers.tick(1_000);
  await out.tool("t1", { title: "ls", status: "completed" });
  t.mock.timers.tick(300_000);
  out.text("const b = 2;\n```");
  await out.end();
  const streamed = calls.filter((c) => c.method === "chat.appendStream" || c.method === "chat.startStream").map((c) => c.params.chunks.filter((x: any) => x.type === "markdown_text").map((x: any) => x.text).join(""));
  assert.ok(streamed.includes("\n```"), "the old message's fence is closed");
  const second = calls.slice(calls.findLastIndex((c) => c.method === "chat.startStream"));
  assert.equal(texts(second, "chat.startStream")[0], "```ts\n\n\nconst b = 2;\n```"); // the stretch's card stays in the old message
});

test("when the stream breaks inside a code fence, the plain message that follows reopens it", async () => {
  const { api, calls, failNext } = failingOnce("ratelimited");
  const out = createOutput(api, where);
  await out.begin();
  out.text("```diff\n+a\n");
  await out.tool("t1", { title: "ls", status: "completed" });
  failNext();
  out.text("+b\n```");
  await out.end();
  assert.deepEqual(texts(calls, "chat.postMessage"), ["```diff\n+b\n```"]);
});

const lines = (calls: { method: string; params: any }[]) =>
  calls.filter((c) => c.method === "assistant.threads.setStatus").map((c) => `line: ${c.params.status}`);

test("the status line says what runs until the reply's text starts; Slack shows its own after that", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where, { lineMinMs: 0 });
  await out.begin();
  out.thought("**Planning**\n\nfirst ls.");
  await new Promise((r) => setTimeout(r, 10));
  await out.tool("l", { title: "ls -la", status: "in_progress" });
  await out.tool("l", { status: "completed" });
  await out.tool("t", { title: "npm test", status: "in_progress" });
  await out.tool("t", { status: "completed" });
  out.text("Done.");
  await out.end();
  const steps = calls.filter((c) => c.method === "assistant.threads.setStatus" || c.method === "chat.startStream" || (c.method === "agents.sessions.setStatus" && c.params.status === "active"))
    .map((c) => (c.method === "assistant.threads.setStatus" ? `line: ${c.params.status}` : c.method === "chat.startStream" ? "stream" : "active"));
  const working = steps[5].slice("line: ".length);
  assert.ok(WORKING.includes(working), working);
  assert.deepEqual(steps, [
    "active", "line: Thinking · Planning…", // no message yet: the line shows with the session active, not "processing"
    "stream", "active", "line: Tool use: ls -la", // the card opens a stream, which needs the session set active again
    `line: ${working}`, // the tool is done: the model works on what came back
    "line: Tool use: npm test",
    `line: ${working}`,
    "line: ", // text ends the stretch: the line is cleared, Slack's own shows while the text streams
  ]);
  assert.ok(calls.filter((c) => c.method === "assistant.threads.setStatus").every((c) => !c.params.status || c.params.loading_messages?.[0] === c.params.status));
});

test("a status line stays 2 s before the next replaces it; clearing it does not wait", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where, { lineMinMs: 50 });
  await out.tool("x", { title: "execute", status: "in_progress" });
  await out.tool("x", { status: "completed" });
  await out.tool("y", { title: "read", status: "in_progress" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(lines(calls), ["line: Tool use: execute"]); // the fast tool's line is still up
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(lines(calls), ["line: Tool use: execute", "line: Tool use: read"]); // the last one wins, the ones between are skipped
  out.text("Done.");
  await out.end();
  assert.deepEqual(lines(calls), ["line: Tool use: execute", "line: Tool use: read", "line: "]);
});

test("a long status line is cut to Slack's 50 characters", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where);
  await out.tool("x", { title: `npm test -- ${"a".repeat(80)}`, status: "in_progress" });
  out.text("Done.");
  await out.end();
  const shown = calls.find((c) => c.method === "assistant.threads.setStatus")!.params;
  assert.equal(shown.status.length, 50);
  assert.ok(shown.status.startsWith("Tool use: npm test -- a") && shown.status.endsWith("…"));
  assert.equal(shown.loading_messages[0], shown.status);
});

test("a stretch cut by a rollover keeps its summary in the first message, counting there; the new one shows the running tool", async () => {
  const { api, calls, failNext } = failingOnce("msg_too_long");
  const out = createOutput(api, where);
  await out.tool("t0", { title: "npm test", status: "in_progress" });
  await out.tool("t0", { status: "completed" });
  failNext(); // the message is full: the next tool goes on in a new one
  await out.tool("t1", { title: "npm run build", status: "in_progress" });
  await out.tool("t1", { status: "completed" });
  out.text("Built.");
  await out.end();
  const first = calls.find((c) => c.method === "chat.stopStream")!.params.ts;
  assert.equal(calls.filter((c) => c.method === "chat.update" && c.params.ts === first).at(-1)!.params.blocks[0].title, "2 tools used");
  const later = calls.slice(calls.findLastIndex((c) => c.method === "chat.startStream")).flatMap((c) => c.params.chunks ?? []).map((c: any) => c.id).filter(Boolean);
  assert.ok(!later.includes("s1"), String(later));
});

test("a tool the agent reports as pending goes out running: a pending card shows less and the run's cards would jump", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where);
  for (const [id, title] of [["g", "grep X"], ["c", "cat Y"]]) {
    await out.tool(id, { title, status: "pending" });
    await out.tool(id, { title, status: "in_progress", details: "d" });
    await out.tool(id, { status: "completed" });
  }
  out.text("done");
  await out.end();
  const statuses = chunks(calls).filter((c: any) => c.type === "task_update").map((c: any) => c.status);
  assert.ok(!statuses.includes("pending"), statuses.join());
});

test("while the model thinks, the status line shows the heading it is on; its card then says for how long", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { api, calls } = fakeApi();
  const out = createOutput(api, where);
  const settle = () => new Promise((r) => setImmediate(r)); // the line goes out after what is queued before it
  out.thought("**Testing Slack Interface**\n\nI'm checking");
  out.thought(" the tools.\n\n**Planning ");
  await settle();
  t.mock.timers.tick(1_000);
  out.thought("the Steps**\n\nFirst ls.");
  out.thought("\n\n**Too Soon**\n\nskipped title"); // under a second after the last one: not sent
  t.mock.timers.tick(1_000); // the line held 2 s goes now
  await settle();
  out.text("Done.");
  await out.end();
  const titles = chunks(calls).filter((c: any) => c.type === "task_update").map((c: any) => `${c.title}:${c.status}`);
  assert.deepEqual(titles, ["Thought for 2s:complete"]); // no card while it thinks
  assert.deepEqual(lines(calls).slice(0, 2), ["line: Thinking · Testing Slack Interface…", "line: Thinking · Planning the Steps…"]);
});
