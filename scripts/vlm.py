"""Pluggable vision-language model adapters for afterimage scene analysis."""

from __future__ import annotations

import base64
import json
import os
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol
from urllib import error, parse, request

DEFAULT_PROMPT = (
    "Describe only what is visibly present in this camera frame. "
    "Return JSON with exactly two fields: description (one factual sentence) "
    "and labels (an array of concise lowercase tags). Do not identify people "
    "or infer sensitive traits."
)


def frame_prompt(timestamp_seconds: float) -> str:
    """Add deterministic clip-relative timing without asking the model to invent chronology."""
    value = max(0.0, float(timestamp_seconds))
    minutes = int(value // 60)
    remainder = value - minutes * 60
    offset = f"{minutes:02d}:{remainder:06.3f}"
    return (
        f"{DEFAULT_PROMPT} "
        f"This frame was sampled at +{offset} from the clip start. "
        "Use this only as a clip-relative time anchor; do not infer wall-clock time, "
        "events between sampled frames, or actions that are not visible in this frame."
    )


class VisionProvider(Protocol):
    name: str
    model: str

    def analyze_frame(self, image: Path, timestamp_seconds: float) -> dict[str, Any]: ...


def sample_timestamps(duration_seconds: float, *, interval_seconds: float = 60, max_frames: int = 12) -> list[float]:
    """Choose deterministic timestamps while avoiding a potentially black first frame."""
    duration = max(0.0, float(duration_seconds))
    interval = float(interval_seconds)
    limit = int(max_frames)
    if interval <= 0:
        raise ValueError("interval_seconds must be positive")
    if limit < 1:
        raise ValueError("max_frames must be at least 1")
    if duration <= 0:
        return [0.0]

    current = min(1.0, duration / 3.0)
    timestamps: list[float] = []
    while current < duration and len(timestamps) < limit:
        timestamps.append(current)
        current += interval
    return timestamps or [max(0.0, duration / 2.0)]


def parse_scene_response(value: str | dict[str, Any]) -> dict[str, Any]:
    """Normalize provider JSON and reject unstructured or empty descriptions."""
    if isinstance(value, dict):
        payload = value
    else:
        text = str(value).strip()
        if text.startswith("```"):
            lines = text.splitlines()
            if lines and lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines).strip()
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            start = text.find("{")
            end = text.rfind("}")
            if start < 0 or end <= start:
                raise ValueError("VLM response did not contain a JSON object") from None
            payload = json.loads(text[start : end + 1])

    if not isinstance(payload, dict):
        raise TypeError("VLM response must be a JSON object")
    description = str(payload.get("description") or payload.get("summary") or "").strip()
    if not description:
        raise ValueError("VLM response description is empty")

    labels: list[str] = []
    seen: set[str] = set()
    raw_labels = payload.get("labels")
    if isinstance(raw_labels, list):
        for item in raw_labels:
            if not isinstance(item, str):
                continue
            label = item.strip().lower()[:80]
            if label and label not in seen:
                seen.add(label)
                labels.append(label)
            if len(labels) >= 20:
                break
    return {"description": description[:2000], "labels": labels}


def extract_frame(video: Path, destination: Path, timestamp_seconds: float) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{timestamp_seconds:.3f}",
            "-i",
            str(video),
            "-frames:v",
            "1",
            "-vf",
            "scale='min(1280,iw)':-2",
            "-q:v",
            "3",
            str(destination),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=300,
    )
    if completed.returncode or not destination.is_file() or destination.stat().st_size <= 0:
        raise RuntimeError("frame extraction produced an empty file")


def analyze_video(
    video: Path,
    *,
    duration_seconds: float,
    workdir: Path,
    provider: VisionProvider,
    interval_seconds: float = 60,
    max_frames: int = 12,
    frame_extractor: Callable[[Path, Path, float], None] = extract_frame,
) -> dict[str, Any]:
    frames_directory = workdir / "vlm-frames"
    frames_directory.mkdir(parents=True, exist_ok=True)
    scenes: list[dict[str, Any]] = []
    timestamps = sample_timestamps(
        duration_seconds,
        interval_seconds=interval_seconds,
        max_frames=max_frames,
    )
    for index, timestamp in enumerate(timestamps):
        image = frames_directory / f"frame-{index:03d}.jpg"
        frame_extractor(video, image, timestamp)
        observation = parse_scene_response(provider.analyze_frame(image, timestamp))
        scenes.append({
            "timestamp_seconds": timestamp,
            "description": observation["description"],
            "labels": observation["labels"],
        })

    summary = " ".join(scene["description"] for scene in scenes)[:8000]
    return {
        "version": 1,
        "provider": provider.name,
        "model": provider.model,
        "summary": summary,
        "scenes": scenes,
    }


def _read_limited(response: Any, limit: int = 2 * 1024 * 1024) -> bytes:
    body = response.read(limit + 1)
    if len(body) > limit:
        raise RuntimeError("VLM response exceeded size limit")
    return body


class NoRedirectHandler(request.HTTPRedirectHandler):
    """Reject HTTP redirects so credentials are never forwarded cross-origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError(f"VLM endpoint redirected to {newurl}; rejecting to protect credentials")


def _post_json(url: str, payload: dict[str, Any], *, headers: dict[str, str] | None = None, timeout: float = 120) -> dict[str, Any]:
    body = json.dumps(payload, separators=(",", ":")).encode()
    request_headers = {
        "content-type": "application/json",
        "user-agent": "afterimage/0.2",
        **(headers or {}),
    }
    http_request = request.Request(url, data=body, headers=request_headers, method="POST")
    # Reject redirects to prevent forwarding credentials to a different origin.
    opener = request.build_opener(NoRedirectHandler())
    try:
        with opener.open(http_request, timeout=timeout) as response:
            result = json.loads(_read_limited(response))
    except error.HTTPError as exc:
        detail = _read_limited(exc, 4096).decode("utf-8", "replace")
        raise RuntimeError(f"VLM request failed with HTTP {exc.code}: {detail[:500]}") from None
    except error.URLError as exc:
        raise RuntimeError(f"VLM request failed: {exc.reason}") from None
    except TimeoutError as exc:
        raise RuntimeError(f"VLM request timed out: {exc}") from None
    if not isinstance(result, dict):
        raise TypeError("VLM response was not a JSON object")
    return result


def _image_base64(image: Path) -> str:
    return base64.b64encode(image.read_bytes()).decode("ascii")


class OpenAICompatibleProvider:
    name = "openai"

    def __init__(self, *, model: str, api_key: str, base_url: str = "https://api.openai.com/v1", timeout: float = 120) -> None:
        if not api_key:
            raise ValueError("OPENAI_API_KEY or VLM_API_KEY is required")
        self.model = model
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def analyze_frame(self, image: Path, timestamp_seconds: float) -> dict[str, Any]:
        data_url = f"data:image/jpeg;base64,{_image_base64(image)}"
        result = _post_json(
            f"{self.base_url}/chat/completions",
            {
                "model": self.model,
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": frame_prompt(timestamp_seconds)},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }],
                "response_format": {"type": "json_object"},
                "temperature": 0,
            },
            headers={"authorization": f"Bearer {self.api_key}"},
            timeout=self.timeout,
        )
        try:
            content = result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise RuntimeError("OpenAI-compatible VLM response is missing message content") from None
        return parse_scene_response(content)


class OllamaProvider:
    name = "ollama"

    def __init__(self, *, model: str, base_url: str = "http://127.0.0.1:11434", timeout: float = 120) -> None:
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def analyze_frame(self, image: Path, timestamp_seconds: float) -> dict[str, Any]:
        result = _post_json(
            f"{self.base_url}/api/chat",
            {
                "model": self.model,
                "messages": [{"role": "user", "content": frame_prompt(timestamp_seconds), "images": [_image_base64(image)]}],
                "format": "json",
                "stream": False,
                "options": {"temperature": 0},
            },
            timeout=self.timeout,
        )
        try:
            content = result["message"]["content"]
        except (KeyError, TypeError):
            raise RuntimeError("Ollama VLM response is missing message content") from None
        return parse_scene_response(content)


class GeminiProvider:
    name = "gemini"

    def __init__(self, *, model: str, api_key: str, base_url: str = "https://generativelanguage.googleapis.com/v1beta", timeout: float = 120) -> None:
        if not api_key:
            raise ValueError("GEMINI_API_KEY or VLM_API_KEY is required")
        self.model = model
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def analyze_frame(self, image: Path, timestamp_seconds: float) -> dict[str, Any]:
        model = parse.quote(self.model, safe="")
        result = _post_json(
            f"{self.base_url}/models/{model}:generateContent",
            {
                "contents": [{
                    "role": "user",
                    "parts": [
                        {"text": frame_prompt(timestamp_seconds)},
                        {"inlineData": {"mimeType": "image/jpeg", "data": _image_base64(image)}},
                    ],
                }],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
            },
            headers={"x-goog-api-key": self.api_key},
            timeout=self.timeout,
        )
        try:
            content = result["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError, TypeError):
            raise RuntimeError("Gemini VLM response is missing text content") from None
        return parse_scene_response(content)


def create_provider_from_env() -> VisionProvider | None:
    provider = os.environ.get("VLM_PROVIDER", "none").strip().lower()
    timeout = float(os.environ.get("VLM_TIMEOUT", "120"))
    base_url = os.environ.get("VLM_BASE_URL", "").strip()
    api_key = os.environ.get("VLM_API_KEY", "").strip()
    if provider == "none":
        return None
    if provider in {"openai", "openai-compatible"}:
        instance = OpenAICompatibleProvider(
            model=os.environ.get("VLM_MODEL") or "gpt-4.1-mini",
            api_key=api_key or os.environ.get("OPENAI_API_KEY", ""),
            base_url=base_url or "https://api.openai.com/v1",
            timeout=timeout,
        )
        instance.name = provider
        return instance
    if provider == "ollama":
        return OllamaProvider(
            model=os.environ.get("VLM_MODEL") or "qwen3-vl:8b",
            base_url=base_url or "http://127.0.0.1:11434",
            timeout=timeout,
        )
    if provider == "gemini":
        return GeminiProvider(
            model=os.environ.get("VLM_MODEL") or "gemini-2.5-flash-lite",
            api_key=api_key or os.environ.get("GEMINI_API_KEY", ""),
            base_url=base_url or "https://generativelanguage.googleapis.com/v1beta",
            timeout=timeout,
        )
    raise ValueError("VLM_PROVIDER must be one of: none, openai, openai-compatible, ollama, gemini")
