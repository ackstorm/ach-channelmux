// Entrypoint. Configuration comes from the environment.
//
//   RELAY_URL     the relay (e.g. http://ach-channelmux.ach.svc)
//   RELAY_TOKEN   token the relay resolves to this daemon's owner
//   BASE_DIR      folder offered by the picker, with its subfolders (default: current directory)
//   AGENT_CMD     ACP agent command, split on spaces (default "opencode acp")
//   STATE_FILE    thread -> session map (default ~/.local/state/ach-channelmux/threads.json)
//
// Voice clips Slack did not transcribe go to a speech-to-text model when AUDIO_STT_BASE_URL is set:
//   AUDIO_STT_BASE_URL     OpenAI-compatible API, e.g. https://llm.example.com/v1
//   AUDIO_STT_MODEL        its model (default whisper-1)
//   AUDIO_STT_LANGUAGE     the clips' language, e.g. es (default: the model detects it)
//   AUDIO_STT_PROMPT       hints for the model, e.g. names and terms it should spell right
//   AUDIO_STT_HEADER       header carrying the key (default Authorization, sent as "Bearer <key>")
//   AUDIO_STT_KEY          the key, or
//   AUDIO_STT_KEY_COMMAND  a shell command printing it, run for each clip (for short-lived tokens)

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createDaemon } from "./daemon.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const sttKey = async () =>
  process.env.AUDIO_STT_KEY_COMMAND
    ? (await promisify(execFile)("sh", ["-c", process.env.AUDIO_STT_KEY_COMMAND])).stdout.trim()
    : env("AUDIO_STT_KEY", "");
const sttHeader = env("AUDIO_STT_HEADER", "Authorization");

const daemon = createDaemon({
  relayUrl: env("RELAY_URL"),
  token: env("RELAY_TOKEN"),
  agentCmd: env("AGENT_CMD", "opencode acp").split(" ").filter(Boolean),
  baseDir: resolve(env("BASE_DIR", process.cwd())),
  stateFile: env("STATE_FILE", join(homedir(), ".local/state/ach-channelmux/threads.json")),
  stt: process.env.AUDIO_STT_BASE_URL
    ? {
        url: process.env.AUDIO_STT_BASE_URL,
        model: env("AUDIO_STT_MODEL", "whisper-1"),
        language: process.env.AUDIO_STT_LANGUAGE,
        prompt: process.env.AUDIO_STT_PROMPT,
        headers: async () => {
          const key = await sttKey();
          return key ? { [sttHeader]: sttHeader.toLowerCase() === "authorization" ? `Bearer ${key}` : key } : {};
        },
      }
    : undefined,
  // Without its agent the daemon is useless: exit and let the supervisor restart both.
  onAgentExit: () => process.exit(1),
});

await daemon.start();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => daemon.stop().finally(() => process.exit(0)));
