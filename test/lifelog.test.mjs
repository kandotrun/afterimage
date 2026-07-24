import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildMemoryContext, loadEntries, searchEntries } from "../src/lifelog.mjs";

async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value)}\n`);
}

test("scene analysis is loaded, searchable, and included in memory context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "afterimage-lifelog-test-"));
  try {
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
      version: 1,
      provider: "ollama",
      model: "qwen3-vl:8b",
      summary: "A child is drawing at the kitchen table.",
      scenes: [{
        timestamp_seconds: 1,
        description: "A child is drawing at the kitchen table.",
        labels: ["child", "drawing", "kitchen"],
      }],
    });

    const entries = await loadEntries(root, { assetOrigin: "http://localhost:8901" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].sceneAnalysis.summary, "A child is drawing at the kitchen table.");
    assert.equal(entries[0].sceneAnalysis.scenes[0].labels[2], "kitchen");

    const search = searchEntries(entries, "kitchen drawing");
    assert.equal(search.total, 1);
    assert.match(search.items[0].snippet, /kitchen table/i);
    assert.equal(search.items[0].sceneSummary, "A child is drawing at the kitchen table.");

    const memory = buildMemoryContext(entries, "2026-07-24", { origin: "http://localhost:8901" });
    assert.match(memory.markdown, /Visual context: A child is drawing at the kitchen table\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
