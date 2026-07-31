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

test("memory context preserves chronological order, clip boundaries, gaps, and scene offsets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "afterimage-timeline-test-"));
  try {
    const day = path.join("2026", "0729");
    const clips = [
      {
        filename: "later-name.mp4",
        captured_at: "2026-07-29T01:00:00+09:00",
        duration_seconds: 30,
        scenes: [{ timestamp_seconds: 5, description: "A pool is visible.", labels: ["pool"] }],
      },
      {
        filename: "earlier-name.mp4",
        captured_at: "2026-07-29T00:30:00Z",
        duration_seconds: 45,
        scenes: [{ timestamp_seconds: 12, description: "A dog is resting at home.", labels: ["dog"] }],
        transcript: {
          text: "The dog is resting.",
          segments: [{ start_seconds: 3, end_seconds: 4.5, text: "The dog is resting." }],
        },
      },
    ];
    for (const clip of clips) {
      const video = path.join(root, "daily", day, clip.filename);
      await mkdir(path.dirname(video), { recursive: true });
      await writeFile(video, "video");
      await writeJson(path.join(root, "metadata", day, `${clip.filename}.json`), {
        id: clip.filename,
        captured_at: clip.captured_at,
        capture_time_source: clip.filename === "later-name.mp4" ? "filesystem_mtime_fallback" : "metadata",
        duration_seconds: clip.duration_seconds,
        status: "completed",
      });
      await writeJson(path.join(root, "scenes", day, `${clip.filename}.json`), {
        summary: clip.scenes[0].description,
        scenes: clip.scenes,
      });
      if (clip.transcript) {
        await writeJson(path.join(root, "transcripts", day, `${clip.filename}.json`), clip.transcript);
      }
    }

    const entries = await loadEntries(root, { assetOrigin: "http://localhost:8901" });
    assert.deepEqual(entries.map((entry) => entry.filename), ["later-name.mp4", "earlier-name.mp4"]);

    const memory = buildMemoryContext(entries, "2026-07-29", {
      origin: "http://localhost:8901",
      timeZone: "Asia/Tokyo",
    });
    assert.deepEqual(memory.timeline.map((item) => item.filename), ["later-name.mp4", "earlier-name.mp4"]);
    assert.equal(memory.timeline[0].captureTimeSource, "filesystem_mtime_fallback");
    assert.equal(memory.timeline[0].startAtLocal, "2026-07-29 01:00:00");
    assert.equal(memory.timeline[0].endAtLocal, "2026-07-29 01:00:30");
    assert.equal(memory.timeline[1].scenes[0].offset, "00:12");
    assert.equal(memory.timeline[1].scenes[0].absoluteAtLocal, "2026-07-29 09:30:12");
    assert.equal(memory.timeline[1].transcriptSegments[0].start, "00:03");
    assert.equal(memory.timeline[1].transcriptSegments[0].absoluteStartAtLocal, "2026-07-29 09:30:03");
    assert.equal(memory.timeline[1].transcriptSegments[0].absoluteEndAtLocal, "2026-07-29 09:30:04");
    assert.equal(memory.timeline[1].transcriptSegments[0].absoluteStartAtUtc, "2026-07-29T00:30:03.000Z");
    assert.equal(memory.timeline[1].transcriptSegments[0].absoluteEndAtUtc, "2026-07-29T00:30:04.500Z");
    assert.equal(memory.timeline[1].gapAfterPreviousEndSeconds, 30570);
    assert.match(memory.markdown, /Chronological timeline/);
    assert.match(memory.markdown, /Capture end \(estimated\)/);
    assert.match(memory.markdown, /Gap after previous clip: 08:29:30/);
    assert.match(memory.markdown, /\+00:12 .*A dog is resting at home\./);
    assert.match(memory.markdown, /absolute local 2026-07-29 09:30:03–2026-07-29 09:30:04/);
    assert.match(memory.markdown, /\+00:03–\+00:04\.500 .*The dog is resting\./);
    assert.ok(memory.markdown.indexOf("later-name.mp4") < memory.markdown.indexOf("earlier-name.mp4"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
