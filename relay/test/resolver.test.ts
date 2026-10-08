import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { tokenResolver } from "../src/resolver.ts";

async function fakeIdentity(handler: (token: string | undefined) => [number, unknown]) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    assert.equal(req.url, "/whoami");
    const [status, body] = handler(req.headers["x-agent-token"] as string | undefined);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/whoami`;
  return { url, calls: () => calls, close: () => new Promise((r) => server.close(r)) };
}

const cfg = (url: string, emailField = "email") => ({ url, header: "X-Agent-Token", emailField });

test("a token resolves to the email at the configured field, cached", async () => {
  const id = await fakeIdentity((t) => (t === "good" ? [200, { data: { id: 7, email: "Pepe@example.com" } }] : [401, {}]));
  const resolve = tokenResolver(cfg(id.url, "data.email"));
  assert.equal(await resolve("good"), "pepe@example.com");
  assert.equal(await resolve("good"), "pepe@example.com");
  assert.equal(id.calls(), 1);
  await id.close();
});

test("an unknown token resolves to nobody, and that is cached too", async () => {
  const id = await fakeIdentity(() => [401, { message: "unauthorized" }]);
  const resolve = tokenResolver(cfg(id.url));
  assert.equal(await resolve("bad"), null);
  assert.equal(await resolve("bad"), null);
  assert.equal(id.calls(), 1);
  await id.close();
});

test("a 2xx reply without the email (null, missing field) resolves to nobody", async () => {
  for (const body of [null, {}, { email: "" }, { email: 3 }]) {
    const id = await fakeIdentity(() => [200, body]);
    assert.equal(await tokenResolver(cfg(id.url))("t"), null, JSON.stringify(body));
    await id.close();
  }
});

test("the cache expires, so a token revoked when its workspace stops stops working", async () => {
  let valid = true;
  const id = await fakeIdentity(() => (valid ? [200, { email: "pepe@example.com" }] : [401, {}]));
  const resolve = tokenResolver(cfg(id.url), 50);
  assert.equal(await resolve("t"), "pepe@example.com");
  valid = false;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await resolve("t"), null);
  await id.close();
});

test("the endpoint being down is an error, not a rejection", async () => {
  const id = await fakeIdentity(() => [503, {}]);
  await assert.rejects(tokenResolver(cfg(id.url))("t"), /auth resolver: 503/);
  await id.close();
});
