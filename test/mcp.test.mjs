import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createAfterimageServer } from "../src/server.mjs";

async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value)}\n`);
}

test("authenticated MCP client lists visual context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "afterimage-mcp-test-"));
  const filename = "clip.mp4";
  const day = path.join("2026", "0724");
  const video = path.join(root, "daily", day, filename);
  await mkdir(path.dirname(video), { recursive: true });
  await writeFile(video, "video");
  await writeJson(path.join(root, "metadata", day, `${filename}.json`), {
    id: "entry-1",
    captured_at: "2026-07-24T10:00:00Z",
    duration_seconds: 30,
    status: "completed",
  });
  await writeJson(path.join(root, "scenes", day, `${filename}.json`), {
    provider: "ollama",
    model: "qwen3-vl:8b",
    summary: "A dog is sleeping beside a sofa.",
    scenes: [{ timestamp_seconds: 1, description: "A dog is sleeping beside a sofa.", labels: ["dog", "sofa"] }],
  });

  const server = createAfterimageServer({ root, auth: { token: "mcp-secret" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: "afterimage-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: "Bearer mcp-secret" } },
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "list_daily_entries",
      arguments: { date: "2026-07-24", limit: 10 },
    });
    assert.equal(result.structuredContent.items[0].hasSceneAnalysis, true);
    assert.equal(result.structuredContent.items[0].sceneSummary, "A dog is sleeping beside a sofa.");

    const context = await client.callTool({
      name: "get_daily_memory_context",
      arguments: { date: "2026-07-24" },
    });
    assert.equal(context.structuredContent.timezone, "Asia/Tokyo");
    assert.equal(context.structuredContent.timeline[0].startAtLocal, "2026-07-24 19:00:00");
    assert.equal(context.structuredContent.timeline[0].scenes[0].offset, "00:01");
    assert.match(context.structuredContent.markdown, /Chronological timeline/);
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
