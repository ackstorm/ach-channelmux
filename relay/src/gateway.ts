// Slack relay.
//
// One upstream Socket Mode connection to the real Slack app; per-user
// downstream daemons (cc-connect, any Bolt app) connect to this gateway as if
// it were Slack by pointing their Slack API base URL here. The gateway:
//   - fans DM events out to the single active daemon of the sender,
//   - proxies an allowlist of Web API methods with the real bot token, scoped
//     to the owner's DM,
//   - proxies inbound file downloads so daemons never hold the bot token,
//   - parks extra daemons of the same owner as hot standby,
//   - tells the owner, in the thread, when none of their daemons is connected,
//   - spends the Slack app's shared rate limits for every daemon (limiter.ts).

import http from "node:http";
import { randomUUID } from "node:crypto";
import { SocketModeClient } from "@slack/socket-mode";
import { WebSocketServer, WebSocket } from "ws";
import { createLimiter } from "./limiter.ts";

export interface GatewayConfig {
  port: number;
  publicUrl: string; // e.g. https://slack-gw.example.com (no trailing slash)
  upstreamApiUrl: string; // https://slack.com/api/
  appToken: string; // xapp-…
  botToken: string; // xoxb-…
  /** Maps a daemon credential to the corporate email it belongs to. */
  resolveToken: (token: string) => Promise<string | null>;
  interactiveAckTimeoutMs?: number;
  pingIntervalMs?: number;
  /** Working-notice ("🧠 Ruminating…") refresh period; 0 disables it and forwards the daemon's reactions instead. Default 15 s. */
  workingNoticeMs?: number;
  /** After this long, switch to "taking a while" lines with the elapsed time. Default 2 min. */
  slowWorkingAfterMs?: number;
  /** Refresh period once slow. Default 60 s. */
  slowWorkingNoticeMs?: number;
  /** Instructions appended, with who the user is and their local time, to the first message of each thread (a top-level DM starts a new agent session). Empty disables it. */
  sessionPreamble?: string;
  /** Slack calls per minute per method (default RATES in limiter.ts); {} disables pacing. */
  rates?: Record<string, number>;
  /** chat.startStream is refused when it would wait longer. Default 2 s. */
  maxStreamStartWaitMs?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

interface Envelope {
  envelope_id: string;
  type: string;
  payload: any;
  accepts_response_payload: boolean;
  retry_attempt: number;
  retry_reason: string;
}

interface Conn {
  id: string;
  ws: WebSocket;
  alive: boolean;
  pending: Map<string, (payload: unknown) => void>;
}

interface SlackUser {
  id: string;
  real_name?: string;
  tz?: string;
  profile?: { email?: string; real_name?: string };
}

interface Owner {
  slackUserId: string;
  email: string;
  name?: string; // Slack display name, for the session preamble
  tz?: string; // Slack IANA time zone, for the session preamble
  dm: string;
  primary: Conn | null;
  standby: Conn[];
  triggers: Set<string>;
  views: Set<string>;
  files: Map<string, string>; // fileId -> original url_private_download
  threadOf: Map<string, string>; // DM message ts -> its thread root, for messages delivered to the daemon
  working: Map<string, { timer: NodeJS.Timeout; notice?: string }>; // message ts -> running working notice
}

// Methods whose target (channel, or user for users.info) must be the owner's DM or the owner.
const CHANNEL_SCOPED: Record<string, string[]> = {
  "chat.postMessage": ["channel"],
  "chat.update": ["channel"],
  "chat.delete": ["channel"],
  "chat.postEphemeral": ["channel"],
  "reactions.add": ["channel"],
  "reactions.remove": ["channel"],
  "conversations.replies": ["channel"],
  "conversations.info": ["channel"],
  "users.info": ["user"],
  "assistant.threads.setStatus": ["channel_id"],
  "files.completeUploadExternal": ["channel_id", "channels"],
  "chat.startStream": ["channel"],
  "chat.appendStream": ["channel"],
  "chat.stopStream": ["channel"],
  "agents.sessions.setStatus": ["channel_id"],
  "agents.sessions.rename": ["channel_id"],
};
const PASSTHROUGH = new Set(["auth.test", "team.info", "files.getUploadURLExternal"]);

/** Lines the working notice rotates through while an agent turn runs (Claude Code-style). */
export const WORKING_MESSAGES = [
  "🎯 *Accomplishing…*",
  "⚡ *Actioning…*",
  "✨ *Actualizing…*",
  "🔎 *Analyzing…*",
  "🏗️ *Architecting…*",
  "🥧 *Baking…*",
  "✨ *Beaming…*",
  "🎷 *Beboppin'…*",
  "🥬 *Blanching…*",
  "💃 *Boogieing…*",
  "🤪 *Boondoggling…*",
  "🤖 *Booping…*",
  "🥾 *Bootstrapping…*",
  "🌩️ *Brainstorming…*",
  "☕ *Brewing…*",
  "🐰 *Burrowing…*",
  "🌵 *Cactusing…*",
  "🎚️ *Calibrating…*",
  "🧮 *Calculating…*",
  "💕 *Canoodling…*",
  "🍮 *Caramelizing…*",
  "🌊 *Cascading…*",
  "🚀 *Catapulting…*",
  "🤔 *Cerebrating…*",
  "📡 *Channelling…*",
  "💃 *Choreographing…*",
  "🔄 *Churning…*",
  "🤖 *Clauding…*",
  "🌀 *Coalescing…*",
  "🤔 *Cogitating…*",
  "🔧 *Combobulating…*",
  "🎼 *Composing…*",
  "💻 *Computing…*",
  "🎨 *Conceptualizing…*",
  "🧪 *Concocting…*",
  "🪄 *Conjuring…*",
  "💭 *Considering…*",
  "🤔 *Contemplating…*",
  "🍳 *Cooking…*",
  "🔨 *Crafting…*",
  "✨ *Creating…*",
  "📊 *Crunching…*",
  "💎 *Crystallizing…*",
  "🌱 *Cultivating…*",
  "☁️ *Daydreaming…*",
  "🔓 *Deciphering…*",
  "⚖️ *Deliberating…*",
  "🎯 *Determining…*",
  "🦆 *Dilly-dallying…*",
  "😵 *Discombobulating…*",
  "🧪 *Distilling…*",
  "🎩 *Doffing…*",
  "⚡ *Doing…*",
  "🌧️ *Drizzling…*",
  "🌊 *Ebbing…*",
  "⚡ *Effecting…*",
  "📐 *Evaluating…*",
  "🦴 *Exoskeletizing…*",
  "💡 *Elucidating…*",
  "✨ *Enchanting…*",
  "👁️ *Envisioning…*",
  "💨 *Evaporating…*",
  "🍺 *Fermenting…*",
  "🎻 *Fiddle-faddling…*",
  "🔍 *Figuring…*",
  "🎭 *Finagling…*",
  "🔥 *Flambéing…*",
  "🦋 *Flibbertigibbeting…*",
  "😵‍💫 *Flummoxing…*",
  "🦋 *Fluttering…*",
  "🔥 *Forging…*",
  "📝 *Formulating…*",
  "🧁 *Frosting…*",
  "🐎 *Galloping…*",
  "🌿 *Garnishing…*",
  "⚙️ *Generating…*",
  "🌱 *Germinating…*",
  "💨 *Gusting…*",
  "🎵 *Harmonizing…*",
  "🐣 *Hatching…*",
  "🐑 *Herding…*",
  "🦢 *Honking…*",
  "🎉 *Hullaballooing…*",
  "🔬 *Hypothesizing…*",
  "🚀 *Hyperspacing…*",
  "💡 *Ideating…*",
  "💭 *Imagining…*",
  "🎭 *Improvising…*",
  "🥚 *Incubating…*",
  "🎲 *Inferring…*",
  "🫖 *Infusing…*",
  "🕵️ *Investigating…*",
  "💃 *Jitterbugging…*",
  "🥕 *Julienning…*",
  "🥖 *Kneading…*",
  "🍞 *Leavening…*",
  "🧘 *Levitating…*",
  "😴 *Lollygagging…*",
  "🌟 *Manifesting…*",
  "🫒 *Marinating…*",
  "🚶 *Meandering…*",
  "🦋 *Metamorphosing…*",
  "🌙 *Moonwalking…*",
  "🍷 *Mulling…*",
  "🎭 *Musing…*",
  "💪 *Mustering…*",
  "💨 *Nebulizing…*",
  "🪺 *Nesting…*",
  "🍜 *Noodling…*",
  "⚛️ *Nucleating…*",
  "🎼 *Orchestrating…*",
  "🚶 *Perambulating…*",
  "☕ *Percolating…*",
  "🌸 *Pollinating…*",
  "🤔 *Pondering…*",
  "🎩 *Pontificating…*",
  "🪄 *Poofing…*",
  "🐱 *Pouncing…*",
  "🌧️ *Precipitating…*",
  "🎩 *Prestidigitating…*",
  "⚡ *Processing…*",
  "🌱 *Propagating…*",
  "🔧 *Puttering…*",
  "🧩 *Puzzling…*",
  "⚛️ *Quantumizing…*",
  "🧩 *Rationalizing…*",
  "✨ *Razzle-dazzling…*",
  "🎭 *Razzmatazzing…*",
  "🤔 *Reasoning…*",
  "🪞 *Reflecting…*",
  "🔀 *Reticulating…*",
  "✅ *Resolving…*",
  "🐓 *Roosting…*",
  "💭 *Ruminating…*",
  "🐿️ *Scampering…*",
  "🐁 *Scurrying…*",
  "💃 *Shimmying…*",
  "🎮 *Simulating…*",
  "🏃 *Skedaddling…*",
  "✏️ *Sketching…*",
  "🍲 *Simmering…*",
  "🐍 *Slithering…*",
  "🧦 *Sock-hopping…*",
  "🔮 *Speculating…*",
  "🦇 *Spelunking…*",
  "🌀 *Spinning…*",
  "🌱 *Sprouting…*",
  "🍲 *Stewing…*",
  "♟️ *Strategizing…*",
  "💨 *Sublimating…*",
  "🌀 *Swirling…*",
  "🦅 *Swooping…*",
  "🤝 *Symbioting…*",
  "🧬 *Synthesizing…*",
  "🌡️ *Tempering…*",
  "📚 *Theorizing…*",
  "💭 *Thinking…*",
  "🤡 *Tomfoolering…*",
  "🙃 *Topsy-turvying…*",
  "✨ *Transfiguring…*",
  "🔮 *Transmuting…*",
  "🌊 *Undulating…*",
  "🌸 *Unfurling…*",
  "🧶 *Unravelling…*",
  "🌊 *Vibing…*",
  "🐧 *Waddling…*",
  "🚶 *Wandering…*",
  "🌀 *Warping…*",
  "⚖️ *Weighing…*",
  "❓ *Whatchamacalliting…*",
  "🌀 *Whirlpooling…*",
  "⚙️ *Whirring…*",
  "🥄 *Whipping up…*",
  "〰️ *Wibbling…*",
  "⚙️ *Working…*",
  "🏋️ *Working out…*",
  "🤠 *Wrangling…*",
  "🤼 *Wrestling with…*",
  "🍋 *Zesting…*",
  "⚡ *Zigzagging…*",
];

/** Lines once a turn has run for a while; shown with the elapsed time. */
export const SLOW_WORKING_MESSAGES = [
  "😅 Phew, this is taking a bit…",
  "⏳ Taking a little longer than usual…",
  "☕ Still at it, hang in there…",
  "🐢 Slow going, but still going…",
  "🙏 Thanks for your patience…",
  "🚧 Still on the job…",
];

/** "2026-10-03 18:40 (Europe/Madrid)"; UTC when the zone is missing or unknown. */
export function localTime(at: Date, tz?: string) {
  const fmt = (timeZone: string) =>
    new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short" }).format(at);
  try {
    if (tz) return `${fmt(tz)} (${tz})`;
  } catch {} // RangeError: unknown time zone
  return `${fmt("UTC")} (UTC)`;
}

/**
 * Appends the preamble to a new top-level message, which starts a thread and an agent
 * session. Thread replies, edits and other events, and cc-connect commands ("/cmd", "!shell",
 * also with leading spaces) pass untouched: cc-connect would read the preamble as arguments.
 */
export function addPreamble(
  ev: { type?: string; subtype?: string; text?: string; ts?: string; thread_ts?: string },
  preamble: string | undefined,
  user: { email: string; name?: string; tz?: string },
) {
  if (!preamble || ev.type !== "message" || ev.thread_ts) return;
  if (ev.subtype && ev.subtype !== "file_share") return;
  if (/^\s*[/!]/.test(ev.text ?? "")) return;
  const who = user.name ? `${user.name} <${user.email}>` : user.email;
  const at = localTime(new Date(Number(ev.ts ?? 0) * 1000 || Date.now()), user.tz);
  ev.text = [
    ev.text ?? "",
    "",
    "[Context from the Slack relay. Do not mention or quote this block.]",
    `User: ${who}. Local time: ${at}.`,
    preamble,
    "[End of relay context]",
  ].join("\n");
}

export function createGateway(cfg: GatewayConfig) {
  const log = cfg.log ?? ((m, d) => console.log(JSON.stringify({ msg: m, ...d })));
  const upstream = cfg.upstreamApiUrl.endsWith("/") ? cfg.upstreamApiUrl : cfg.upstreamApiUrl + "/";
  const ackTimeout = cfg.interactiveAckTimeoutMs ?? 2500;
  const noticeMs = cfg.workingNoticeMs ?? 15_000;
  const slowAfterMs = cfg.slowWorkingAfterMs ?? 120_000;
  const slowNoticeMs = cfg.slowWorkingNoticeMs ?? 60_000;

  const owners = new Map<string, Owner>(); // by slack user id
  const ownerByEmail = new Map<string, Owner>();
  const tickets = new Map<string, { owner: Owner; exp: number }>();
  const seenEvents = new Map<string, true>();

  // ---------- upstream Slack calls (bot token) ----------

  async function upstreamCall(method: string, params: Record<string, unknown>) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    const res = await fetch(upstream + method, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.botToken}`, "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (res.status === 429) return { status: 429, retryAfter: Number(res.headers.get("retry-after")) || 1, body: null };
    return { status: res.status, body: await res.json() };
  }
  const slack = createLimiter(upstreamCall, { rates: cfg.rates, maxStreamStartWaitMs: cfg.maxStreamStartWaitMs, log });

  // Concurrent first calls (auth.test and apps.connections.open race at daemon
  // start) must resolve to the same Owner, so in-flight lookups are shared.
  const resolving = new Map<string, Promise<Owner | null>>();
  function ownerFor(email: string, knownUser?: SlackUser): Promise<Owner | null> {
    const cached = ownerByEmail.get(email);
    if (cached) return Promise.resolve(cached);
    let p = resolving.get(email);
    if (!p) {
      p = createOwner(email, knownUser).finally(() => resolving.delete(email));
      resolving.set(email, p);
    }
    return p;
  }

  async function createOwner(email: string, knownUser?: SlackUser): Promise<Owner | null> {
    let user = knownUser;
    if (!user) {
      const r = await slack("users.lookupByEmail", { email });
      if (!r.ok) return null;
      user = r.user as SlackUser;
    }
    const im = await slack("conversations.open", { users: user.id });
    if (!im.ok) return null;
    const owner: Owner = {
      slackUserId: user.id,
      email,
      name: user.profile?.real_name || user.real_name || undefined,
      tz: user.tz,
      dm: im.channel.id,
      primary: null,
      standby: [],
      triggers: new Set(),
      views: new Set(),
      files: new Map(),
      threadOf: new Map(),
      working: new Map(),
    };
    owners.set(user.id, owner);
    ownerByEmail.set(email, owner);
    return owner;
  }

  async function ownerForSlackUser(userId: string): Promise<Owner | null> {
    const known = owners.get(userId);
    if (known) return known;
    const r = await slack("users.info", { user: userId });
    const email = r.ok ? r.user?.profile?.email : undefined;
    if (!email) return null;
    return ownerFor(email, r.user);
  }

  async function ownerForToken(token: string | undefined): Promise<Owner | null> {
    if (!token) return null;
    const email = await cfg.resolveToken(token);
    return email ? ownerFor(email) : null;
  }

  // ---------- downstream delivery ----------

  function send(conn: Conn, env: Envelope): Promise<unknown> {
    return new Promise((resolve) => {
      conn.pending.set(env.envelope_id, resolve);
      conn.ws.send(JSON.stringify(env));
    });
  }

  function rewriteFiles(owner: Owner, payload: any) {
    const files = payload?.event?.files;
    if (!Array.isArray(files)) return;
    for (const f of files) {
      const original = f.url_private_download ?? f.url_private;
      if (!f.id || !original) continue;
      owner.files.set(f.id, original);
      const proxied = `${cfg.publicUrl}/files/${encodeURIComponent(f.id)}/${encodeURIComponent(f.name ?? "file")}`;
      if (f.url_private) f.url_private = proxied;
      if (f.url_private_download) f.url_private_download = proxied;
    }
  }

  function promote(owner: Owner) {
    owner.primary = owner.standby.shift() ?? null;
    if (!owner.primary) return;
    log("subscriber_promoted", { owner: owner.email, conn: owner.primary.id });
  }

  // Nothing is held while offline: every message gets the notice, in its thread.
  async function goOffline(env: Envelope, channel: string) {
    if (env.type !== "events_api") return; // interactions expire in seconds; drop
    const ev = (env.payload as any).event;
    await slack("chat.postMessage", {
      channel,
      thread_ts: ev.thread_ts ?? ev.ts,
      text: "Your environment is not connected. Open your workspace and try again.",
    });
  }

  // ---------- upstream event intake ----------

  function routeKey(type: string, body: any): { userId: string; channel?: string } | null {
    if (type === "events_api") {
      const ev = body?.event;
      if (ev?.type === "agent_session_stopped") return ev.user ? { userId: ev.user, channel: ev.channel } : null;
      if (!ev || ev.type !== "message" || ev.channel_type !== "im") return null;
      if (ev.bot_id || !ev.user) return null;
      if (ev.subtype && ev.subtype !== "file_share") return null;
      return { userId: ev.user, channel: ev.channel };
    }
    if (type === "interactive") {
      const userId = body?.user?.id;
      return userId ? { userId } : null;
    }
    return null; // slash commands, app_home, etc. are not routed in v1
  }

  async function onUpstream(evt: {
    ack: (payload?: unknown) => Promise<void>;
    envelope_id: string;
    type: string;
    body: any;
    accepts_response_payload?: boolean;
  }) {
    const { type, body } = evt;
    const key = routeKey(type, body);
    if (!key) return evt.ack();

    if (type === "events_api") {
      const id = body.event_id as string | undefined;
      if (id && seenEvents.has(id)) return evt.ack();
      if (id) {
        seenEvents.set(id, true);
        if (seenEvents.size > 10_000) seenEvents.delete(seenEvents.keys().next().value!);
      }
      await evt.ack(); // message events never carry a response payload
    }

    const owner = await ownerForSlackUser(key.userId);
    if (!owner) {
      log("unknown_owner", { user: key.userId });
      if (type !== "events_api") await evt.ack();
      return;
    }
    if (key.channel && key.channel !== owner.dm) {
      log("dm_mismatch", { owner: owner.email, channel: key.channel });
      if (type !== "events_api") await evt.ack();
      return;
    }

    if (type === "interactive") {
      if (body.trigger_id) owner.triggers.add(body.trigger_id);
      if (body.view?.id) owner.views.add(body.view.id);
    }
    rewriteFiles(owner, body);
    if (type === "events_api") {
      const ev = body.event;
      if (ev.type === "message") {
        addPreamble(ev, cfg.sessionPreamble, owner);
        owner.threadOf.set(ev.ts, ev.thread_ts ?? ev.ts);
        if (owner.threadOf.size > 1000) owner.threadOf.delete(owner.threadOf.keys().next().value!);
      }
    }

    const env: Envelope = {
      envelope_id: randomUUID(),
      type,
      payload: body,
      accepts_response_payload: Boolean(evt.accepts_response_payload),
      retry_attempt: 0,
      retry_reason: "",
    };

    if (!owner.primary) {
      if (type !== "events_api") await evt.ack();
      return goOffline(env, key.channel ?? owner.dm);
    }

    if (type === "events_api") {
      void send(owner.primary, env);
      return;
    }
    // Interactive: relay the daemon's ack payload (view_submission errors, etc.).
    const reply = await Promise.race([
      send(owner.primary, env),
      new Promise((r) => setTimeout(() => r(undefined), ackTimeout)),
    ]);
    await evt.ack(reply as any);
  }

  // ---------- downstream HTTP: Web API facade + file proxy ----------

  async function readParams(req: http.IncomingMessage, url: URL): Promise<Record<string, any>> {
    const params: Record<string, any> = Object.fromEntries(url.searchParams);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return params;
    const ct = req.headers["content-type"] ?? "";
    if (ct.includes("application/json")) return { ...params, ...JSON.parse(raw) };
    for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
    return params;
  }

  function bearer(req: http.IncomingMessage, params?: Record<string, any>): string | undefined {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) return h.slice(7).trim();
    return params?.token;
  }

  function channelsOf(field: string, value: unknown): string[] {
    if (value === undefined || value === null || value === "") return [];
    if (field === "channels") return String(value).split(",").map((s) => s.trim());
    return [String(value)];
  }

  // ---------- working notice ----------
  // cc-connect marks the message it is working on with 👀 and removes it when
  // the turn ends. While it stays, post a status line in the thread and
  // refresh it, so a long silent turn doesn't look hung.


  function startWorking(owner: Owner, ts: string) {
    if (!noticeMs || owner.working.has(ts)) return;
    const thread = owner.threadOf.get(ts) ?? ts;
    const started = Date.now();
    let last = "";
    const state: { timer: NodeJS.Timeout; notice?: string } = { timer: undefined as unknown as NodeJS.Timeout };
    // A different line each refresh, so the thread visibly moves: quick verbs
    // first, then "taking a while" lines with the elapsed time.
    const tick = async () => {
      if (!owner.working.has(ts)) return;
      const elapsed = Date.now() - started;
      const slow = elapsed >= slowAfterMs;
      const pool = (slow ? SLOW_WORKING_MESSAGES : WORKING_MESSAGES).filter((m) => m !== last);
      last = pool[Math.floor(Math.random() * pool.length)];
      const text = slow ? `${last} (${Math.floor(elapsed / 60_000)} min)` : last;
      state.timer = setTimeout(tick, slow ? slowNoticeMs : noticeMs);
      const r = state.notice
        ? await slack("chat.update", { channel: owner.dm, ts: state.notice, text })
        : await slack("chat.postMessage", { channel: owner.dm, thread_ts: thread, text });
      if (!owner.working.has(ts)) {
        // Turn ended while the post was in flight.
        if (!state.notice && r.ok) await slack("chat.delete", { channel: owner.dm, ts: r.ts });
        return;
      }
      if (r.ok && !state.notice) state.notice = r.ts;
    };
    owner.working.set(ts, state);
    void tick();
  }

  function stopWorking(owner: Owner, ts: string) {
    const state = owner.working.get(ts);
    if (!state) return;
    clearTimeout(state.timer);
    owner.working.delete(ts);
    if (state.notice) void slack("chat.delete", { channel: owner.dm, ts: state.notice });
  }

  async function apiCall(owner: Owner, method: string, params: Record<string, any>): Promise<any> {
    delete params.token;

    if (method === "apps.connections.open") {
      const ticket = randomUUID();
      tickets.set(ticket, { owner, exp: Date.now() + 30_000 });
      const wsBase = cfg.publicUrl.replace(/^http/, "ws");
      return { ok: true, url: `${wsBase}/socket?ticket=${ticket}` };
    }
    if (method === "conversations.list") {
      return { ok: true, channels: [], response_metadata: { next_cursor: "" } };
    }
    if (PASSTHROUGH.has(method)) return slack(method, params);

    const scoped = CHANNEL_SCOPED[method];
    if (scoped) {
      const targets = scoped.flatMap((f) => channelsOf(f, params[f]));
      const allowed = new Set([owner.dm, owner.slackUserId]);
      if (targets.length === 0 || !targets.every((c) => allowed.has(c))) {
        return { ok: false, error: "restricted_action" };
      }
      if (method === "chat.postEphemeral" && params.user !== owner.slackUserId) {
        return { ok: false, error: "restricted_action" };
      }
      // The working notice replaces cc-connect's progress reactions (👀, 🕐, …):
      // they stay off Slack, and 👀 marks the start and end of a turn.
      if (noticeMs && method.startsWith("reactions.") && params.channel === owner.dm) {
        if (params.name === "eyes") {
          if (method === "reactions.add") startWorking(owner, params.timestamp);
          else stopWorking(owner, params.timestamp);
        }
        return { ok: true };
      }
      return slack(method, params);
    }
    if (method === "views.open") {
      if (!owner.triggers.has(params.trigger_id)) return { ok: false, error: "restricted_action" };
      const r = await slack(method, params);
      if (r.ok && r.view?.id) owner.views.add(r.view.id);
      return r;
    }
    if (method === "views.update") {
      if (!owner.views.has(params.view_id)) return { ok: false, error: "restricted_action" };
      return slack(method, params);
    }
    return { ok: false, error: "restricted_action" };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gw");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === "/healthz") return json(200, { ok: true });

      const api = url.pathname.match(/^\/api\/([a-zA-Z.]+)$/);
      if (api) {
        const params = await readParams(req, url);
        const owner = await ownerForToken(bearer(req, params));
        // Slack answers HTTP 200 with ok:false; the SDK treats non-200 as unrecoverable.
        if (!owner) return json(200, { ok: false, error: "invalid_auth" });
        const result = await apiCall(owner, api[1], params);
        if (!result.ok) log("api_denied", { owner: owner.email, method: api[1], error: result.error });
        return json(200, result);
      }

      const file = url.pathname.match(/^\/files\/([^/]+)\//);
      if (file && req.method === "GET") {
        const owner = await ownerForToken(bearer(req));
        const original = owner?.files.get(decodeURIComponent(file[1]));
        if (!owner || !original) return json(404, { ok: false, error: "file_not_found" });
        const upstreamRes = await fetch(original, { headers: { authorization: `Bearer ${cfg.botToken}` } });
        res.writeHead(upstreamRes.status, {
          "content-type": upstreamRes.headers.get("content-type") ?? "application/octet-stream",
        });
        res.end(Buffer.from(await upstreamRes.arrayBuffer()));
        return;
      }
      json(404, { ok: false, error: "unknown_method" });
    } catch (err) {
      log("http_error", { error: String(err) });
      json(500, { ok: false, error: "internal_error" });
    }
  });

  // ---------- downstream WebSocket: Socket Mode facade ----------

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://gw");
    const t = url.pathname === "/socket" ? url.searchParams.get("ticket") : null;
    const entry = t ? tickets.get(t) : undefined;
    if (t) tickets.delete(t); // single use
    if (!entry || entry.exp < Date.now()) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(entry.owner, ws));
  });

  function attach(owner: Owner, ws: WebSocket) {
    const conn: Conn = { id: randomUUID().slice(0, 8), ws, alive: true, pending: new Map() };
    // Claim is synchronous on the event loop, so two upgrades cannot both become primary.
    const role = owner.primary ? "standby" : "primary";
    if (role === "primary") owner.primary = conn;
    else owner.standby.push(conn);
    log("subscriber_connected", { owner: owner.email, conn: conn.id, role });

    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const resolve = msg?.envelope_id ? conn.pending.get(msg.envelope_id) : undefined;
      if (resolve) {
        conn.pending.delete(msg.envelope_id);
        resolve(msg.payload && Object.keys(msg.payload).length > 0 ? msg.payload : undefined);
      }
    });
    ws.on("close", () => {
      for (const r of conn.pending.values()) r(undefined);
      if (owner.primary === conn) {
        log("subscriber_lost", { owner: owner.email, conn: conn.id });
        for (const ts of [...owner.working.keys()]) stopWorking(owner, ts); // its turns died with it
        promote(owner);
      } else {
        owner.standby = owner.standby.filter((c) => c !== conn);
      }
    });
    ws.send(JSON.stringify({ type: "hello", num_connections: 1, debug_info: { gateway: true } }));
  }

  const pinger = setInterval(() => {
    for (const owner of owners.values()) {
      for (const c of [owner.primary, ...owner.standby]) {
        if (!c) continue;
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }
  }, cfg.pingIntervalMs ?? 10_000);

  // ---------- lifecycle ----------

  const upstreamClient = new SocketModeClient({
    appToken: cfg.appToken,
    clientOptions: { slackApiUrl: upstream },
  });
  upstreamClient.on("slack_event", (evt) => {
    onUpstream(evt).catch((err) => log("upstream_error", { error: String(err) }));
  });

  return {
    async start() {
      await new Promise<void>((r) => server.listen(cfg.port, r));
      await upstreamClient.start();
      log("gateway_started", { port: cfg.port });
    },
    async stop() {
      clearInterval(pinger);
      for (const o of owners.values()) for (const ts of [...o.working.keys()]) stopWorking(o, ts);
      await upstreamClient.disconnect();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
    /** For tests and metrics. */
    state(email: string) {
      const o = ownerByEmail.get(email);
      return o ? { primary: o.primary?.id ?? null, standby: o.standby.length } : null;
    },
  };
}
