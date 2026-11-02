// Usage metrics in Prometheus text format, in memory: they reset when the relay restarts
// (Prometheus' rate() and increase() take that). Counts only, never message text.

type Labels = Record<string, string>;

const FAMILIES: Record<string, [type: "counter" | "gauge", help: string]> = {
  channelmux_messages_total: ["counter", "Messages users sent to an agent (prompts and commands), by owner, author (in a channel, who wrote it) and where: dm, channel or code."],
  channelmux_threads_total: ["counter", "Top-level messages that start a thread (a new session, or a code channel), by owner, author and where."],
  channelmux_actions_total: ["counter", "Commands ($name, !shell), button clicks (by action id), modal submits, shortcuts and Home tab opens, by owner and kind."],
  channelmux_files_in_total: ["counter", "Files attached to messages for an agent, by owner."],
  channelmux_api_calls_total: ["counter", "Slack Web API calls by daemons (replies are chat.postMessage and chat.startStream), by owner, method and ok."],
  channelmux_events_total: ["counter", "Relay log events (connections, refusals, rate limits, offline notices, errors), by event and owner."],
  channelmux_daemon_connected: ["gauge", "1 while the owner's daemon is connected."],
};

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const fmt = (l: Labels) => `{${Object.entries(l).map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}`;

export function createMetrics() {
  const series = new Map<string, Map<string, number>>(); // family -> formatted labels -> value
  const of = (name: string) => {
    let s = series.get(name);
    if (!s) series.set(name, (s = new Map()));
    return s;
  };
  return {
    inc(name: string, labels: Labels, by = 1) {
      const s = of(name);
      const k = fmt(labels);
      s.set(k, (s.get(k) ?? 0) + by);
    },
    set(name: string, labels: Labels, value: number) {
      of(name).set(fmt(labels), value);
    },
    text() {
      const out: string[] = [];
      for (const [name, [type, help]] of Object.entries(FAMILIES)) {
        out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
        for (const [k, v] of series.get(name) ?? []) out.push(`${name}${k} ${v}`);
      }
      return out.join("\n") + "\n";
    },
  };
}
