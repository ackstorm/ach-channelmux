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
//
// The agent gets a send_voice tool (text to an audio clip in the thread) when AUDIO_TTS_BASE_URL is set:
//   AUDIO_TTS_BASE_URL     OpenAI-compatible API, e.g. https://llm.example.com/v1
//   AUDIO_TTS_MODEL        its model (default tts-1)
//   AUDIO_TTS_VOICE        its voice (default alloy; Gemini models take names like Kore or Puck)
//   AUDIO_TTS_PROMPT       how to speak, put before the text, e.g. "Say it cheerfully"
//   AUDIO_TTS_HEADER, AUDIO_TTS_KEY, AUDIO_TTS_KEY_COMMAND   as for STT

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

// The auth header for AUDIO_STT_* or AUDIO_TTS_*: a key, or a command printing one, run for each call.
const audioHeaders = (prefix: string) => {
  const header = env(`${prefix}_HEADER`, "Authorization");
  const command = process.env[`${prefix}_KEY_COMMAND`];
  return async (): Promise<Record<string, string>> => {
    const key = command ? (await promisify(execFile)("sh", ["-c", command])).stdout.trim() : env(`${prefix}_KEY`, "");
    return key ? { [header]: header.toLowerCase() === "authorization" ? `Bearer ${key}` : key } : {};
  };
};

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
        headers: audioHeaders("AUDIO_STT"),
      }
    : undefined,
  tts: process.env.AUDIO_TTS_BASE_URL
    ? {
        url: process.env.AUDIO_TTS_BASE_URL,
        model: env("AUDIO_TTS_MODEL", "tts-1"),
        voice: env("AUDIO_TTS_VOICE", "alloy"),
        prompt: process.env.AUDIO_TTS_PROMPT,
        headers: audioHeaders("AUDIO_TTS"),
      }
    : undefined,
  // Without its agent the daemon is useless: exit and let the supervisor restart both.
  onAgentExit: () => process.exit(1),
});

await daemon.start();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => daemon.stop().finally(() => process.exit(0)));
