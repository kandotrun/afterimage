# afterimage

**Your physical world, remembered.**

afterimage is a self-hosted lifelog platform that turns camera footage into AI-queryable context. Point it at videos from a body camera, home camera, or phone. It samples visual scenes with a VLM, transcribes speech when requested, creates browser-ready media, and serves the result through a web UI, REST API, and [MCP](https://modelcontextprotocol.io) server.

screenpipe records your screen. **afterimage records the physical world.**

## What it does

- **Ingest** — Discover videos, probe metadata, create thumbnails/previews, transcribe audio, and sample visual scenes.
- **Analyze** — Use Gemini, OpenAI-compatible APIs, or Ollama for pluggable visual analysis. Use local Whisper or OpenAI for speech.
- **Store** — Keep source videos and portable JSON/text artifacts in a predictable file tree. No hosted database or vendor lock-in.
- **Serve** — Browse your day, search transcript and visual context, or give an AI agent read-only access through MCP.
- **Protect** — Optionally require a bearer token, HTTP Basic credentials, or both for every private route.

## Quick start

```bash
git clone https://github.com/kandotrun/afterimage.git
cd afterimage
cp .env.example .env
```

Edit `.env` and set `AFTERIMAGE_ROOT`. If the server is reachable by another machine, also set a strong `AFTERIMAGE_AUTH_TOKEN` or Basic credentials.

```bash
docker compose up -d
```

- Web UI: `http://localhost:8901/app`
- MCP: `http://localhost:8901/mcp`
- Health: `http://localhost:8901/_health`

Put source videos under `$AFTERIMAGE_ROOT/daily/YYYY/MMDD/`, then run ingestion:

```bash
docker compose run --rm afterimage python scripts/ingest.py --root /data
```

### Without Docker

Requires Node.js 22+, Python 3.11+, and ffmpeg.

```bash
npm ci
AFTERIMAGE_ROOT=/path/to/lifelog npm start

python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
# Also install local Whisper when STT_PROVIDER=whisper:
.venv/bin/pip install -r scripts/requirements-whisper.txt
.venv/bin/python scripts/ingest.py --root /path/to/lifelog
```

## Visual scene analysis

Visual analysis is off by default. It samples one frame per minute, up to 12 frames per video, and writes a factual summary plus timestamped scene labels.

### Gemini

```env
VLM_PROVIDER=gemini
VLM_MODEL=gemini-3.1-flash-lite
GEMINI_API_KEY=...
```

### OpenAI

```env
VLM_PROVIDER=openai
VLM_MODEL=gpt-4.1-mini
OPENAI_API_KEY=...
```

`openai-compatible` can target another `/v1/chat/completions` endpoint:

```env
VLM_PROVIDER=openai-compatible
VLM_MODEL=my-vision-model
VLM_BASE_URL=https://example.com/v1
VLM_API_KEY=...
```

### Ollama

```env
VLM_PROVIDER=ollama
VLM_MODEL=qwen3-vl:8b
VLM_BASE_URL=http://host.docker.internal:11434
```

Control cost and density with `VLM_FRAME_INTERVAL`, `VLM_MAX_FRAMES`, and `VLM_TIMEOUT`.

## Authentication

All routes except `/_health` require authentication when credentials are configured.

```env
# Recommended for MCP clients
AFTERIMAGE_AUTH_TOKEN=replace-with-a-long-random-value

# Convenient for browser access
AFTERIMAGE_AUTH_USER=afterimage
AFTERIMAGE_AUTH_PASSWORD=replace-with-a-long-random-value
```

MCP clients should send `Authorization: Bearer <token>`. If both token and Basic credentials are configured, either method is accepted.

> afterimage contains highly sensitive camera data. Do not expose it to the public internet without authentication and TLS. Prefer a private network or an authenticated reverse proxy.

## Architecture

```text
[RTSP / RTMP / USB / File / Phone]
                  │
                  ▼ ingest (Python + ffmpeg)
┌──────────────────────────────────────────┐
│ probe → frame sampling → VLM             │
│       → audio extract → optional STT     │
│       → thumbnail / preview / day video  │
└──────────────────────────────────────────┘
                  │
                  ▼ portable file store
┌──────────────────────────────────────────┐
│ daily/  metadata/  scenes/  transcripts/ │
│ thumbnails/  web/  memory/               │
└──────────────────────────────────────────┘
                  │
                  ▼ serve (Node.js)
┌──────────────────────────────────────────┐
│ /app      Web UI                         │
│ /api/*    REST API                       │
│ /mcp      MCP Streamable HTTP            │
│ /_health  Public health check            │
└──────────────────────────────────────────┘
```

## MCP tools

| Tool | Description |
|---|---|
| `list_daily_entries` | List videos by date with transcript and visual-analysis status |
| `get_daily_entry` | Get complete metadata, scenes, transcript, and source URLs |
| `search_daily_transcripts` | Search filename, speech, scene descriptions, and labels |
| `get_daily_memory_context` | Get a day's source-backed Markdown context for an AI agent |

Example MCP configuration:

```json
{
  "mcpServers": {
    "afterimage": {
      "url": "https://afterimage.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${AFTERIMAGE_AUTH_TOKEN}"
      }
    }
  }
}
```

## Configuration

See [`.env.example`](.env.example) for every setting.

| Variable | Default | Description |
|---|---|---|
| `AFTERIMAGE_ROOT` | required | Storage root |
| `AFTERIMAGE_MODE` | `lifelog` | `lifelog` or `public` |
| `AFTERIMAGE_ORIGIN` | local URL | Public server/MCP origin |
| `AFTERIMAGE_ASSET_ORIGIN` | server origin | Optional separate media origin |
| `BIND_ADDRESS` | `127.0.0.1` | Compose host interface; use `0.0.0.0` only with auth |
| `INSTALL_LOCAL_WHISPER` | `1` | Include local Whisper in the Docker image |
| `AFTERIMAGE_AUTH_TOKEN` | empty | Bearer token |
| `AFTERIMAGE_AUTH_USER` | empty | Basic Auth username |
| `AFTERIMAGE_AUTH_PASSWORD` | empty | Basic Auth password |
| `STT_PROVIDER` | `whisper` | `whisper`, `openai`, or `none` |
| `WHISPER_MODEL` | `base` | Local Whisper size |
| `VLM_PROVIDER` | `none` | `gemini`, `openai`, `openai-compatible`, `ollama`, or `none` |
| `VLM_MODEL` | provider-specific | Vision model name |
| `VLM_FRAME_INTERVAL` | `60` | Seconds between sampled frames |
| `VLM_MAX_FRAMES` | `12` | Maximum frames analyzed per video |
| `GENERATE_PREVIEW` | `true` | Create browser-compatible videos |
| `STABLE_SECONDS` | `10` | Unchanged-file guard; set `0` for one-shot imports |

## Storage layout

```text
$AFTERIMAGE_ROOT/
├── daily/2026/0724/clip001.mp4
├── audio/2026/0724/clip001.mp4.mp3
├── metadata/2026/0724/clip001.mp4.json
├── scenes/2026/0724/clip001.mp4.json
├── transcripts/2026/0724/clip001.mp4.json
├── transcripts/2026/0724/clip001.mp4.txt
├── thumbnails/2026/0724/clip001.mp4.jpg
├── web/2026/0724/clip001.mp4.mp4
├── web/2026/0724/day.mp4
└── memory/2026/0724.md
```

## Development

```bash
npm ci
npm run check
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements-dev.txt
.venv/bin/ruff check scripts
.venv/bin/pyright scripts

# Lightweight image used by CI (no local Whisper weights/runtime):
docker build --build-arg INSTALL_LOCAL_WHISPER=0 -t afterimage:dev .
```

The test suite exercises the storage/search layer, Basic and bearer authentication, a real MCP SDK client, ingest edge cases, and the pluggable VLM contract. CI also builds the Docker image.

## Roadmap

- [x] Core ingest pipeline, previews, thumbnails, and daily video
- [x] Pluggable VLM scene analysis: Gemini, OpenAI-compatible, Ollama
- [x] Speech-to-text: local Whisper, OpenAI, or disabled
- [x] Web UI, REST API, and four read-only MCP tools
- [x] Basic/Bearer authentication
- [x] Automated tests, dependency audit, and Docker CI
- [ ] RTSP/RTMP live stream ingestion
- [ ] SQLite FTS index for large libraries
- [ ] Mobile upload endpoint
- [ ] Multi-user policy and per-camera access controls

## License

[MIT](LICENSE)
