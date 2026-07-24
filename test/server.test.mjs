import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAfterimageServer } from "../src/server.mjs";

async function withServer(options, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "afterimage-server-test-"));
  await mkdir(path.join(root, "daily"), { recursive: true });
  const server = createAfterimageServer({ root, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await callback(origin);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

test("bearer token protects private routes while health stays public", async () => {
  await withServer({ auth: { token: "test-secret" } }, async (origin) => {
    const health = await fetch(`${origin}/_health`);
    assert.equal(health.status, 200);

    const anonymous = await fetch(`${origin}/api/entries`);
    assert.equal(anonymous.status, 401);

    const authorized = await fetch(`${origin}/api/entries`, {
      headers: { authorization: "Bearer test-secret" },
    });
    assert.equal(authorized.status, 200);
  });
});

test("basic credentials protect the browser UI", async () => {
  await withServer({ auth: { username: "kan", password: "camera" } }, async (origin) => {
    const anonymous = await fetch(`${origin}/app`, { redirect: "manual" });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate") || "", /^Basic /);

    const credential = Buffer.from("kan:camera").toString("base64");
    const authorized = await fetch(`${origin}/app`, {
      headers: { authorization: `Basic ${credential}` },
    });
    assert.equal(authorized.status, 200);
  });
});
