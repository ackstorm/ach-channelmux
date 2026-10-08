// Minimal ACP agent for the tests. Logs what it receives as JSON lines to $MOCK_AGENT_LOG.
//   prompt containing "perm": asks for permission, then reports the chosen option
//   any other prompt: "On it, " "checking." <tool call> "Done."

import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const log = (entry: unknown) => appendFileSync(process.env.MOCK_AGENT_LOG!, JSON.stringify(entry) + "\n");
let n = 0;

new acp.AgentSideConnection(
  (conn) => {
    const say = (sessionId: string, text: string) =>
      conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
    return {
      async initialize() {
        return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } };
      },
      async authenticate() {
        return {};
      },
      async newSession({ cwd }) {
        const sessionId = `ses_${++n}`;
        log({ m: "new", sessionId, cwd });
        return { sessionId };
      },
      async loadSession({ sessionId, cwd }) {
        log({ m: "load", sessionId, cwd });
        await say(sessionId, "OLD HISTORY");
        return {};
      },
      async prompt({ sessionId, prompt }) {
        const text = prompt.map((p) => (p.type === "text" ? p.text : "")).join("");
        log({ m: "prompt", sessionId, text });
        if (text.includes("perm")) {
          const r = await conn.requestPermission({
            sessionId,
            toolCall: { toolCallId: "t1", title: "rm -rf build", kind: "execute" },
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
      async cancel() {},
    };
  },
  acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>),
);
