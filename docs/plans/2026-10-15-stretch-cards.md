# Stretch Cards Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Each stretch of a turn (the model's thinking and the tools it calls between two texts) shows as one
Slack task card, "Thinking · <heading>" while it thinks and "Thought for Xs · N tools used" after, with the running
tool in a second card that goes when the stretch ends. Opened, the card shows the thinking (bold headings) and the
list of tools, not their results.

**Architecture:** `daemon/src/output.ts` replaces its three card kinds (`thought<n>`, `a<n>`, `b<n>`) with two per
stretch: `s<n>` (the summary, which stays) and `r<n>` (the running tool, live only). The stream sends titles and
statuses; each stopped message is rewritten with `chat.update`: one `task_card` per stretch with a `rich_text`
output, without the `r<n>` cards. `describeTool` keeps only title and status: tool output, details and sources go.

**Tech Stack:** Node 24 type-stripped TypeScript (erasable only), node:test, Slack `chat.startStream` /
`appendStream` / `stopStream` / `chat.update`, Block Kit `task_card` + `rich_text`.

**Decisions taken with the user (2026-10-15), all tried live in the DM test thread first:**
- One card per stretch, independent: think + tools, then text, then a new stretch is a new card (not one per turn).
- Titles: `Thinking…` → `Thinking · <heading>` (as today) → `Thought for 10s` → `Thought for 10s · 1 tool used`
  → … The count is of the tools before the one running; the running one shows below as `Using tool: <title>`.
  "Using tool: " is kept.
- Opened: the thinking with its `**headings**` in bold (today they show as raw `**`), then the tools' titles as
  a code list. No results.
- A failed tool: no red. The card stays ✓, the title adds `· 1 failed`, the tool shows `(failed)` in the list.
  Tool errors are routine and usually corrected; red reads as "the whole turn failed".
- A question (or permission prompt) ends a stretch like text does.
- A message that rolls over (size or age) mid-stretch: the summary stays in the first message and keeps counting
  there (`chat.update`); the new message carries only `Using tool: …` (option B).
- Not a `plan` block: Slack allows one per message (`invalid_blocks: Cannot have more than 1 plan block`), and a
  plan with a failed task turns its icon red.

**To confirm before Task 2 (my defaults):**
1. Diffs no longer show in cards, so every turn that edits ends with the `changes.diff` snippet, not only those
   over 400 characters (`DIFF_IN_CARD` goes).
2. Thinking again after tools in the same stretch: the summary card shows `Thinking · <heading>` again (the count
   comes back when it ends), and the thinking seconds add up.
3. A stretch with no thinking: its first tool is the card itself (`Using tool: ls`), as today's first card does;
   from the second tool on it is `1 tool used` plus the running card.
4. `ask_user` counts as a tool of the stretch the question ends (no special case).
5. Rewritten thinking: only `**bold**` headings become bold; other Markdown (`code`, *italic*) stays as typed.

---

## What goes (removals)

`daemon/src/output.ts`:
- The `b<n>` card and all it needs: `headed()`, `filled`, `whole()`'s `b` branch, `now()`.
- Tool content in cards: `CONTENT`, the `gain`/`added` logic in `tool()`, `DETAILS_MAX`, `ToolInfo.details`,
  `ToolInfo.output`, `ToolInfo.sources`.
- The separate thinking card `thought<n>` and the `texts` counter: the thinking joins its stretch's card.
- `settle()` and its `↓ continues below`: a stopped message is always rewritten without its running cards.
- `closedRun()` and `left`: replaced by one rule, "a stretch card stays in the message that first showed it".
- `rich()`: replaced by the stretch's `rich_text` builder.
- The `error` card status (`TASK_STATUS.failed`) and the `🔧` in titles.
- In `describeTool`: the output (diff summary, fenced result, exit code), `details` (pattern, URL, code, long
  command) and `sources`. Kept: title (now with a fetched URL in it: `webfetch https://…`) and status, including
  "failed" from a non-zero exit or a tool error.

`daemon/src/daemon.ts`: `DIFF_IN_CARD` and its threshold (decision 1).

Tests: `output.test.ts` loses "a card's details and output reach the stream…" and "a card's sources, details and
output go out once…"; the `describeTool` test loses its output/details/sources assertions. The tests that assert
`a<n>`/`b<n>`/`thought<n>` titles are rewritten (Tasks 2–5).

Estimate: −200 lines in `output.ts`, +90.

---

### Task 0: Spike — how much thinking fits in a rewritten card

No code. Decides the clip in Task 3.

**Step 1:** With the scratchpad `live.mjs` pattern (token piped from the k8s secret, never printed), `chat.update`
a test message with one `task_card` whose `output` is a `rich_text` section of 1k, 3k, 6k and 12k characters.
**Step 2:** Note the largest that passes, and whether Slack folds it behind "Show more". Expected: a few thousand.
**Step 3:** Set `THOUGHT_MAX` in Task 3 to that size minus a margin; the streamed card keeps today's 500-char tail.

---

### Task 1: `describeTool` keeps title and status only

**Files:** Modify `daemon/src/output.ts` (`ToolInfo`, `describeTool`), `daemon/test/output.test.ts`.

**Step 1: Update the test.** In "describeTool turns opencode's tool updates…", each `describeTool(...)` expectation
keeps only `title` and `status`, e.g.:

```ts
assert.deepEqual(read, { title: "read calc.py", status: "completed" });
assert.deepEqual(shell, { title: "python3 t.py", status: "failed" }); // exit 1
assert.deepEqual(code, { title: "await x()", status: "failed" }); // a tool error
const fetch = describeTool({ title: "webfetch", kind: "fetch", status: "pending" }, { url: "https://example.com/a" }, cwd);
assert.deepEqual(fetch, { title: "webfetch https://example.com/a", status: "pending" });
```

The `fullDiff`, subagent `↳`, skill, code-tool and heredoc title assertions stay. Delete the two content tests
named under Removals.

**Step 2:** `npm test -w daemon` → FAIL (output/details still returned).

**Step 3: Implement.** `ToolInfo = { title?: string; status?: string }`. In `describeTool`: drop `sources`,
`details`, `output`; add `i.url` to `subject` (`path ? rel(path) : (i.url ?? i.description ?? i.id)`); keep the
`failed` detection:

```ts
let status: string | undefined = u.status ?? undefined;
// opencode reports a command that exits non-zero, or a tool error, as completed
const exit = u.rawOutput?.metadata?.exit;
if (u.status === "completed" && ((typeof exit === "number" && exit !== 0) || u.rawOutput?.metadata?.error === true)) status = "failed";
```

**Step 4:** `npm test -w daemon` → the describeTool test passes (card tests may fail until Task 2).

---

### Task 2: Stretch cards while streaming

**Files:** Modify `daemon/src/output.ts` (`createOutput`), `daemon/test/output.test.ts`.

**State** (replaces `Run`, `runs`, `runOf`, `thinking`, `texts`, `filled`):

```ts
// A stretch is the model's thinking and the tools it calls between two texts, or up to a question: card s<n> sums
// it up and stays; while a tool runs after something else was shown, r<n> shows it. A stream cannot remove r<n>:
// each stopped message is rewritten without it.
type Entry = { thought: string } | { tool: string };
type Stretch = { n: number; entries: Entry[]; tools: string[]; thinkMs: number; closed: boolean };
const stretches: Stretch[] = [];
let current: Stretch | null = null;
const stretchOf = new Map<string, Stretch>(); // tool call id -> its stretch
const tools = new Map<string, { title: string; status: string }>(); // ACP status: in_progress, completed, failed
let thinking: { text: string; heading: string; shown: number; since: number } | null = null;
```

**Titles:**

```ts
const done = (t: string) => ["completed", "failed"].includes(tools.get(t)!.status);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
// The summary: thinking now, or what the stretch did, counting the tools before the one running.
function head(s: Stretch) {
  if (thinking && s === current) return { title: thinking.heading ? `Thinking · ${thinking.heading}` : "Thinking…", status: "in_progress" };
  const running = s.closed ? undefined : s.tools.find((t) => !done(t));
  const counted = s.tools.filter((t) => t !== running);
  const failed = counted.filter((t) => tools.get(t)!.status === "failed").length;
  const parts = [s.thinkMs ? `Thought for ${Math.max(1, Math.round(s.thinkMs / 1000))}s` : "", counted.length ? `${plural(counted.length, "tool")} used` : "", failed ? `${failed} failed` : ""].filter(Boolean);
  if (!parts.length && running) return { title: `Using tool: ${tools.get(running)!.title}`, status: "in_progress" };
  return { title: parts.join(" · "), status: "complete" };
}
// The stretch's cards: its summary, and the running tool when the summary says something else.
function cards(s: Stretch) {
  const h = head(s);
  const last = s.tools.at(-1);
  const r = last && !h.title.startsWith("Using tool: ")
    ? { title: `Using tool: ${tools.get(last)!.title}`, status: s.closed || done(last) ? "complete" : "in_progress" }
    : null;
  return [update(`s${s.n}`, h, {}), r && update(`r${s.n}`, r, {})];
}
```

`tool(id, info)`: a thought in progress ends (`endThought()`); `tools.set(id, …)`; a new id joins `current ??=` a
new stretch (`entries.push({ tool: id })`); a finished last tool waits in `later` as today; otherwise
`emit(cards(stretchOf.get(id)!))`. `emit` keeps only the last update of each card id when it merges `later`.

`thought(s)`: opens `current ??=` a stretch and `thinking ??= { …, since: Date.now() }` on its first chunk, then
the heading logic as today, emitting `cards(current)`. `endThought()`: adds `Date.now() - since` to `thinkMs`,
pushes `{ thought: text }`, and appends the text's tail (≤ `OUTPUT_MAX`, as today) to `s<n>`'s output.

`close()` (text, `pause()`, `end()`): `endThought()`, `current.closed = true`, `emit(cards(s), true, before)`.
`pause()` now calls `endThought(); close();` before what it does today.

**Step 1: Write the failing test** (replaces "a run of tools shows the one running…", "the thinking between two
texts is one card…", "the model's thinking is one card…"):

```ts
test("a stretch is one card: thinking, then a count of the tools before the one running, which shows below", async (t) => {
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
  const titles = chunks(calls).filter((c: any) => c.type === "task_update").map((c: any) => `${c.id} ${c.title}:${c.status}`);
  assert.deepEqual(titles, [
    "s1 Thinking…:in_progress",
    "s1 Thinking · Reading:in_progress",
    "s1 Thought for 10s:complete",
    "r1 Using tool: grep X:in_progress",
    "s1 Thought for 10s · 1 tool used:complete", // grep's finish waits for ls: one append
    "r1 Using tool: ls:in_progress",
    "s1 Thought for 10s · 2 tools used · 1 failed:complete", // text ends the stretch
    "r1 Using tool: ls:complete", // never "error"
    "s2 Using tool: cat y:complete", // no thinking: the first tool is the card
    "s2 1 tool used:complete",
  ]);
});
```

**Step 2:** `npm test -w daemon` → FAIL.
**Step 3:** Implement as above; delete the removed code (Removals list).
**Step 4:** `npm test -w daemon` → this test passes. Adapt "a turn streams text and tool cards…" (titles
`s1 Using tool: ls` → `s1 1 tool used`), "a finished tool stays on screen…", "a tool the agent reports as
pending…", "while the model thinks…" (last title `Thought for 1s`) and the e2e test at `e2e.test.ts:207` and the
Thinking card test at `e2e.test.ts:336` the same way.

---

### Task 3: The stopped message is rewritten: one card per stretch, thinking in bold, tools listed

**Files:** Modify `daemon/src/output.ts` (`rewrite`), `daemon/test/output.test.ts`.

```ts
const THOUGHT_MAX = 3_000; // from Task 0
const txt = (text: string, style?: Record<string, boolean>) => ({ type: "text", text, ...(style && { style }) });
// "**Heading**" in the model's thinking as bold text, the rest as typed.
const bold = (s: string) => s.split(/\*\*([^*\n]+)\*\*/).flatMap((p, i) => (p ? [txt(p, i % 2 ? { bold: true } : undefined)] : []));
// What a stretch did, in order: each thought, and each run of tools as a list of their titles.
function inside(s: Stretch) {
  const elements: unknown[] = [];
  for (const e of s.entries) {
    if ("thought" in e) elements.push({ type: "rich_text_section", elements: bold(clip(e.thought.trim(), THOUGHT_MAX)) });
    else {
      const t = tools.get(e.tool)!;
      const item = { type: "rich_text_section", elements: [txt(t.title, { code: true }), ...(t.status === "failed" ? [txt(" (failed)", { italic: true })] : [])] };
      const last: any = elements.at(-1);
      if (last?.type === "rich_text_list") last.elements.push(item);
      else elements.push({ type: "rich_text_list", style: "bullet", elements: [item] });
    }
  }
  return elements.length ? { output: { type: "rich_text", elements } } : {};
}
```

`rewrite(ts, lay, extra)`: always when the message has a card; texts as today; `s<n>` →
`taskCard(id, head(s).title, head(s).status, inside(s))`; `r<n>` → nothing.

**Step 1: Write the failing test:**

```ts
test("a stopped message is rewritten with one card per stretch: its thinking in bold and its tools, no running card", async () => {
  const { api, calls } = fakeApi();
  const out = createOutput(api, where);
  out.thought("**Reading**\n\nThe user wants X.");
  await out.tool("g", { title: "grep X", status: "completed" });
  await out.tool("l", { title: "ls", status: "failed" });
  out.text("Done.");
  await out.end();
  const blocks = calls.at(-1)!.params.blocks;
  assert.deepEqual(blocks.map((b: any) => b.type), ["task_card", "markdown"]);
  assert.equal(blocks[0].status, "complete");
  assert.deepEqual(blocks[0].output.elements, [
    { type: "rich_text_section", elements: [{ type: "text", text: "Reading", style: { bold: true } }, { type: "text", text: "\n\nThe user wants X." }] },
    { type: "rich_text_list", style: "bullet", elements: [
      { type: "rich_text_section", elements: [{ type: "text", text: "grep X", style: { code: true } }] },
      { type: "rich_text_section", elements: [{ type: "text", text: "ls", style: { code: true } }, { type: "text", text: " (failed)", style: { italic: true } }] },
    ] },
  ]);
});
```

**Steps 2–4:** run → FAIL → implement → PASS.

---

### Task 4: A question ends the stretch; the next one starts in the new message

**Files:** `daemon/test/output.test.ts` (replaces "a card running when the stream pauses is closed there with a
pointer…" and adapts "a card updated while paused…").

```ts
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
```

**Steps 2–4:** run → FAIL → implement (`pause()` closes; a card of a stretch whose message stopped is never streamed
again, its message is rewritten: the `drop()` rule in `send()` now keys on "shown in a stopped message") → PASS.

---

### Task 5: Rollover keeps the summary in the first message

**Files:** `daemon/test/output.test.ts` (replaces "a run closed when its message rolls over keeps its card
there…").

```ts
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
```

**Steps 2–4:** run → FAIL → implement (`goesOn` = only the open stretch's `r<n>`) → PASS. Re-run the two fence
rollover tests unchanged.

---

### Task 6: Every turn that edits gets the `changes.diff` snippet (decision 1)

**Files:** `daemon/src/daemon.ts:19,655`, `daemon/src/output.ts` (`DIFF_IN_CARD`), `daemon/test/e2e.test.ts:380`.

**Step 1:** Rename the e2e test to "a turn that edits ends with a line of its changes … and its changes as a
changes.diff snippet"; add a small edit (one line) to the mock agent's prompts and assert it uploads too.
**Step 2:** run → FAIL. **Step 3:** `if (diffs?.length)`; delete `DIFF_IN_CARD` and its import. **Step 4:** PASS.

---

### Task 7: Docs, full test run, commit

- `daemon/src/output.ts` header comment: cards are per stretch.
- `README.md` **Replies** row: stretch cards, `Thought for Xs · N tools used`, `Using tool:`, rewritten with the
  thinking and the tools' titles; the `changes.diff` snippet for every turn that edits; no `↓ continues below`.
- `make test` → all pass (relay 43, daemon ~78) and helm lint.
- Commit: `feat(daemon): one card per stretch: thinking and tools, summed up`.

### Task 8: Release and live check

- `make release-cut VERSION=0.3.8`, install on `v1-1` (swap script), then in the DM test thread: a thinking turn
  with 3+ tools, a turn with a failing command, a question mid-turn, and a long run past a rollover. Compare
  against the simulated messages ("flow · live", "D · one card per stretch", "question · live").
