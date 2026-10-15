// Minimal ACP agent for the tests. Logs what it receives as JSON lines to $MOCK_AGENT_LOG.
//   prompt containing "perm": asks for permission, then reports the chosen option
//   prompt "silent": runs a tool and ends the turn without replying; the daemon's nudge
//     ("...without replying...") gets "Here is the result."
//   prompt "mute": like "silent", and the nudge gets no reply either
//   prompt containing "upload": writes report.txt in the session folder and sends it with the
//     daemon's send_file MCP tool
//   any other prompt: "On it, " "checking." <tool call> "Done."

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const log = (entry: unknown) => appendFileSync(process.env.MOCK_AGENT_LOG!, JSON.stringify(entry) + "\n");
// Session ids keep counting across restarts of the agent process, like real ones never repeat.
let n = existsSync(process.env.MOCK_AGENT_LOG!) ? readFileSync(process.env.MOCK_AGENT_LOG!, "utf8").split("\n").filter((l) => l.includes('"m":"new"')).length : 0;
const cancels = new Map<string, () => void>();
let flaky = 0; // prompt "flaky" fails the first time
const mute = new Set<string>(); // sessions whose next nudge gets no reply either
const sessions = new Map<string, { cwd: string; mcpServers: acp.McpServer[]; updated?: number; titled?: boolean }>();
let clock = Date.now(); // strictly increasing "last used" times
const touch = (sessionId: string) => {
  const x = sessions.get(sessionId);
  if (x) x.updated = ++clock;
};
const models = (currentValue: string, effort = "default"): acp.SessionConfigOption[] => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue, options: [{ value: "m1", name: "Model one" }, { value: "m2", name: "Model two" }] },
  { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: effort, options: ["low", "high", "default"].map((value) => ({ value, name: value })) },
  { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "Build" }, { value: "plan", name: "Plan" }] },
];
// Like opencode (2.0.29): a session's model and effort; changing the model sets the effort back to default.
const settingsOf = new Map<string, { model: string; effort: string }>();

// Like opencode (2.0.26): it connects to a session's MCP servers as it creates or loads the session,
// and drops one that does not answer for the rest of the session. It keeps them per folder, not per
// session: every session in a folder calls the server the last one registered. A folder it has not
// used yet in this process ("cold") gets its servers a moment after session/load has answered, and its
// tool catalog shows them 100 ms after it has listed their tools (opencode debounces that refresh).
const byFolder = new Map<string, acp.McpServer[]>();
const mcpUrl = (sessionId: string) => (byFolder.get(sessions.get(sessionId)!.cwd)?.[0] as any)?.url;
async function connect(cwd: string, servers: acp.McpServer[] = [], catalogDelay = 0) {
  const ok: acp.McpServer[] = [];
  for (const s of servers) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mock", version: "1" } } });
    const post = (body: string) => fetch((s as any).url, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => undefined);
    const r = await post(body);
    if (r?.ok) {
      ok.push(s);
      await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })); // "mcp connected tools=3"
    } else log({ m: "mcp_failed", status: r?.status });
  }
  if (ok.length) {
    if (catalogDelay) setTimeout(() => byFolder.set(cwd, ok), catalogDelay);
    else byFolder.set(cwd, ok);
  }
  return ok;
}

// Like opencode: its own commands, sent right after a session is created or loaded.
const commands: acp.AvailableCommand[] = [
  { name: "review", description: "review changes [commit|branch|pr]" },
  { name: "compact", description: "Compact the session" },
];

new acp.AgentSideConnection(
  (conn) => {
    const say = (sessionId: string, text: string) =>
      conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
    const announce = (sessionId: string) =>
      setTimeout(() => void conn.sessionUpdate({ sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: commands } }), 0);
    return {
      async initialize() {
        return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true }, sessionCapabilities: { list: {} } } };
      },
      async authenticate() {
        return {};
      },
      async listSessions() {
        // Like opencode: a timestamp title until the first prompt names the session.
        return { sessions: [...sessions].map(([sessionId, x]) => ({ sessionId, cwd: x.cwd, title: x.titled ? `Session ${sessionId}` : `New session - ${new Date(x.updated ?? 0).toISOString()}`, updatedAt: new Date(x.updated ?? 0).toISOString() })) };
      },
      async newSession({ cwd, mcpServers }) {
        const connected = await connect(cwd, mcpServers);
        if (cwd.endsWith("/unstartable")) throw new Error("model gateway down");
        const sessionId = `ses_${++n}`;
        sessions.set(sessionId, { cwd, mcpServers: connected });
        touch(sessionId);
        log({ m: "new", sessionId, cwd });
        announce(sessionId);
        return { sessionId, configOptions: models("m1") };
      },
      async unstable_forkSession({ sessionId: from, cwd, mcpServers }) {
        const sessionId = `ses_${++n}`;
        sessions.set(sessionId, { cwd, mcpServers: await connect(cwd, mcpServers), titled: true });
        log({ m: "new", sessionId, cwd, from });
        return { sessionId, configOptions: models("m1") };
      },
      async loadSession({ sessionId, cwd, mcpServers }) {
        const cold = !byFolder.has(cwd);
        sessions.set(sessionId, { cwd, mcpServers: cold ? [] : await connect(cwd, mcpServers), titled: true }); // it has a history
        if (cold) setTimeout(() => void connect(cwd, mcpServers, 100).then((ok) => (sessions.get(sessionId)!.mcpServers = ok)), 300);
        log({ m: "load", sessionId, cwd });
        announce(sessionId);
        await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: '<slack from="Real UPEPE" at="2026-01-01 10:00 UTC">\nfix the bug\n</slack>' } } });
        await say(sessionId, "Let me check.");
        await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId: "h1", title: "ls", kind: "execute", status: "completed" } });
        await say(sessionId, "OLD HISTORY\n```js\nrun();\n```\nThat ran.");
        // Like opencode: a provisional settings list now, the real one a moment later.
        setTimeout(() => void conn.sessionUpdate({ sessionId, update: { sessionUpdate: "config_option_update", configOptions: models("m1") } }), 200);
        return { configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "m0", options: [{ value: "m0", name: "Model zero" }] }] };
      },
      async prompt({ sessionId, prompt }) {
        const raw = prompt.map((p) => (p.type === "text" ? p.text : "")).join("");
        // A Slack message comes in a <slack from=".." at=".."> envelope: note it, then act on its body.
        const envelope = /^([\s\S]*?)<slack([^>]*)>\n([\s\S]*)\n<\/slack>$/.exec(raw);
        if (envelope) appendFileSync(`${process.env.MOCK_AGENT_LOG}.envelopes`, JSON.stringify({ sessionId, attrs: envelope[2].trim(), body: envelope[3] }) + "\n");
        const text = envelope ? envelope[1] + envelope[3] : raw;
        const images = prompt.filter((p) => p.type === "image").map((p: any) => p.mimeType);
        touch(sessionId);
        sessions.get(sessionId)!.titled = true;
        log({ m: "prompt", sessionId, text, ...(images.length && { images }) });
        if (text === "flaky" && !flaky++) throw new Error("gateway timeout");
        if (text === "broken") throw new Error("gateway timeout");
        if (text === "wait") {
          await new Promise<void>((r) => cancels.set(sessionId, r));
          return { stopReason: "cancelled" };
        }
        if (text === "big edit") {
          const { cwd } = sessions.get(sessionId)!;
          const oldText = Array.from({ length: 30 }, (_, i) => `old line ${i}`).join("\n");
          const newText = Array.from({ length: 30 }, (_, i) => `new line ${i}`).join("\n");
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId: "e1", title: "edit", kind: "edit", status: "pending" } });
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed", content: [{ type: "diff", path: `${cwd}/big.py`, oldText, newText }] } });
          await say(sessionId, "Edited.");
        } else if (text === "small edit") {
          const { cwd } = sessions.get(sessionId)!;
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId: "e2", title: "edit", kind: "edit", status: "pending" } });
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "e2", status: "completed", content: [{ type: "diff", path: `${cwd}/small.py`, oldText: "a = 1", newText: "a = 2" }] } });
          await say(sessionId, "Edited.");
        } else if (text === "ask twice") {
          // Two questions at once (e.g. two subagents): the second is refused, the first still gets its answer.
          const url = mcpUrl(sessionId);
          const call = async (question: string, options: string[]) =>
            (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_user", arguments: { question, options } } }) })).json()).result;
          const first = call("First?", ["Yes", " "]);
          await new Promise((r) => setTimeout(r, 300));
          const second = await call("Second?", ["No"]);
          log({ m: "asked", second: second.isError ? second.content[0].text : "answered" });
          await say(sessionId, `answer: ${(await first).content[0].text}`);
        } else if (text === "ask") {
          // Like an agent calling the daemon's ask_user MCP tool; the call returns the user's answer.
          const url = mcpUrl(sessionId);
          const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_user", arguments: { question: "Which one?", options: ["Red", "Blue"] } } }) });
          await say(sessionId, `answer: ${(await r.json()).result.content[0].text}`);
        } else if (text.startsWith("speak ")) {
          // Like an agent calling the daemon's send_voice MCP tool, when the daemon offers it.
          const url = mcpUrl(sessionId);
          const rpc = async (method: string, params: unknown) =>
            (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
          const tools = (await rpc("tools/list", {})).tools.map((t: any) => t.name);
          const r = tools.includes("send_voice") ? await rpc("tools/call", { name: "send_voice", arguments: { text: text.slice(6) } }) : undefined;
          log({ m: "spoke", tools, result: r?.content[0].text, isError: r?.isError });
          await say(sessionId, "Spoke.");
        } else if (text === "think") {
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Weighing it." } } });
          await say(sessionId, "Thought about it.");
        } else if (text === "subagent") {
          // Like opencode: the subagent's reply streams on this session, tagged with its child session.
          const _meta = { "opencode/child-session": { id: "ses_child", title: "Count" } };
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "CHILD REPLY" }, _meta } });
          await say(sessionId, "Parent reply.");
        } else if (text === "tools?") {
          // Whether the daemon's tools were there when the turn started.
          log({ m: "tools", ready: Boolean(mcpUrl(sessionId)) });
          await say(sessionId, "Checked.");
        } else if (text === "empty") {
          mute.add(sessionId); // no reply, no tool: like a model that answers nothing; its nudge gets nothing either
        } else if (text === "/compact") {
          // Like opencode's: done without a reply.
        } else if (text === "silent" || text === "mute" || (text.includes("without replying") && mute.delete(sessionId))) {
          if (text === "mute") mute.add(sessionId);
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId: "s1", title: "git log", kind: "execute", status: "pending" } });
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "s1", status: "completed" } });
        } else if (text.includes("without replying")) {
          await say(sessionId, "Here is the result.");
        } else if (text.includes("upload")) {
          const { cwd } = sessions.get(sessionId)!;
          writeFileSync(join(cwd, "report.txt"), "report body");
          const url = mcpUrl(sessionId);
          const rpc = async (method: string, params: unknown) =>
            (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
          const tools = (await rpc("tools/list", {})).tools.map((t: any) => t.name);
          const sent = await rpc("tools/call", { name: "send_file", arguments: { path: "report.txt", comment: "here it is" } });
          log({ m: "sent", tools, result: sent.content[0].text });
          await say(sessionId, "Sent.");
        } else if (text.includes("perm")) {
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } } });
          const r = await conn.requestPermission({
            sessionId,
            toolCall: { toolCallId: "t1", title: "bash", kind: "execute" },
            options: [
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          });
          await say(sessionId, `chosen: ${r.outcome.outcome === "selected" ? r.outcome.optionId : "cancelled"}`);
        } else {
          await say(sessionId, "On it, ");
          await say(sessionId, "checking.");
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t0", title: "ls", kind: "execute", status: "pending" } });
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "t0", status: "completed" } });
          await say(sessionId, "Done.");
        }
        await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "usage_update", used: 24_000, size: 200_000, cost: { amount: 0.0123, currency: "USD" } } });
        return { stopReason: "end_turn" };
      },
      async setSessionConfigOption({ sessionId, configId, value }) {
        log({ m: "config", configId, value });
        const s = settingsOf.get(sessionId) ?? { model: "m1", effort: "default" };
        if (configId === "model") Object.assign(s, { model: String(value), effort: "default" });
        if (configId === "effort") s.effort = String(value);
        settingsOf.set(sessionId, s);
        return { configOptions: models(s.model, s.effort) };
      },
      async cancel({ sessionId }) {
        log({ m: "cancel", sessionId });
        cancels.get(sessionId)?.();
      },
    };
  },
  acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>),
);
