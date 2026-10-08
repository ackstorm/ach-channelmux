// Entrypoint. Configuration comes from the environment.
//
//   RELAY_URL     the relay (e.g. http://ach-channelmux.ach.svc)
//   RELAY_TOKEN   token the relay resolves to this daemon's owner
//   BASE_DIR      folder offered by the picker, with its subfolders (default: current directory)
//   AGENT_CMD     ACP agent command, split on spaces (default "opencode acp")
//   STATE_FILE    thread -> session map (default ~/.local/state/ach-channelmux/threads.json)

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createDaemon } from "./daemon.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const daemon = createDaemon({
  relayUrl: env("RELAY_URL"),
  token: env("RELAY_TOKEN"),
  agentCmd: env("AGENT_CMD", "opencode acp").split(" ").filter(Boolean),
  baseDir: resolve(env("BASE_DIR", process.cwd())),
  stateFile: env("STATE_FILE", join(homedir(), ".local/state/ach-channelmux/threads.json")),
  // Without its agent the daemon is useless: exit and let the supervisor restart both.
  onAgentExit: () => process.exit(1),
});

await daemon.start();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => daemon.stop().finally(() => process.exit(0)));
