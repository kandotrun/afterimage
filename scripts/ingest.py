#!/usr/bin/env python3
"""afterimage ingest pipeline: scan videos, extract audio, transcribe, generate previews."""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    from scripts import vlm as vlm_support
except ImportError:  # Running as `python scripts/ingest.py`.
    import vlm as vlm_support  # type: ignore[no-redef]

VIDEO_EXTENSIONS = {".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"}


def log(event: str, **fields: Any) -> None:
    payload = {"event": event, "at": dt.datetime.now(dt.UTC).isoformat(), **fields}
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def discover_videos(root: Path, date: str = "") -> list[Path]:
    daily = root / "daily"
    if date:
        parsed = dt.date.fromisoformat(date)
        directories = [daily / f"{parsed.year:04d}" / f"{parsed.month:02d}{parsed.day:02d}"]
    else:
        directories = sorted(daily.glob("[0-9][0-9][0-9][0-9]/[0-9][0-9][0-9][0-9]")) if daily.exists() else []
    videos: list[Path] = []
    for directory in directories:
        if not directory.is_dir():
            continue
        for item in sorted(directory.iterdir(), key=lambda value: value.name.casefold()):
            if item.is_file() and not item.name.startswith(".") and item.suffix.lower() in VIDEO_EXTENSIONS:
                videos.append(item)
    return videos


def video_parts(root: Path, video: Path) -> tuple[str, str, str]:
    relative = video.relative_to(root)
    parts = relative.parts
    if len(parts) != 4 or parts[0] != "daily" or not (len(parts[1]) == 4 and len(parts[2]) == 4):
        raise ValueError(f"video is outside daily/YYYY/MMDD: {relative}")
    return parts[1], parts[2], parts[3]


def artifact_paths(root: Path, video: Path) -> dict[str, Path]:
    year, day, filename = video_parts(root, video)
    return {
        "audio": root / "audio" / year / day / f"{filename}.mp3",
        "preview": root / "web" / year / day / f"{filename}.mp4",
        "thumbnail": root / "thumbnails" / year / day / f"{filename}.jpg",
        "transcript_json": root / "transcripts" / year / day / f"{filename}.json",
        "transcript_text": root / "transcripts" / year / day / f"{filename}.txt",
        "metadata": root / "metadata" / year / day / f"{filename}.json",
        "scenes": root / "scenes" / year / day / f"{filename}.json",
        "memory": root / "memory" / year / f"{day}.md",
    }


def daily_video_paths(root: Path, date: str) -> dict[str, Path]:
    parsed = dt.date.fromisoformat(date)
    year = f"{parsed.year:04d}"
    day = f"{parsed.month:02d}{parsed.day:02d}"
    directory = root / "web" / year / day
    return {
        "video": directory / "day.mp4",
        "manifest": directory / "day.json",
    }


def source_path(root: Path, video: Path) -> str:
    return video.relative_to(root).as_posix()


def entry_id(root: Path, video: Path) -> str:
    return hashlib.sha256(source_path(root, video).encode()).hexdigest()[:16]


def fingerprint(video: Path) -> str:
    info = video.stat()
    return f"{info.st_size}:{info.st_mtime_ns}"


def select_stable_videos(
    root: Path,
    videos: list[Path],
    state: dict[str, Any],
    *,
    now: float,
    stable_seconds: float,
) -> tuple[list[Path], dict[str, Any]]:
    """Require the same size+mtime fingerprint across scans before processing."""
    stable: list[Path] = []
    next_state: dict[str, Any] = {}
    for video in videos:
        key = source_path(root, video)
        current = fingerprint(video)
        candidate = state.get(key)
        previous: dict[str, Any] = candidate if isinstance(candidate, dict) else {}
        unchanged = previous.get("fingerprint") == current
        first_seen = float(previous.get("first_seen") or now) if unchanged else now
        next_state[key] = {"fingerprint": current, "first_seen": first_seen, "last_seen": now}
        if stable_seconds <= 0 or (unchanged and now - first_seen >= stable_seconds):
            stable.append(video)
    return stable, next_state


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def atomic_write_bytes(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_bytes(body)
    os.replace(temporary, path)


def atomic_write_text(path: Path, body: str) -> None:
    atomic_write_bytes(path, body.encode("utf-8"))


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def run(command: list[str], timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, text=True, capture_output=True, timeout=timeout)


def probe_video(video: Path) -> dict[str, Any]:
    completed = run([
        "ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(video)
    ], timeout=180)
    body = json.loads(completed.stdout)
    format_info = body.get("format") or {}
    streams = body.get("streams") or []
    video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), {})
    audio_stream = next((stream for stream in streams if stream.get("codec_type") == "audio"), {})
    tagged_creation_time = (format_info.get("tags") or {}).get("creation_time")
    tagged_creation_time = tagged_creation_time or (video_stream.get("tags") or {}).get("creation_time")
    creation_time = tagged_creation_time or dt.datetime.fromtimestamp(video.stat().st_mtime, tz=dt.UTC).isoformat()
    return {
        "duration_seconds": float(format_info.get("duration") or 0),
        "creation_time": creation_time,
        "capture_time_source": "ffprobe_metadata" if tagged_creation_time else "filesystem_mtime_fallback",
        "width": int(video_stream.get("width") or 0),
        "height": int(video_stream.get("height") or 0),
        "video_codec": str(video_stream.get("codec_name") or ""),
        "audio_codec": str(audio_stream.get("codec_name") or ""),
        "audio_sample_rate": int(audio_stream.get("sample_rate") or 0),
        "audio_channels": int(audio_stream.get("channels") or 0),
    }


def copy_artifact(local_file: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    shutil.copyfile(local_file, temporary)
    os.replace(temporary, destination)


def extract_audio(video: Path, destination: Path, workdir: Path) -> None:
    local = workdir / "audio.mp3"
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
        "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", str(local),
    ], timeout=1800)
    if local.stat().st_size <= 0:
        raise RuntimeError("audio extraction produced an empty file")
    copy_artifact(local, destination)


def extract_thumbnail(video: Path, destination: Path, workdir: Path, duration: float) -> None:
    local = workdir / "thumbnail.jpg"
    seek = max(0.0, min(duration / 3.0, max(duration - 0.2, 0.0)))
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{seek:.3f}", "-i", str(video),
        "-frames:v", "1", "-vf", "scale='min(960,iw)':-2", "-q:v", "3", str(local),
    ], timeout=900)
    if local.stat().st_size <= 0:
        raise RuntimeError("thumbnail extraction produced an empty file")
    copy_artifact(local, destination)


def generate_preview(video: Path, destination: Path, workdir: Path) -> None:
    local = workdir / "preview.mp4"
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
        "-map", "0:v:0", "-map", "0:a:0?", "-vf", "fps=20,scale='min(960,iw)':-2",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "29", "-pix_fmt", "yuv420p", "-threads", "4",
        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(local),
    ], timeout=7200)
    if local.stat().st_size <= 0:
        raise RuntimeError("preview generation produced an empty file")
    copy_artifact(local, destination)


def build_daily_video(root: Path, date: str, cache: Path, force: bool = False) -> dict[str, Any]:
    """Join a day's browser previews into one seekable MP4 without re-encoding."""
    videos = sort_videos_by_capture(root, discover_videos(root, date))
    paths = daily_video_paths(root, date)
    if len(videos) < 2:
        return {"ready": False, "skipped": True, "reason": "single_or_empty_day"}

    previews: list[tuple[Path, Path]] = []
    for video in videos:
        preview = artifact_paths(root, video)["preview"]
        if not preview.is_file() or preview.stat().st_size <= 0:
            log("daily_video_deferred", date=date, reason="preview_missing", file=source_path(root, video))
            return {"ready": False, "skipped": True, "reason": "preview_missing"}
        previews.append((video, preview))

    sources = []
    for video, preview in previews:
        info = preview.stat()
        sources.append({
            "filename": video.name,
            "preview_path": preview.relative_to(root).as_posix(),
            "preview_size": info.st_size,
            "preview_mtime_ns": str(info.st_mtime_ns),
        })

    previous = read_json(paths["manifest"])
    output_ready = paths["video"].is_file() and paths["video"].stat().st_size > 0
    if not force and output_ready and previous.get("sources") == sources:
        log("daily_video_skipped", date=date, reason="sources_unchanged")
        return {
            "ready": True,
            "skipped": True,
            "path": paths["video"],
            "duration_seconds": float(previous.get("duration_seconds") or 0),
        }

    workdir = Path(tempfile.mkdtemp(prefix=f"daily-{date}-", dir=cache / "work"))
    try:
        concat_lines = []
        for index, (_, preview) in enumerate(previews):
            link = workdir / f"{index:04d}.mp4"
            link.symlink_to(preview)
            concat_lines.append(f"file '{link.as_posix()}'")
        concat_file = workdir / "concat.txt"
        concat_file.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")
        local = workdir / "day.mp4"
        log("daily_video_started", date=date, clips=len(previews))
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "concat", "-safe", "0", "-i", str(concat_file),
            "-map", "0:v:0", "-map", "0:a:0?", "-dn", "-c", "copy",
            "-movflags", "+faststart", str(local),
        ], timeout=7200)
        if not local.is_file() or local.stat().st_size <= 0:
            raise RuntimeError("daily video generation produced an empty file")
        probe = probe_video(local)
        duration = float(probe.get("duration_seconds") or 0)
        if duration <= 0:
            raise RuntimeError("daily video has no duration")
        copy_artifact(local, paths["video"])
        manifest = {
            "version": 1,
            "date": date,
            "clip_count": len(previews),
            "duration_seconds": duration,
            "video_path": paths["video"].relative_to(root).as_posix(),
            "sources": sources,
            "created_at": dt.datetime.now(dt.UTC).isoformat(),
        }
        atomic_write_json(paths["manifest"], manifest)
        log("daily_video_completed", date=date, clips=len(previews), bytes=paths["video"].stat().st_size)
        return {"ready": True, "skipped": False, "path": paths["video"], "duration_seconds": duration}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# ── STT providers ────────────────────────────────────────────────────────────


def transcribe_whisper(audio: Path) -> tuple[str, dict[str, Any]]:
    """Local Whisper transcription via openai-whisper package."""
    import whisper  # pyright: ignore[reportMissingImports]

    model_name = os.environ.get("WHISPER_MODEL", "base")
    model = whisper.load_model(model_name)
    result = model.transcribe(str(audio), fp16=False)
    text = str(result.get("text") or "").strip()
    if not text:
        raise RuntimeError("whisper transcription returned empty text")
    return text, {
        "provider": "whisper",
        "model": model_name,
        "language": str(result.get("language") or ""),
        "segments": normalize_transcript_segments(result.get("segments")),
    }


def transcribe_openai(audio: Path) -> tuple[str, dict[str, Any]]:
    """OpenAI Whisper API transcription."""
    from openai import OpenAI  # pyright: ignore[reportMissingImports]

    client = OpenAI()
    with open(audio, "rb") as f:
        result = client.audio.transcriptions.create(
            model="whisper-1",
            file=f,
            response_format="verbose_json",
        )
    text = str(result.text or "").strip()
    if not text:
        raise RuntimeError("openai transcription returned empty text")
    return text, {
        "provider": "openai",
        "model": "whisper-1",
        "language": str(getattr(result, "language", "") or ""),
        "segments": normalize_transcript_segments(getattr(result, "segments", None)),
    }


def transcribe_none(audio: Path) -> tuple[str, dict[str, Any]]:
    """Skip transcription entirely."""
    return "", {"provider": "none", "model": ""}


STT_PROVIDERS = {
    "whisper": transcribe_whisper,
    "openai": transcribe_openai,
    "none": transcribe_none,
}


def transcribe_audio(audio: Path) -> tuple[str, dict[str, Any]]:
    provider_name = os.environ.get("STT_PROVIDER", "whisper").lower()
    provider = STT_PROVIDERS.get(provider_name)
    if provider is None:
        raise ValueError(f"Unknown STT_PROVIDER: {provider_name}. Choose from: {', '.join(STT_PROVIDERS)}")
    return provider(audio)


def finite_seconds(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value if value is not None else default)
    except (TypeError, ValueError):
        return default
    return max(0.0, number) if math.isfinite(number) else default


def normalize_transcript_segments(raw_segments: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_segments, list):
        return []
    normalized: list[dict[str, Any]] = []
    for segment in raw_segments:
        if isinstance(segment, dict):
            start = segment.get("start_seconds", segment.get("start", 0))
            end = segment.get("end_seconds", segment.get("end", start))
            text = segment.get("text", "")
        else:
            start = getattr(segment, "start_seconds", getattr(segment, "start", 0))
            end = getattr(segment, "end_seconds", getattr(segment, "end", start))
            text = getattr(segment, "text", "")
        try:
            start_seconds = finite_seconds(start)
            end_seconds = max(start_seconds, finite_seconds(end, start_seconds))
        except (TypeError, ValueError):
            continue
        normalized_text = str(text or "").strip()
        if not normalized_text:
            continue
        normalized.append({
            "start_seconds": start_seconds,
            "end_seconds": end_seconds,
            "text": normalized_text,
        })
    return sorted(normalized, key=lambda segment: segment["start_seconds"])


def transcript_record(root: Path, video: Path, text: str, job: dict[str, Any]) -> dict[str, Any]:
    record: dict[str, Any] = {
        "id": entry_id(root, video),
        "source_path": source_path(root, video),
        "provider": str(job.get("provider") or ""),
        "model": str(job.get("model") or ""),
        "privacy_level": "public",
        "job_id": str(job.get("id") or ""),
        "raw_text": text,
        "corrected_text": text,
        "text": text,
        "created_at": dt.datetime.now(dt.UTC).isoformat(),
    }
    segments = normalize_transcript_segments(job.get("segments"))
    if segments:
        record["segments"] = segments
    return record


def relative_or_empty(root: Path, value: Path) -> str:
    try:
        return value.relative_to(root).as_posix()
    except ValueError:
        return ""


def base_metadata(root: Path, video: Path, probe: dict[str, Any], artifacts: dict[str, Path]) -> dict[str, Any]:
    info = video.stat()
    return {
        "id": entry_id(root, video),
        "source_path": source_path(root, video),
        "filename": video.name,
        "fingerprint": fingerprint(video),
        "privacy_level": "public",
        "size_bytes": info.st_size,
        "modified_at": dt.datetime.fromtimestamp(info.st_mtime, tz=dt.UTC).isoformat(),
        "captured_at": probe["creation_time"],
        "capture_time_source": probe.get("capture_time_source", "unknown"),
        "duration_seconds": probe["duration_seconds"],
        "width": probe["width"],
        "height": probe["height"],
        "video_codec": probe["video_codec"],
        "audio_codec": probe["audio_codec"],
        "audio_sample_rate": probe["audio_sample_rate"],
        "audio_channels": probe["audio_channels"],
        "artifacts": {key: relative_or_empty(root, value) for key, value in artifacts.items() if key != "memory"},
        "asr_provider": os.environ.get("STT_PROVIDER", "whisper"),
        "asr_model": os.environ.get("WHISPER_MODEL", "base"),
    }


def parse_capture_time(value: Any) -> dt.datetime | None:
    """Parse capture metadata into UTC without depending on the host timezone."""
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed.astimezone(dt.UTC)


def memory_timezone() -> tuple[str, dt.tzinfo]:
    requested = os.environ.get("AFTERIMAGE_TIMEZONE", "Asia/Tokyo").strip() or "Asia/Tokyo"
    try:
        return requested, ZoneInfo(requested)
    except ZoneInfoNotFoundError:
        return "UTC", dt.UTC


def format_memory_datetime(value: dt.datetime | None, timezone: dt.tzinfo) -> str:
    return value.astimezone(timezone).strftime("%Y-%m-%d %H:%M:%S") if value else ""


def format_memory_iso(value: dt.datetime | None) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z") if value else ""


def format_memory_offset(seconds: float) -> str:
    value = finite_seconds(seconds)
    minutes = int(value // 60)
    remainder = value - minutes * 60
    if abs(remainder - round(remainder)) < 0.001:
        return f"{minutes:02d}:{round(remainder):02d}"
    return f"{minutes:02d}:{remainder:06.3f}"


def format_memory_elapsed(seconds: float) -> str:
    value = round(finite_seconds(seconds))
    hours, remainder = divmod(value, 3600)
    minutes, seconds_remainder = divmod(remainder, 60)
    prefix = f"{hours:02d}:" if hours else ""
    return f"{prefix}{minutes:02d}:{seconds_remainder:02d}"


def capture_time_source_label(value: Any) -> str:
    source = str(value or "unknown")
    labels = {
        "ffprobe_metadata": "ffprobe creation metadata",
        "filesystem_mtime_fallback": "filesystem mtime fallback (approximate)",
        "metadata": "metadata",
        "metadata_legacy": "legacy metadata (precision unknown)",
    }
    return labels.get(source, source)


def capture_sort_key(captured_at: Any, filename: Any) -> tuple[int, dt.datetime, str]:
    captured = parse_capture_time(captured_at)
    return (0 if captured else 1, captured or dt.datetime.max.replace(tzinfo=dt.UTC), str(filename or "").casefold())


def sort_videos_by_capture(root: Path, videos: list[Path]) -> list[Path]:
    return sorted(
        videos,
        key=lambda video: capture_sort_key(
            read_json(artifact_paths(root, video)["metadata"]).get("captured_at"),
            video.name,
        ),
    )


def sorted_memory_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(entries, key=lambda entry: capture_sort_key(entry.get("captured_at"), entry.get("filename")))


def render_daily_memory(date: str, entries: list[dict[str, Any]], public_origin: str) -> str:
    timezone_name, timezone = memory_timezone()
    ordered_entries = sorted_memory_entries(entries)
    lines = [
        f"# {date} Lifelog",
        "",
        f"- Clips: {len(ordered_entries)}",
        f"- Transcribed: {sum(1 for entry in ordered_entries if entry.get('text'))}",
        f"- Visually analyzed: {sum(1 for entry in ordered_entries if entry.get('scene_summary') or entry.get('scenes'))}",
        f"- Local display timezone: {timezone_name}",
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
    ]
    previous_end: dt.datetime | None = None
    for index, entry in enumerate(ordered_entries, start=1):
        captured = parse_capture_time(entry.get("captured_at"))
        duration_seconds = finite_seconds(entry.get("duration_seconds"))
        end = captured + dt.timedelta(seconds=duration_seconds) if captured else None
        source = str(entry.get("source_path") or "")
        url = f"{public_origin.rstrip('/')}" + "/" + "/".join(quote(part) for part in source.split("/"))
        start_local = format_memory_datetime(captured, timezone)
        end_local = format_memory_datetime(end, timezone)
        start_label = start_local or str(entry.get("captured_at") or entry.get("filename") or "unknown start")
        end_label = end_local or "unknown end"
        lines.extend([
            f"### {index:02d} · {start_label} → {end_label} — {entry.get('filename')}",
            "",
            f"- Capture start: {start_local or 'unavailable'}{f' (UTC {format_memory_iso(captured)})' if captured else ''}",
            f"- Capture end (estimated): {end_local or 'unavailable'}{f' (UTC {format_memory_iso(end)})' if end else ''}",
            f"- Capture time source: {capture_time_source_label(entry.get('capture_time_source'))}",
            f"- Duration: {format_memory_offset(duration_seconds)}",
        ])
        if index == 1:
            lines.append("- Gap after previous clip: n/a (first clip in timeline)")
        elif captured is None or previous_end is None:
            lines.append("- Gap after previous clip: unavailable (capture time metadata is missing)")
        else:
            gap_seconds = (captured - previous_end).total_seconds()
            if gap_seconds >= 0:
                lines.append(f"- Gap after previous clip: {format_memory_elapsed(gap_seconds)}")
            else:
                lines.append(f"- Overlap with previous clip: {format_memory_elapsed(abs(gap_seconds))}")
        lines.extend([
            f"- Source: {url}",
            f"- Status: {entry.get('status') or 'unknown'}",
        ])
        if entry.get("scene_summary"):
            lines.append(f"- Visual context: {entry['scene_summary']}")
        scenes = sorted(entry.get("scenes") or [], key=lambda scene: finite_seconds(scene.get("timestamp_seconds")))
        if scenes:
            lines.append("- Visual observations (ordered by clip offset):")
            for scene in scenes:
                offset = finite_seconds(scene.get("timestamp_seconds"))
                absolute = captured + dt.timedelta(seconds=offset) if captured else None
                absolute_label = format_memory_datetime(absolute, timezone)
                absolute_suffix = f" (absolute local {absolute_label}; UTC {format_memory_iso(absolute)})" if absolute else ""
                labels = [str(label).strip() for label in scene.get("labels") or [] if str(label).strip()]
                label_suffix = f" [labels: {', '.join(labels)}]" if labels else ""
                lines.append(f"  - +{format_memory_offset(offset)}{absolute_suffix} — {str(scene.get('description') or '').strip()}{label_suffix}")
        segments = sorted(entry.get("transcript_segments") or [], key=lambda segment: finite_seconds(segment.get("start_seconds")))
        if segments:
            lines.append("- Transcript segments (ordered by clip offset):")
            for segment in segments:
                start = finite_seconds(segment.get("start_seconds"))
                end_offset = max(start, finite_seconds(segment.get("end_seconds"), start))
                lines.append(f"  - +{format_memory_offset(start)}–+{format_memory_offset(end_offset)} — {str(segment.get('text') or '').strip()}")
        else:
            lines.extend(["- Transcript:", f"  {entry.get('text') or '_Transcription pending_'!s}"])
        lines.append("")
        previous_end = end
    return "\n".join(lines).rstrip() + "\n"


def rebuild_daily_memory(root: Path, date: str, public_origin: str) -> Path:
    parsed = dt.date.fromisoformat(date)
    year = f"{parsed.year:04d}"
    day = f"{parsed.month:02d}{parsed.day:02d}"
    entries: list[dict[str, Any]] = []
    metadata_dir = root / "metadata" / year / day
    transcript_dir = root / "transcripts" / year / day
    scenes_dir = root / "scenes" / year / day
    if metadata_dir.exists():
        for metadata_file in sorted(metadata_dir.glob("*.json")):
            metadata = read_json(metadata_file)
            transcript = read_json(transcript_dir / metadata_file.name)
            scenes = read_json(scenes_dir / metadata_file.name)
            entries.append({
                **metadata,
                "text": transcript.get("text") or transcript.get("corrected_text") or transcript.get("raw_text") or "",
                "transcript_segments": transcript.get("segments") or [],
                "scene_summary": scenes.get("summary") or metadata.get("scene_summary") or "",
                "scenes": scenes.get("scenes") or [],
            })
    destination = root / "memory" / year / f"{day}.md"
    atomic_write_text(destination, render_daily_memory(date, entries, public_origin))
    return destination


def day_from_video(root: Path, video: Path) -> str:
    year, day, _ = video_parts(root, video)
    return f"{year}-{day[:2]}-{day[2:]}"


def process_video(root: Path, video: Path, cache: Path, generate_web_preview: bool, force: bool = False) -> dict[str, Any]:
    artifacts = artifact_paths(root, video)
    current_fingerprint = fingerprint(video)
    old_metadata = read_json(artifacts["metadata"])
    old_transcript = read_json(artifacts["transcript_json"])
    old_scenes = read_json(artifacts["scenes"])
    stt_enabled = os.environ.get("STT_PROVIDER", "whisper").lower() != "none"
    vlm_provider = vlm_support.create_provider_from_env()
    vlm_enabled = vlm_provider is not None
    vlm_interval = float(os.environ.get("VLM_FRAME_INTERVAL", "60"))
    vlm_max_frames = int(os.environ.get("VLM_MAX_FRAMES", "12"))
    vlm_base_url = os.environ.get("VLM_BASE_URL", "").strip()
    scene_config_signature = "" if vlm_provider is None else "|".join([
        vlm_provider.name, vlm_provider.model, vlm_base_url,
        str(vlm_interval), str(vlm_max_frames),
    ])
    scene_config_matches = vlm_provider is None or (
        old_scenes.get("config_signature") == scene_config_signature
    )
    already_processed = (
        not force
        and old_metadata.get("fingerprint") == current_fingerprint
        and old_metadata.get("status") == "completed"
        and artifacts["transcript_json"].is_file()
        and (not stt_enabled or bool(old_transcript.get("text") or old_transcript.get("raw_text")))
    )

    required_artifacts = ["thumbnail", "transcript_json", "transcript_text"]
    if stt_enabled:
        required_artifacts.append("audio")
    if vlm_enabled:
        required_artifacts.append("scenes")
    if generate_web_preview:
        required_artifacts.append("preview")
    derivatives_ready = scene_config_matches and all(
        artifacts[key].is_file() and artifacts[key].stat().st_size > 0
        for key in required_artifacts
    )
    if already_processed and derivatives_ready:
        log("video_skipped", file=source_path(root, video), reason="fingerprint_and_artifacts_unchanged")
        return {**old_metadata, "text": str(old_transcript.get("text") or ""), "skipped": True}

    probe = probe_video(video)
    metadata = {
        **base_metadata(root, video, probe, artifacts),
        "status": "completed" if already_processed else "processing",
        "started_at": dt.datetime.now(dt.UTC).isoformat(),
    }
    atomic_write_json(artifacts["metadata"], metadata)
    workdir = Path(tempfile.mkdtemp(prefix=f"{entry_id(root, video)}-", dir=cache / "work"))
    try:
        if stt_enabled and (force or not artifacts["audio"].exists() or artifacts["audio"].stat().st_size <= 0):
            log("audio_extract_started", file=source_path(root, video))
            extract_audio(video, artifacts["audio"], workdir)
            log("audio_extract_completed", file=source_path(root, video), bytes=artifacts["audio"].stat().st_size)

        if already_processed:
            transcript = old_transcript
            if not artifacts["transcript_text"].exists() or artifacts["transcript_text"].stat().st_size <= 0:
                atomic_write_text(artifacts["transcript_text"], str(transcript.get("text") or "") + "\n")
            log("transcription_skipped", file=source_path(root, video), reason="fingerprint_unchanged")
        else:
            log("transcription_started", file=source_path(root, video))
            text, job = transcribe_audio(artifacts["audio"])
            transcript = transcript_record(root, video, text, job)
            atomic_write_json(artifacts["transcript_json"], transcript)
            atomic_write_text(artifacts["transcript_text"], transcript["text"] + "\n")
            log("transcription_completed", file=source_path(root, video), chars=len(transcript["text"]))

        derivative_errors: dict[str, str] = {}
        if force or not artifacts["thumbnail"].exists() or artifacts["thumbnail"].stat().st_size <= 0:
            try:
                extract_thumbnail(video, artifacts["thumbnail"], workdir, float(probe["duration_seconds"]))
            except Exception as error:  # noqa: BLE001 - isolate one artifact/video failure from the batch.
                derivative_errors["thumbnail"] = str(error)[:500]
                log("thumbnail_failed", file=source_path(root, video), error=type(error).__name__)

        if generate_web_preview and (force or not artifacts["preview"].exists() or artifacts["preview"].stat().st_size <= 0):
            try:
                log("preview_started", file=source_path(root, video))
                generate_preview(video, artifacts["preview"], workdir)
                log("preview_completed", file=source_path(root, video), bytes=artifacts["preview"].stat().st_size)
            except Exception as error:  # noqa: BLE001 - isolate one artifact/video failure from the batch.
                derivative_errors["preview"] = str(error)[:500]
                log("preview_failed", file=source_path(root, video), error=type(error).__name__)

        scenes = old_scenes
        if vlm_enabled and (
            force
            or not already_processed
            or not scene_config_matches
            or not artifacts["scenes"].is_file()
            or artifacts["scenes"].stat().st_size <= 0
        ):
            try:
                log("scene_analysis_started", file=source_path(root, video))
                analysis = vlm_support.analyze_video(
                    video,
                    duration_seconds=float(probe["duration_seconds"]),
                    workdir=workdir,
                    provider=vlm_provider,
                    interval_seconds=vlm_interval,
                    max_frames=vlm_max_frames,
                )
                scenes = {
                    "id": entry_id(root, video),
                    "source_path": source_path(root, video),
                    "created_at": dt.datetime.now(dt.UTC).isoformat(),
                    "config_signature": scene_config_signature,
                    **analysis,
                }
                atomic_write_json(artifacts["scenes"], scenes)
                log("scene_analysis_completed", file=source_path(root, video), scenes=len(scenes.get("scenes") or []))
            except Exception as error:  # noqa: BLE001 - isolate one artifact/video failure from the batch.
                derivative_errors["scenes"] = str(error)[:500]
                log("scene_analysis_failed", file=source_path(root, video), error=type(error).__name__)
                # Remove stale scenes so they are not served as current after a config change.
                if not scene_config_matches and artifacts["scenes"].is_file():
                    artifacts["scenes"].unlink(missing_ok=True)
                    scenes = {}

        metadata.update({
            "status": "completed",
            "completed_at": dt.datetime.now(dt.UTC).isoformat(),
            "transcript_chars": len(str(transcript.get("text") or "")),
            "scene_count": len(scenes.get("scenes") or []),
            "scene_summary": str(scenes.get("summary") or ""),
            "scene_error": derivative_errors.get("scenes", ""),
            "derivative_errors": derivative_errors,
            "error": "",
        })
        atomic_write_json(artifacts["metadata"], metadata)
        return {**metadata, "text": str(transcript.get("text") or ""), "skipped": False}
    except Exception as error:
        metadata.update({
            "status": "error",
            "error": f"{type(error).__name__}: {error}"[:1000],
            "failed_at": dt.datetime.now(dt.UTC).isoformat(),
        })
        atomic_write_json(artifacts["metadata"], metadata)
        log("video_failed", file=source_path(root, video), error=type(error).__name__)
        raise
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(os.environ.get("AFTERIMAGE_ROOT", "")))
    parser.add_argument("--cache", type=Path, default=Path(os.environ.get("AFTERIMAGE_CACHE", "/tmp/afterimage-cache")))
    parser.add_argument("--date", default="", help="Only process YYYY-MM-DD")
    parser.add_argument("--file", default="", help="Only process one basename")
    parser.add_argument("--force", action="store_true", help="Regenerate transcription and derivatives")
    parser.add_argument("--no-preview", action="store_true", help="Skip browser preview encoding")
    parser.add_argument(
        "--stability-seconds",
        type=float,
        default=float(os.environ.get("STABLE_SECONDS", "10")),
        help="Unchanged interval required for periodic scans",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.root or not str(args.root):
        print("Error: --root or AFTERIMAGE_ROOT is required", file=sys.stderr)
        return 1
    root = args.root.resolve()
    cache = args.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    (cache / "work").mkdir(parents=True, exist_ok=True)
    public_origin = os.environ.get("AFTERIMAGE_ORIGIN", "http://localhost:8901")
    generate_web_preview = not args.no_preview and os.environ.get("GENERATE_PREVIEW", "true").lower() not in {"0", "false", "no"}

    with (cache / "ingest.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("ingest_skipped", reason="already_running")
            return 0

        videos = discover_videos(root, args.date)
        if args.file:
            videos = [video for video in videos if video.name == args.file]
        discovered_count = len(videos)
        if not args.date and not args.file:
            scan_state_path = cache / "scan-state.json"
            videos, scan_state = select_stable_videos(
                root,
                videos,
                read_json(scan_state_path),
                now=time.time(),
                stable_seconds=args.stability_seconds,
            )
            atomic_write_json(scan_state_path, scan_state)
        log("scan_completed", discovered=discovered_count, eligible=len(videos), deferred=discovered_count - len(videos), date=args.date or "all")
        failures = 0
        touched_dates: set[str] = set()
        compilation_dates: set[str] = set()
        for video in videos:
            date = day_from_video(root, video)
            compilation_dates.add(date)
            try:
                result = process_video(root, video, cache, generate_web_preview, force=args.force)
                if not result.get("skipped"):
                    touched_dates.add(date)
            except Exception:  # noqa: BLE001 - continue processing remaining videos.
                failures += 1
                touched_dates.add(date)
        for date in sorted(compilation_dates | touched_dates):
            rebuild_daily_memory(root, date, public_origin)
        if generate_web_preview:
            for date in sorted(compilation_dates):
                try:
                    build_daily_video(root, date, cache, force=args.force)
                except Exception as error:  # noqa: BLE001 - isolate one artifact/video failure from the batch.
                    failures += 1
                    log("daily_video_failed", date=date, error=type(error).__name__)
        log("ingest_completed", count=len(videos), failures=failures)
        return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
