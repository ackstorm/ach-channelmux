// Minimal ACP agent for the tests. Logs what it receives as JSON lines to $MOCK_AGENT_LOG.
//   prompt containing "perm": asks for permission, then reports the chosen option
//   prompt "silent": runs a tool and ends the turn without replying; the daemon's nudge
//     ("...without replying...") gets "Here is the result."
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
const sessions = new Map<string, { cwd: string; mcpServers: acp.McpServer[] }>();
const models = (currentValue: string): acp.SessionConfigOption[] => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue, options: [{ value: "m1", name: "Model one" }, { value: "m2", name: "Model two" }] },
  { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "Build" }, { value: "plan", name: "Plan" }] },
];

new acp.AgentSideConnection(
  (conn) => {
    const say = (sessionId: string, text: string) =>
      conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
    return {
      async initialize() {
        return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true }, sessionCapabilities: { list: {} } } };
      },
      async authenticate() {
        return {};
      },
      async listSessions() {
        return { sessions: [...sessions].map(([sessionId, x]) => ({ sessionId, cwd: x.cwd, title: `Session ${sessionId}`, updatedAt: new Date().toISOString() })) };
      },
      async newSession({ cwd, mcpServers }) {
        const sessionId = `ses_${++n}`;
        sessions.set(sessionId, { cwd, mcpServers });
        log({ m: "new", sessionId, cwd });
        return { sessionId, configOptions: models("m1") };
      },
      async loadSession({ sessionId, cwd, mcpServers }) {
        sessions.set(sessionId, { cwd, mcpServers });
        log({ m: "load", sessionId, cwd });
        await say(sessionId, "OLD HISTORY");
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
        log({ m: "prompt", sessionId, text, ...(images.length && { images }) });
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
        } else if (text === "silent") {
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId: "s1", title: "git log", kind: "execute", status: "pending" } });
          await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "s1", status: "completed" } });
        } else if (text.includes("without replying")) {
          await say(sessionId, "Here is the result.");
        } else if (text.includes("upload")) {
          const { cwd, mcpServers } = sessions.get(sessionId)!;
          writeFileSync(join(cwd, "report.txt"), "report body");
          const url = (mcpServers[0] as any).url;
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
        return { stopReason: "end_turn" };
      },
      async setSessionConfigOption({ configId, value }) {
        log({ m: "config", configId, value });
        return { configOptions: models(String(value)) };
      },
      async cancel({ sessionId }) {
        log({ m: "cancel", sessionId });
        cancels.get(sessionId)?.();
      },
    };
  },
  acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>),
);
