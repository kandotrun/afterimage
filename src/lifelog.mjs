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
  return {
    text,
    rawText: String(body.raw_text || text),
    correctedText: String(body.corrected_text || text),
    provider: String(body.provider || body.asr_provider || ""),
    model: String(body.model || body.asr_model || ""),
    jobId: String(body.job_id || ""),
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
      const previewFile = path.join(root, "web", day.year, day.dayDirectory, `${file.name}.mp4`);
      const thumbnailFile = path.join(root, "thumbnails", day.year, day.dayDirectory, `${file.name}.jpg`);
      const [metadata, transcriptBody, hasPreview, hasThumbnail] = await Promise.all([
        readJsonOptional(metadataFile),
        readJsonOptional(transcriptFile),
        exists(previewFile),
        exists(thumbnailFile),
      ]);
      const transcript = transcriptPayload(transcriptBody);
      const capturedAt = String(metadata?.captured_at || metadata?.creation_time || sourceInfo.mtime.toISOString());
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
        durationSeconds: Number(metadata?.duration_seconds || 0),
        width: Number(metadata?.width || 0) || null,
        height: Number(metadata?.height || 0) || null,
        privacyLevel: String(metadata?.privacy_level || "public"),
        status,
        error: status === "error" ? String(metadata?.error || metadata?.error_message || "transcription_failed") : null,
        transcript,
      });
    }
  }

  return entries.sort((left, right) => {
    const time = String(left.capturedAt).localeCompare(String(right.capturedAt));
    return time || left.filename.localeCompare(right.filename);
  });
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
    if (!transcript) continue;
    const searchable = `${entry.filename}\n${transcript}`.toLowerCase();
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
      score,
      snippet: snippetFor(transcript, terms),
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

export function buildMemoryContext(entries, date, { origin = "" } = {}) {
  const requestedDate = normalizeDate(date);
  if (!requestedDate) throw new Error("invalid_date");
  const selected = entries.filter((entry) => entry.date === requestedDate);
  const transcribed = selected.filter((entry) => entry.transcript?.text);
  const lines = [
    `# ${requestedDate} Lifelog`,
    "",
    `- Clips: ${selected.length}`,
    `- Transcribed: ${transcribed.length}`,
    "",
  ];
  for (const entry of selected) {
    const sourceUrl = origin ? new URL(entry.videoUrl, origin).href : entry.videoUrl;
    lines.push(`## ${entry.capturedAt || entry.filename} — ${entry.filename}`);
    lines.push("");
    lines.push(`- Duration: ${formatDuration(entry.durationSeconds)}`);
    lines.push(`- Source: ${sourceUrl}`);
    lines.push(`- Status: ${entry.status}`);
    lines.push("");
    lines.push(entry.transcript?.text || "_Transcription pending_", "");
  }
  return {
    date: requestedDate,
    clipCount: selected.length,
    transcribedCount: transcribed.length,
    markdown: `${lines.join("\n").trim()}\n`,
    sources: selected.map((entry) => ({ id: entry.id, filename: entry.filename, videoUrl: origin ? new URL(entry.videoUrl, origin).href : entry.videoUrl })),
  };
}

export function isVideoFilename(filename) {
  return VIDEO_EXTENSIONS.has(path.extname(String(filename)).toLowerCase());
}
