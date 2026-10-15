// Slack relay.
//
// One upstream Socket Mode connection to the real Slack app; per-user
// downstream daemons (any Bolt app) connect to this gateway as if
// it were Slack by pointing their Slack API base URL here. The gateway:
//   - fans DM events out to the single active daemon of the sender,
//   - proxies an allowlist of Web API methods with the real bot token, scoped
//     to the owner's DM,
//   - proxies inbound file downloads so daemons never hold the bot token,
//   - refuses a second daemon of the same owner while one is connected,
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
  /** Instructions appended, with who the user is and their local time, to the first message of each thread (a top-level DM starts a new agent session). Empty disables it. */
  sessionPreamble?: string;
  /** Reply to a message while no daemon is connected (e.g. how to start the workspace). */
  offlineMessage?: string;
  /** Channel name -> the owner whose daemon serves its mentions; code channels open a Slack code channel. Default: DMs only. */
  channels?: Record<string, { email: string; code: boolean }>;
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
  primary: Conn | null; // the owner's one daemon
  triggers: Set<string>;
  views: Set<string>;
  files: Map<string, string>; // fileId -> original url_private_download
  threadOf: Map<string, string>; // message ts -> its thread root, for messages delivered to the daemon (in a channel, those for the agent)
}

// Methods whose target (channel, or user for users.info) must be the owner's DM or the owner, one of its
// CHANNELS or a code channel it opened.
const CHANNEL_SCOPED: Record<string, string[]> = {
  "chat.postMessage": ["channel"],
  "chat.update": ["channel"],
  "chat.delete": ["channel"],
  "chat.postEphemeral": ["channel"],
  "chat.getPermalink": ["channel"],
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
  "agents.conversations.setProperties": ["channel_id"],
  "agents.conversations.setView": ["channel_id"],
  "agents.conversations.archive": ["channel_id"],
};
const PASSTHROUGH = new Set(["auth.test", "team.info", "files.getUploadURLExternal"]);
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
 * session. Thread replies, edits and other events, and commands ("/cmd", "$cmd", "!shell",
 * also with leading spaces) pass untouched: the daemon would read the preamble as arguments.
 */
export function wantsPreamble(ev: { type?: string; subtype?: string; text?: string; thread_ts?: string }, preamble: string | undefined) {
  if (!preamble || ev.type !== "message" || ev.thread_ts) return false;
  if (ev.subtype && ev.subtype !== "file_share") return false;
  return !/^\s*[/!$]/.test(ev.text ?? "");
}

export function addPreamble(
  ev: { type?: string; subtype?: string; text?: string; ts?: string; thread_ts?: string },
  preamble: string | undefined,
  user: { email?: string; name?: string; tz?: string },
) {
  if (!wantsPreamble(ev, preamble)) return;
  const who = user.name && user.email ? `${user.name} <${user.email}>` : user.name || user.email;
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

// A message shortcut starts a session from someone else's message: it gets the context block too.
export function addShortcutPreamble(
  body: { type?: string; message?: { text?: string } },
  preamble: string | undefined,
  user: { email: string; name?: string; tz?: string },
) {
  if (body.type !== "message_action" || !body.message) return;
  const m = { type: "message", text: body.message.text ?? "" };
  addPreamble(m, preamble, user);
  body.message.text = m.text;
}

/** "name=email,…" and "name,…" (a leading # is dropped) -> channel name -> its owner. */
export function parseChannels(channels: string, code: string): Record<string, { email: string; code: boolean }> {
  const names = (s: string) => s.split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean);
  const out: Record<string, { email: string; code: boolean }> = {};
  for (const entry of channels.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [name, email] = entry.split("=").map((x) => x?.trim());
    if (!name || !email) throw new Error(`CHANNELS: "${entry}" is not name=email`);
    out[name.replace(/^#/, "")] = { email: email.toLowerCase(), code: false };
  }
  for (const name of names(code)) {
    if (!out[name]) throw new Error(`CODE_CHANNELS: ${name} is not in CHANNELS`);
    out[name].code = true;
  }
  return out;
}

export function createGateway(cfg: GatewayConfig) {
  const log = cfg.log ?? ((m, d) => console.log(JSON.stringify({ msg: m, ...d })));
  const upstream = cfg.upstreamApiUrl.endsWith("/") ? cfg.upstreamApiUrl : cfg.upstreamApiUrl + "/";
  const ackTimeout = cfg.interactiveAckTimeoutMs ?? 2500;

  const owners = new Map<string, Owner>(); // by slack user id
  const ownerByEmail = new Map<string, Owner>();
  const tickets = new Map<string, { owner: Owner; exp: number }>();
  const seenEvents = new Map<string, true>();
  let botUserId = ""; // the app's bot user, from auth.test at start: a mention of it is "<@id>"

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
    email = email.toLowerCase(); // the resolver's and CHANNELS' emails meet in one owner
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
      if (r.ok) user = r.user as SlackUser;
      // No Slack user: only a service account that owns a channel, which serves just its channels (no DM).
      else if (r.error !== "users_not_found" || !Object.values(cfg.channels ?? {}).some((c) => c.email === email)) return null;
    }
    let dm = "";
    if (user) {
      const im = await slack("conversations.open", { users: user.id });
      if (!im.ok) return null;
      dm = im.channel.id;
    }
    const owner: Owner = {
      slackUserId: user?.id ?? "",
      email,
      name: user?.profile?.real_name || user?.real_name || undefined,
      tz: user?.tz,
      dm,
      primary: null,
      triggers: new Set(),
      views: new Set(),
      files: new Map(),
      threadOf: new Map(),
    };
    if (user) owners.set(user.id, owner);
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

  const codeChannels = new Map<string, Owner>(); // code channel id -> the owner whose daemon opened it

  // Channel id -> its CHANNELS entry, null when unmapped. A failed lookup is not cached.
  // A code channel the relay did not see opened (e.g. before a restart) is recorded in codeChannels,
  // and is null here: it belongs to the owner of the CODE_CHANNELS channel it was opened from.
  const channelEntries = new Map<string, { email: string; code: boolean } | null>();
  async function channelEntry(id: string): Promise<{ email: string; code: boolean } | null | undefined> {
    if (channelEntries.has(id)) return channelEntries.get(id);
    const r = await slack("conversations.info", { channel: id });
    if (!r.ok) return undefined;
    const origin = r.channel?.properties?.agent_session?.origin_link?.channel_id;
    const from = origin ? await channelEntry(origin) : null;
    if (from === undefined) return undefined; // its origin's lookup failed: try again next time
    if (from?.code) {
      const owner = await ownerFor(from.email);
      if (!owner) return undefined;
      codeChannels.set(id, owner);
    }
    // By id first: an id survives a rename, and a new channel cannot take it as a free name can.
    const entry = from?.code ? null : cfg.channels?.[id] ?? cfg.channels?.[r.channel?.name] ?? null;
    channelEntries.set(id, entry);
    return entry;
  }
  const viewOwner = new Map<string, Owner>(); // view id -> the owner whose daemon it was delivered to or opened by

  // A channel message's author, for its context block. A failed lookup is not cached.
  const authors = new Map<string, Promise<{ email?: string; name?: string; tz?: string }>>();
  function authorOf(userId: string) {
    let p = authors.get(userId);
    if (!p) {
      p = slack("users.info", { user: userId }).then((r) => {
        if (!r.ok) authors.delete(userId);
        const u = r.user as SlackUser | undefined;
        return { email: u?.profile?.email, name: u?.profile?.real_name || u?.real_name || `<@${userId}>`, tz: u?.tz };
      });
      authors.set(userId, p);
    }
    return p;
  }

  // "" (a service account's DM and user) is nobody's.
  async function mayWrite(owner: Owner, id: string) {
    if (!id) return false;
    if (id === owner.dm || id === owner.slackUserId) return true;
    const entry = codeChannels.has(id) ? undefined : await channelEntry(id); // may find a code channel
    if (codeChannels.has(id)) return codeChannels.get(id) === owner; // never in CHANNELS
    return entry?.email === owner.email;
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

  function rewriteFiles(owner: Owner, files: any) {
    if (!Array.isArray(files)) return;
    const proxy = (key: string, name: string, original: string) => {
      owner.files.set(key, original);
      return `${cfg.publicUrl}/files/${encodeURIComponent(key)}/${encodeURIComponent(name)}`;
    };
    for (const f of files) {
      if (!f.id) continue;
      if (f.vtt) f.vtt = proxy(`${f.id}.vtt`, "transcript.vtt", f.vtt); // a voice clip's transcript
      const original = f.url_private_download ?? f.url_private;
      if (!original) continue;
      const proxied = proxy(f.id, f.name ?? "file", original);
      if (f.url_private) f.url_private = proxied;
      if (f.url_private_download) f.url_private_download = proxied;
    }
  }

  // Nothing is held while offline: every message for the agent gets the notice, where it was written.
  async function goOffline(env: Envelope, channel: string, inChannel: boolean) {
    if (env.type !== "events_api") return; // interactions expire in seconds; drop
    const ev = (env.payload as any).event.message ?? (env.payload as any).event; // an edit carries the message inside
    // The Home tab says so itself: the daemon that would draw it is not there.
    if (ev.type === "app_home_opened") {
      const text = `*Your agent*\n🔴 Offline\n${cfg.offlineMessage ?? "Your workspace is offline. Start it and try again."}`;
      await slack("views.publish", { user_id: ev.user, view: JSON.stringify({ type: "home", blocks: [{ type: "section", text: { type: "mrkdwn", text } }] }) });
      return;
    }
    await slack("chat.postMessage", {
      channel,
      // A top-level DM stays top-level: no thread for a session that never started. In a channel it goes
      // in the message's thread, out of the channel's main view.
      thread_ts: inChannel ? ev.thread_ts ?? ev.ts : ev.thread_ts,
      text: cfg.offlineMessage ?? "Your workspace is offline. Start it and try again.",
    });
  }

  // ---------- upstream event intake ----------

  // A DM is routed by its author; a channel (no userId) by its CHANNELS owner, whoever wrote in it.
  function routeKey(type: string, body: any): { userId?: string; channel?: string } | null {
    if (type === "events_api") {
      const ev = body?.event;
      if (ev?.type === "app_home_opened") return ev.tab === "home" && ev.user ? { userId: ev.user } : null;
      const inChannel = ev?.channel_type === "channel" || ev?.channel_type === "group";
      if (!ev || ev.type !== "message" || (ev.channel_type !== "im" && !inChannel)) return null;
      const to = (userId: string) => (inChannel ? { channel: ev.channel } : { userId, channel: ev.channel });
      // A user's edit: the author is inside. Bot edits (every chat.update) and unfurls (same text) stay out.
      if (ev.subtype === "message_changed") {
        const m = ev.message;
        if (!m?.user || m.bot_id || m.text === ev.previous_message?.text) return null;
        return to(m.user);
      }
      if (ev.bot_id || !ev.user) return null;
      if (ev.subtype && ev.subtype !== "file_share") return null;
      return to(ev.user);
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

    const inChannel = !key.userId;
    // An interaction in a channel (anyone may click there) is the channel owner's, like its messages.
    // Shortcuts stay personal: they go to whoever used them.
    const byChannel = type === "interactive" && ["block_actions", "view_submission", "view_closed"].includes(body.type);
    const where = inChannel ? key.channel! : byChannel ? body.channel?.id ?? body.container?.channel_id : undefined;
    const entry = where && !codeChannels.has(where) && !where.startsWith("D") ? await channelEntry(where) : undefined; // may find a code channel
    const codeOwner = where ? codeChannels.get(where) : undefined; // never in CHANNELS
    if (inChannel && !codeOwner && !entry) {
      if (entry === null) log("channel_unmapped", { channel: key.channel });
      return;
    }
    // A modal's submit has no channel: the view says whose it is.
    const owner = codeOwner ?? (entry ? await ownerFor(entry.email) : viewOwner.get(body?.view?.id) ?? (await ownerForSlackUser(key.userId!)));
    if (!owner) {
      log("unknown_owner", { user: key.userId, channel: key.channel });
      if (type !== "events_api") await evt.ack();
      return;
    }
    if (!inChannel && key.channel && key.channel !== owner.dm) {
      log("dm_mismatch", { owner: owner.email, channel: key.channel });
      if (type !== "events_api") await evt.ack();
      return;
    }

    if (type === "interactive") {
      if (body.trigger_id) owner.triggers.add(body.trigger_id);
      if (body.view?.id) {
        owner.views.add(body.view.id);
        viewOwner.set(body.view.id, owner);
      }
      addShortcutPreamble(body, cfg.sessionPreamble, owner);
    }
    rewriteFiles(owner, body?.event?.files);
    let quiet = false; // a channel message not for the agent: no offline notice
    if (type === "events_api") {
      const ev = body.event;
      if (entry?.code) ev.code_channel_origin = true; // the daemon's only hint: it never sees CHANNELS
      // In a channel only the owner runs shell commands ("!…", also with a mention of the bot). A top-level
      // message that does not mention the agent is not for it, so "!!! great" there passes. Any thread may be
      // the agent's: this relay forgets them on a restart.
      const mention = `<@${botUserId}>`;
      const mentioned = (ev.text ?? "").includes(mention);
      const forAgent = Boolean(codeOwner || ev.thread_ts || mentioned);
      // Offline, a channel message gets the notice only when it surely is the agent's: in a code channel, a
      // mention, or in the thread of one this relay forwarded.
      quiet = inChannel && !codeOwner && !(ev.thread_ts ? owner.threadOf.has(ev.thread_ts) : mentioned);
      if (inChannel && forAgent && ev.type === "message" && ev.subtype !== "message_changed" && ev.user !== owner.slackUserId && /^\s*!/.test((ev.text ?? "").replaceAll(mention, ""))) {
        log("shell_refused", { owner: owner.email, channel: ev.channel, user: ev.user });
        const text = owner.slackUserId ? `🔒 Only <@${owner.slackUserId}> can run shell commands here.` : "🔒 Shell commands are off in this channel.";
        await slack("chat.postEphemeral", { channel: ev.channel, user: ev.user, thread_ts: ev.thread_ts ?? ev.ts, text });
        return;
      }
      if (ev.type === "message") {
        // The context block names who wrote it: in a channel that is not always the owner.
        const author = inChannel && ev.user && wantsPreamble(ev, cfg.sessionPreamble) ? await authorOf(ev.user) : owner;
        addPreamble(ev, cfg.sessionPreamble, author);
        if (!quiet) owner.threadOf.set(ev.ts, ev.thread_ts ?? ev.ts);
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
      return quiet ? undefined : goOffline(env, key.channel ?? owner.dm, inChannel);
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

  async function apiCall(owner: Owner, method: string, params: Record<string, any>): Promise<any> {
    delete params.token;

    if (method === "apps.connections.open") {
      // One daemon per owner: a second one is refused while the first is connected, and stops (see the daemon).
      if (owner.primary) return { ok: false, error: "already_connected" };
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
      // users.info: anyone once the owner serves a channel (the daemon names who wrote each message); the app's own
      // bot user always (its avatar, the app's icon, shows on the daemon's Home tab).
      const hasChannels = Object.values(cfg.channels ?? {}).some((c) => c.email === owner.email);
      const mine = (c: string) => (method === "users.info" && (hasChannels || c === botUserId)) || mayWrite(owner, c);
      if (targets.length === 0 || !(await Promise.all(targets.map(mine))).every(Boolean)) {
        return { ok: false, error: "restricted_action" };
      }
      // In the DM only to the owner; in a channel to anyone (e.g. an edit's author).
      const inDm = params.channel === owner.dm || params.channel === owner.slackUserId;
      if (method === "chat.postEphemeral" && inDm && params.user !== owner.slackUserId) {
        return { ok: false, error: "restricted_action" };
      }
      const r = await slack(method, params);
      if (method === "conversations.replies") for (const m of r.messages ?? []) rewriteFiles(owner, m.files); // e.g. a clip's finished transcript
      return r;
    }
    if (method === "agents.conversations.create") {
      // Only from one of the owner's CODE_CHANNELS; the new channel is then the owner's.
      const origin = params.origin_channel_id ? await channelEntry(params.origin_channel_id) : undefined;
      if (!origin?.code || origin.email !== owner.email) return { ok: false, error: "restricted_action" };
      const r = await slack(method, params);
      if (r.ok) codeChannels.set(r.channel_id, owner);
      return r;
    }
    if (method === "views.open") {
      if (!owner.triggers.has(params.trigger_id)) return { ok: false, error: "restricted_action" };
      const r = await slack(method, params);
      if (r.ok && r.view?.id) {
        owner.views.add(r.view.id);
        viewOwner.set(r.view.id, owner);
      }
      return r;
    }
    if (method === "views.update") {
      if (!owner.views.has(params.view_id)) return { ok: false, error: "restricted_action" };
      return slack(method, params);
    }
    if (method === "views.publish") {
      if (params.user_id !== owner.slackUserId) return { ok: false, error: "restricted_action" }; // only the owner's Home tab
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
    // Two daemons that got a ticket before either connected: the first wins. Claim is synchronous on the event loop.
    // ponytail: the loser's Socket Mode client then retries until the slot frees, as a reconnecting daemon does.
    if (owner.primary) {
      log("subscriber_refused", { owner: owner.email, conn: conn.id });
      return ws.close(4009, "already_connected");
    }
    owner.primary = conn;
    log("subscriber_connected", { owner: owner.email, conn: conn.id });

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
      if (owner.primary !== conn) return;
      log("subscriber_lost", { owner: owner.email, conn: conn.id });
      owner.primary = null;
    });
    ws.send(JSON.stringify({ type: "hello", num_connections: 1, debug_info: { gateway: true } }));
  }

  const pinger = setInterval(() => {
    for (const owner of ownerByEmail.values()) {
      const c = owner.primary;
      if (!c) continue;
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
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
      const me = await slack("auth.test", {});
      if (!me.ok) throw new Error(`auth.test: ${me.error}`);
      botUserId = me.user_id;
      await upstreamClient.start();
      log("gateway_started", { port: cfg.port });
    },
    async stop() {
      clearInterval(pinger);
      await upstreamClient.disconnect();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
    /** For tests and metrics. */
    state(email: string) {
      const o = ownerByEmail.get(email);
      return o ? { primary: o.primary?.id ?? null } : null;
    },
  };
}
