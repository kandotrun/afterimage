import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const VIDEO_EXTENSIONS = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]);

function normalizeDate(value) {
  if (!value) return "";
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const candidate = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) return "";
  return candidate;
}

function dateParts(value) {
  const normalized = normalizeDate(value);
  if (!normalized) return null;
  const [year, month, day] = normalized.split("-");
  return { date: normalized, year, dayDirectory: `${month}${day}` };
}

function dateFromDirectories(year, dayDirectory) {
  if (!/^\d{4}$/.test(year) || !/^\d{4}$/.test(dayDirectory)) return "";
  const month = dayDirectory.slice(0, 2);
  const day = dayDirectory.slice(2);
  const candidate = `${year}-${month}-${day}`;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) return "";
  return candidate;
}

function encodedPath(...segments) {
  return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function assetUrl(relativePath, assetOrigin) {
  return assetOrigin ? new URL(relativePath, assetOrigin).href : relativePath;
}

async function readJsonOptional(filename) {
  try {
    const body = await readFile(filename, "utf8");
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function stableId(relativePath) {
  return createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
}

function transcriptPayload(body) {
  if (!body) return null;
  const text = String(body.text || body.corrected_text || body.raw_text || "").trim();
  if (!text) return null;
  const segments = Array.isArray(body.segments)
    ? body.segments.map((segment) => {
      const startSeconds = Number(segment?.start_seconds ?? segment?.start ?? 0);
      const endSeconds = Number(segment?.end_seconds ?? segment?.end ?? startSeconds);
      return {
        startSeconds: Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0,
        endSeconds: Number.isFinite(endSeconds) ? Math.max(0, endSeconds) : Math.max(0, startSeconds),
        text: String(segment?.text || "").trim(),
      };
    }).filter((segment) => segment.text)
    : [];
  return {
    text,
    rawText: String(body.raw_text || text),
    correctedText: String(body.corrected_text || text),
    provider: String(body.provider || body.asr_provider || ""),
    model: String(body.model || body.asr_model || ""),
    jobId: String(body.job_id || ""),
    segments,
  };
}

function sceneAnalysisPayload(body) {
  if (!body) return null;
  const scenes = Array.isArray(body.scenes)
    ? body.scenes.map((scene) => ({
      timestampSeconds: Number.isFinite(Number(scene?.timestamp_seconds))
        ? Math.max(0, Number(scene.timestamp_seconds))
        : 0,
      description: String(scene?.description || "").trim(),
      labels: Array.isArray(scene?.labels)
        ? scene.labels.filter((label) => typeof label === "string").map((label) => label.trim()).filter(Boolean)
        : [],
    })).filter((scene) => scene.description)
    : [];
  const summary = String(body.summary || scenes.map((scene) => scene.description).join(" ")).trim();
  if (!summary && !scenes.length) return null;
  return {
    summary,
    scenes,
    provider: String(body.provider || ""),
    model: String(body.model || ""),
  };
}

async function discoverDateDirectories(root, date = "") {
  const dailyRoot = path.join(root, "daily");
  const requested = dateParts(date);
  if (requested) {
    return [{ ...requested, directory: path.join(dailyRoot, requested.year, requested.dayDirectory) }];
  }

  let years;
  try {
    years = await readdir(dailyRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const directories = [];
  for (const yearEntry of years) {
    if (!yearEntry.isDirectory() || !/^\d{4}$/.test(yearEntry.name)) continue;
    const yearDirectory = path.join(dailyRoot, yearEntry.name);
    const days = await readdir(yearDirectory, { withFileTypes: true });
    for (const dayEntry of days) {
      if (!dayEntry.isDirectory()) continue;
      const resolvedDate = dateFromDirectories(yearEntry.name, dayEntry.name);
      if (!resolvedDate) continue;
      directories.push({
        date: resolvedDate,
        year: yearEntry.name,
        dayDirectory: dayEntry.name,
        directory: path.join(yearDirectory, dayEntry.name),
      });
    }
  }
  return directories.sort((left, right) => right.date.localeCompare(left.date));
}

export async function loadEntries(root, { date = "", assetOrigin = "" } = {}) {
  if (!root) throw new Error("root is required");
  if (date && !normalizeDate(date)) throw new Error("invalid_date");
  const directories = await discoverDateDirectories(root, date);
  const entries = [];

  for (const day of directories) {
    let files;
    try {
      files = await readdir(day.directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    for (const file of files) {
      if (!file.isFile() || file.name.startsWith(".") || !VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) continue;
      const sourceFile = path.join(day.directory, file.name);
      const sourceInfo = await stat(sourceFile);
      const sourcePath = path.posix.join("daily", day.year, day.dayDirectory, file.name);
      const metadataFile = path.join(root, "metadata", day.year, day.dayDirectory, `${file.name}.json`);
      const transcriptFile = path.join(root, "transcripts", day.year, day.dayDirectory, `${file.name}.json`);
      const sceneFile = path.join(root, "scenes", day.year, day.dayDirectory, `${file.name}.json`);
      const previewFile = path.join(root, "web", day.year, day.dayDirectory, `${file.name}.mp4`);
      const thumbnailFile = path.join(root, "thumbnails", day.year, day.dayDirectory, `${file.name}.jpg`);
      const [metadata, transcriptBody, sceneBody, hasPreview, hasThumbnail] = await Promise.all([
        readJsonOptional(metadataFile),
        readJsonOptional(transcriptFile),
        readJsonOptional(sceneFile),
        exists(previewFile),
        exists(thumbnailFile),
      ]);
      const transcript = transcriptPayload(transcriptBody);
      const sceneAnalysis = sceneAnalysisPayload(sceneBody);
      const capturedAt = String(metadata?.captured_at || metadata?.creation_time || sourceInfo.mtime.toISOString());
      const captureTimeSource = String(metadata?.capture_time_source || (
        metadata?.captured_at || metadata?.creation_time ? "metadata_legacy" : "filesystem_mtime_fallback"
      ));
      const status = String(metadata?.status || (transcript ? "completed" : "pending"));

      entries.push({
        id: String(metadata?.id || stableId(sourcePath)),
        date: day.date,
        filename: file.name,
        sourcePath,
        videoUrl: assetUrl(encodedPath("daily", day.year, day.dayDirectory, file.name), assetOrigin),
        previewUrl: hasPreview ? assetUrl(encodedPath("web", day.year, day.dayDirectory, `${file.name}.mp4`), assetOrigin) : null,
        thumbnailUrl: hasThumbnail ? assetUrl(encodedPath("thumbnails", day.year, day.dayDirectory, `${file.name}.jpg`), assetOrigin) : null,
        sizeBytes: Number(metadata?.size_bytes || sourceInfo.size),
        modifiedAt: sourceInfo.mtime.toISOString(),
        capturedAt,
        captureTimeSource,
        durationSeconds: Number(metadata?.duration_seconds || 0),
        width: Number(metadata?.width || 0) || null,
        height: Number(metadata?.height || 0) || null,
        privacyLevel: String(metadata?.privacy_level || "public"),
        status,
        error: status === "error" ? String(metadata?.error || metadata?.error_message || "processing_failed") : null,
        transcript,
        sceneAnalysis,
      });
    }
  }

  return sortEntriesChronologically(entries);
}

export async function loadDailyPlayback(root, entries, date, { assetOrigin = "" } = {}) {
  if (!root) throw new Error("root is required");
  const requested = dateParts(date);
  if (!requested) throw new Error("invalid_date");
  const selected = entries.filter((entry) => entry.date === requested.date);
  if (!selected.length) return null;

  let ordered = selected;
  let videoUrl = selected[0].previewUrl || selected[0].videoUrl;
  let manifest = null;
  let source = "single";

  if (selected.length > 1) {
    const directory = path.join(root, "web", requested.year, requested.dayDirectory);
    const videoFile = path.join(directory, "day.mp4");
    const manifestFile = path.join(directory, "day.json");
    const [hasVideo, loadedManifest] = await Promise.all([exists(videoFile), readJsonOptional(manifestFile)]);
    if (!hasVideo || !loadedManifest) return null;
    if (loadedManifest.date && loadedManifest.date !== requested.date) return null;
    if (Number(loadedManifest.clip_count || 0) !== selected.length) return null;

    const names = Array.isArray(loadedManifest.sources)
      ? loadedManifest.sources.map((item) => String(item?.filename || "")).filter(Boolean)
      : [];
    const byName = new Map(selected.map((entry) => [entry.filename, entry]));
    if (names.length !== selected.length || new Set(names).size !== names.length || names.some((name) => !byName.has(name))) return null;
    ordered = names.map((name) => byName.get(name));
    videoUrl = assetUrl(encodedPath("web", requested.year, requested.dayDirectory, "day.mp4"), assetOrigin);
    manifest = loadedManifest;
    source = "combined";
  }

  let offset = 0;
  const chapters = ordered.map((entry, index) => {
    const durationSeconds = Math.max(0, Number(entry.durationSeconds) || 0);
    const startSeconds = Number(offset.toFixed(3));
    offset += durationSeconds;
    return {
      index,
      id: entry.id,
      filename: entry.filename,
      capturedAt: entry.capturedAt,
      startSeconds,
      endSeconds: Number(offset.toFixed(3)),
      durationSeconds,
      thumbnailUrl: entry.thumbnailUrl,
    };
  });
  const manifestDuration = Number(manifest?.duration_seconds || 0);
  return {
    date: requested.date,
    source,
    videoUrl,
    posterUrl: ordered[0].thumbnailUrl || null,
    clipCount: ordered.length,
    durationSeconds: manifestDuration > 0 ? manifestDuration : Number(offset.toFixed(3)),
    chapters,
  };
}

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset < haystack.length) {
    const found = haystack.indexOf(needle, offset);
    if (found === -1) break;
    count += 1;
    offset = found + Math.max(needle.length, 1);
  }
  return count;
}

function snippetFor(text, terms) {
  const lower = text.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const focus = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, focus - 70);
  const end = Math.min(text.length, focus + 170);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

export function searchEntries(entries, query, { date = "", limit = 20 } = {}) {
  const normalizedQuery = String(query || "").trim().slice(0, 500);
  if (!normalizedQuery) return { query: "", date: normalizeDate(date), total: 0, items: [] };
  const terms = [...new Set(normalizedQuery.toLowerCase().split(/\s+/u).filter(Boolean))];
  const maxItems = Math.max(1, Math.min(Number(limit) || 20, 100));
  const requestedDate = normalizeDate(date);
  const matches = [];

  for (const entry of entries) {
    if (requestedDate && entry.date !== requestedDate) continue;
    const transcript = entry.transcript?.text || "";
    const sceneText = [
      entry.sceneAnalysis?.summary || "",
      ...(entry.sceneAnalysis?.scenes || []).flatMap((scene) => [scene.description, ...(scene.labels || [])]),
    ].filter(Boolean).join("\n");
    const contextText = [transcript, sceneText].filter(Boolean).join("\n");
    if (!contextText) continue;
    const searchable = `${entry.filename}\n${contextText}`.toLowerCase();
    if (!terms.every((term) => searchable.includes(term))) continue;
    const score = terms.reduce((sum, term) => sum + occurrences(searchable, term), 0);
    matches.push({
      id: entry.id,
      date: entry.date,
      filename: entry.filename,
      capturedAt: entry.capturedAt,
      durationSeconds: entry.durationSeconds,
      sizeBytes: entry.sizeBytes,
      width: entry.width,
      height: entry.height,
      status: entry.status,
      privacyLevel: entry.privacyLevel,
      videoUrl: entry.videoUrl,
      previewUrl: entry.previewUrl,
      thumbnailUrl: entry.thumbnailUrl,
      sceneSummary: entry.sceneAnalysis?.summary || "",
      score,
      snippet: snippetFor(contextText, terms),
    });
  }
  matches.sort((left, right) => right.score - left.score || String(right.capturedAt).localeCompare(String(left.capturedAt)));
  return { query: normalizedQuery, date: requestedDate, total: matches.length, items: matches.slice(0, maxItems) };
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  const remainder = value % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatTimelineOffset(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const remainder = value - minutes * 60;
  if (Math.abs(remainder - Math.round(remainder)) < 0.001) {
    return `${String(minutes).padStart(2, "0")}:${String(Math.round(remainder)).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function timestampMilliseconds(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  // Metadata without an explicit offset is treated as UTC so ordering is not
  // changed by the server/container's local timezone.
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sortEntriesChronologically(entries) {
  return [...entries].sort((left, right) => {
    const leftTimestamp = timestampMilliseconds(left.capturedAt);
    const rightTimestamp = timestampMilliseconds(right.capturedAt);
    if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) {
      return leftTimestamp - rightTimestamp;
    }
    if (leftTimestamp === null && rightTimestamp !== null) return 1;
    if (leftTimestamp !== null && rightTimestamp === null) return -1;
    return String(left.filename).localeCompare(String(right.filename));
  });
}

function validTimeZone(value) {
  const requested = String(value || "Asia/Tokyo").trim() || "Asia/Tokyo";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: requested }).format();
    return requested;
  } catch {
    return "UTC";
  }
}

function localDateTime(timestamp, timeZone) {
  if (timestamp === null) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function isoTimestamp(timestamp) {
  return timestamp === null ? "" : new Date(timestamp).toISOString();
}

function secondsValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function captureTimeSourceLabel(value) {
  const labels = {
    ffprobe_metadata: "ffprobe creation metadata",
    filesystem_mtime_fallback: "filesystem mtime fallback (approximate)",
    metadata: "metadata",
    metadata_legacy: "legacy metadata (precision unknown)",
  };
  const source = String(value || "unknown");
  return labels[source] || source;
}

function buildTimeline(entries, timeZone, origin) {
  const ordered = sortEntriesChronologically(entries);
  let previousEndTimestamp = null;
  return ordered.map((entry, index) => {
    const startTimestamp = timestampMilliseconds(entry.capturedAt);
    const durationSeconds = secondsValue(entry.durationSeconds);
    const endTimestamp = startTimestamp === null ? null : startTimestamp + durationSeconds * 1000;
    const gapAfterPreviousEndSeconds = startTimestamp !== null && previousEndTimestamp !== null
      ? Number(((startTimestamp - previousEndTimestamp) / 1000).toFixed(3))
      : null;
    previousEndTimestamp = endTimestamp;

    const scenes = [...(entry.sceneAnalysis?.scenes || [])]
      .sort((left, right) => secondsValue(left.timestampSeconds) - secondsValue(right.timestampSeconds))
      .map((scene) => {
        const offsetSeconds = secondsValue(scene.timestampSeconds);
        const absoluteTimestamp = startTimestamp === null ? null : startTimestamp + offsetSeconds * 1000;
        return {
          offsetSeconds,
          offset: formatTimelineOffset(offsetSeconds),
          absoluteAtUtc: isoTimestamp(absoluteTimestamp),
          absoluteAtLocal: localDateTime(absoluteTimestamp, timeZone),
          description: scene.description,
          labels: scene.labels || [],
        };
      });
    const transcriptSegments = [...(entry.transcript?.segments || [])]
      .sort((left, right) => secondsValue(left.startSeconds) - secondsValue(right.startSeconds))
      .map((segment) => {
        const startSeconds = secondsValue(segment.startSeconds);
        const endSeconds = Math.max(startSeconds, secondsValue(segment.endSeconds));
        const segmentStartTimestamp = startTimestamp === null ? null : startTimestamp + startSeconds * 1000;
        const segmentEndTimestamp = startTimestamp === null ? null : startTimestamp + endSeconds * 1000;
        return {
          startSeconds,
          endSeconds,
          start: formatTimelineOffset(startSeconds),
          end: formatTimelineOffset(endSeconds),
          absoluteStartAtUtc: isoTimestamp(segmentStartTimestamp),
          absoluteStartAtLocal: localDateTime(segmentStartTimestamp, timeZone),
          absoluteEndAtUtc: isoTimestamp(segmentEndTimestamp),
          absoluteEndAtLocal: localDateTime(segmentEndTimestamp, timeZone),
          text: segment.text,
        };
      });
    return {
      sequence: index + 1,
      id: entry.id,
      filename: entry.filename,
      capturedAt: entry.capturedAt,
      startAtUtc: isoTimestamp(startTimestamp),
      startAtLocal: localDateTime(startTimestamp, timeZone),
      endAtUtc: isoTimestamp(endTimestamp),
      endAtLocal: localDateTime(endTimestamp, timeZone),
      durationSeconds,
      captureTimeSource: entry.captureTimeSource,
      gapAfterPreviousEndSeconds,
      sourceUrl: origin ? new URL(entry.videoUrl, origin).href : entry.videoUrl,
      status: entry.status,
      visualSummary: entry.sceneAnalysis?.summary || "",
      scenes,
      transcript: entry.transcript?.text || "",
      transcriptSegments,
    };
  });
}

function formatElapsed(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function gapLine(seconds) {
  if (seconds === null) return "- Gap after previous clip: unavailable (capture time metadata is missing)";
  if (seconds >= 0) return `- Gap after previous clip: ${formatElapsed(seconds)}`;
  return `- Overlap with previous clip: ${formatElapsed(Math.abs(seconds))}`;
}

export function buildMemoryContext(entries, date, { origin = "", timeZone = process.env.AFTERIMAGE_TIMEZONE || "Asia/Tokyo" } = {}) {
  const requestedDate = normalizeDate(date);
  if (!requestedDate) throw new Error("invalid_date");
  const selected = sortEntriesChronologically(entries.filter((entry) => entry.date === requestedDate));
  const transcribed = selected.filter((entry) => entry.transcript?.text);
  const analyzed = selected.filter((entry) => entry.sceneAnalysis?.summary || entry.sceneAnalysis?.scenes?.length);
  const resolvedTimeZone = validTimeZone(timeZone);
  const timeline = buildTimeline(selected, resolvedTimeZone, origin);
  const lines = [
    `# ${requestedDate} Lifelog`,
    "",
    `- Clips: ${selected.length}`,
    `- Transcribed: ${transcribed.length}`,
    `- Visually analyzed: ${analyzed.length}`,
    `- Local display timezone: ${resolvedTimeZone}`,
    "",
    "## Chronological timeline",
    "",
    "Read this section as an evidence timeline. Clips are ordered by capture start (the actual instant), not by filename or ingest time.",
    "- The date in this heading is the source directory date. Use the explicit timestamps below as the authority if a clip crosses a local midnight.",
    "- Capture end is estimated as capture start plus clip duration; it is not a separately observed event.",
    "- A gap means no video was captured. Do not invent activities inside a gap.",
    "- Visual observations are sampled frames. Their `+MM:SS` offsets are relative to the clip start and are listed in video order.",
    "- Keep observed facts separate from inferences; a clip does not prove what happened between its sampled frames.",
    "",
  ];
  for (const item of timeline) {
    const startLabel = item.startAtLocal || item.capturedAt || "unknown start";
    const endLabel = item.endAtLocal || "unknown end";
    lines.push(`### ${String(item.sequence).padStart(2, "0")} · ${startLabel} → ${endLabel} — ${item.filename}`);
    lines.push("");
    lines.push(`- Capture start: ${item.startAtLocal || "unavailable"}${item.startAtUtc ? ` (UTC ${item.startAtUtc})` : ""}`);
    lines.push(`- Capture end (estimated): ${item.endAtLocal || "unavailable"}${item.endAtUtc ? ` (UTC ${item.endAtUtc})` : ""}`);
    lines.push(`- Capture time source: ${captureTimeSourceLabel(item.captureTimeSource)}`);
    lines.push(`- Duration: ${formatDuration(item.durationSeconds)}`);
    lines.push(item.sequence === 1 ? "- Gap after previous clip: n/a (first clip in timeline)" : gapLine(item.gapAfterPreviousEndSeconds));
    lines.push(`- Source: ${item.sourceUrl}`);
    lines.push(`- Status: ${item.status}`);
    if (item.visualSummary) lines.push(`- Visual context: ${item.visualSummary}`);
    if (item.scenes.length) {
      lines.push("- Visual observations (ordered by clip offset):");
      for (const scene of item.scenes) {
        const absolute = scene.absoluteAtLocal
          ? ` (absolute local ${scene.absoluteAtLocal}${scene.absoluteAtUtc ? `; UTC ${scene.absoluteAtUtc}` : ""})`
          : "";
        const labels = scene.labels.length ? ` [labels: ${scene.labels.join(", ")}]` : "";
        lines.push(`  - +${scene.offset}${absolute} — ${scene.description}${labels}`);
      }
    }
    if (item.transcriptSegments.length) {
      lines.push("- Transcript segments (ordered by clip offset):");
      for (const segment of item.transcriptSegments) {
        const absolute = segment.absoluteStartAtLocal
          ? ` (absolute local ${segment.absoluteStartAtLocal}–${segment.absoluteEndAtLocal}; UTC ${segment.absoluteStartAtUtc}–${segment.absoluteEndAtUtc})`
          : "";
        lines.push(`  - +${segment.start}–+${segment.end}${absolute} — ${segment.text}`);
      }
    } else {
      lines.push("- Transcript:", `  ${item.transcript || "_Transcription pending_"}`);
    }
    lines.push("");
  }
  return {
    date: requestedDate,
    timezone: resolvedTimeZone,
    clipCount: selected.length,
    transcribedCount: transcribed.length,
    analyzedCount: analyzed.length,
    timeline,
    markdown: `${lines.join("\n").trim()}\n`,
    sources: timeline.map((item) => ({ id: item.id, filename: item.filename, videoUrl: item.sourceUrl })),
  };
}

export function isVideoFilename(filename) {
  return VIDEO_EXTENSIONS.has(path.extname(String(filename)).toLowerCase());
}
