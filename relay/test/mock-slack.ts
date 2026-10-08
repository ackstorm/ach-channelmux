// Minimal fake of the Slack side the gateway talks to: Web API + Socket Mode.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

export const BOT_TOKEN = "xoxb-real";
export const APP_TOKEN = "xapp-real";

export interface Call {
  method: string;
  token: string;
  params: Record<string, string>;
}

export function createMockSlack(users: Record<string, string>) {
  // users: slack user id -> email
  const calls: Call[] = [];
  const windows = new Map<string, number[]>();
  const acks = new Map<string, (payload: unknown) => void>();
  let socket: WebSocket | null = null;
  let lastTs = 0;
  let port = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://slack");
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith("/files/")) {
      if (req.headers.authorization !== `Bearer ${BOT_TOKEN}`) return send({ ok: false }, 403);
      res.writeHead(200, { "content-type": "text/plain" });
      if (url.pathname.endsWith(".vtt")) return res.end("WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nhello from\n\n2\n00:00:02.000 --> 00:00:04.000\na voice note\n");
      return res.end(`content of ${url.pathname.split("/")[2]}`);
    }
    if (url.pathname.startsWith("/upload/")) {
      const body: Buffer[] = [];
      for await (const c of req) body.push(c as Buffer);
      mock.uploads.set(url.pathname.split("/")[2], { body: Buffer.concat(body).toString(), auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("OK");
    }
    const method = url.pathname.replace(/^\/api\//, "");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const params = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    const token = (req.headers.authorization ?? "").replace("Bearer ", "");
    calls.push({ method, token, params });

    const limit = mock.limits[method];
    if (limit) {
      const now = Date.now();
      const hits = (windows.get(method) ?? []).filter((t) => now - t < limit.windowMs);
      if (hits.length >= limit.max) {
        mock.rateLimited++;
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        return res.end(JSON.stringify({ ok: false, error: "ratelimited" }));
      }
      windows.set(method, [...hits, now]);
    }
    const failure = mock.fail.get(method);
    if (failure) return send({ ok: false, error: failure });

    switch (method) {
      case "apps.connections.open":
        if (token !== APP_TOKEN) return send({ ok: false, error: "invalid_auth" });
        return send({ ok: true, url: `ws://127.0.0.1:${port}/link` });
      case "auth.test":
        return send({ ok: true, user_id: "UBOT", bot_id: "BBOT", team_id: "T1", user: "gw-bot" });
      case "users.lookupByEmail": {
        const id = Object.keys(users).find((u) => users[u] === params.email);
        return send(id ? { ok: true, user: { id } } : { ok: false, error: "users_not_found" });
      }
      case "users.info":
        return send(users[params.user]
          ? { ok: true, user: { id: params.user, tz: "Europe/Madrid", profile: { email: users[params.user], real_name: `Real ${params.user}` } } }
          : { ok: false, error: "user_not_found" });
      case "conversations.open":
        return send({ ok: true, channel: { id: `D_${params.users}` } });
      case "files.getUploadURLExternal": {
        const id = `F_UP${mock.uploads.size + 1}`;
        return send({ ok: true, upload_url: `http://127.0.0.1:${port}/upload/${id}`, file_id: id });
      }
      case "conversations.replies":
        return send({ ok: true, messages: mock.replies?.(params) ?? [] });
      case "views.update":
        // Like Slack: an empty value fails the view schema (e.g. a button's value).
        if (params.view?.includes('"value":""')) return send({ ok: false, error: "invalid_arguments" });
        return send({ ok: true, view: { id: params.view_id } });
      case "views.open":
        if (params.view?.includes('"value":""')) return send({ ok: false, error: "invalid_arguments" });
        return send({ ok: true, view: { id: "V_OPENED" } });
      default: {
        // Strictly increasing, like Slack's: a thread is ordered by ts.
        lastTs = Math.max(lastTs + 0.000001, Date.now() / 1000);
        const ts = lastTs.toFixed(6);
        if (method === "chat.postMessage") mock.onPost?.(params, ts);
        return send({ ok: true, ts });
      }
    }
  });

  const wss = new WebSocketServer({ server, path: "/link" });
  wss.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      acks.get(msg.envelope_id)?.(msg.payload);
      acks.delete(msg.envelope_id);
    });
    ws.send(JSON.stringify({ type: "hello", num_connections: 1 }));
  });

  const mock = {
    calls,
    /** Optional hook: sees each chat.postMessage and the ts the mock returned. */
    onPost: undefined as ((params: Record<string, string>, ts: string) => void) | undefined,
    /** Per-method sliding windows; over the limit answers HTTP 429 with Retry-After: 1. */
    limits: {} as Record<string, { max: number; windowMs: number }>,
    /** Optional: the messages conversations.replies answers. */
    replies: undefined as ((params: Record<string, string>) => unknown[]) | undefined,
    /** Methods that answer ok:false with this error. */
    fail: new Map<string, string>(),
    /** Bodies posted to the upload URLs from files.getUploadURLExternal, by file id. */
    uploads: new Map<string, { body: string; auth?: string }>(),
    /** How many 429s were answered. */
    rateLimited: 0,
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    async start() {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as any).port;
    },
    async stop() {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
    /** Push an envelope to the gateway; resolves with the ack payload. */
    emit(type: string, payload: unknown, accepts = false): Promise<unknown> {
      const envelope_id = randomUUID();
      return new Promise((resolve) => {
        acks.set(envelope_id, resolve);
        socket!.send(JSON.stringify({ envelope_id, type, payload, accepts_response_payload: accepts }));
      });
    },
    dm(user: string, text: string, extra: Record<string, unknown> = {}) {
      // Same envelope as real Slack: slack-go dispatches on the outer "type".
      return {
        type: "event_callback",
        event_id: `Ev${randomUUID().slice(0, 8)}`,
        team_id: "T1",
        api_app_id: "A1",
        event: { type: "message", channel_type: "im", channel: `D_${user}`, user, text, ts: `${Date.now() / 1000}`, ...extra },
      };
    },
  };
  return mock;
}
