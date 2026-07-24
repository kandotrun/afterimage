# afterimage

**Your physical world, remembered.**

afterimage is a self-hosted lifelog platform that turns your camera footage into AI-queryable context. Point it at a folder of videos — from a body cam, a home camera, your phone — and it extracts audio, transcribes speech, generates previews, and serves everything through a web UI, REST API, and [MCP](https://modelcontextprotocol.io) server so your AI agents can search your life.

screenpipe records your screen. **afterimage records the physical world.**

## Why

AI agents are powerful, but they have no memory of what actually happened around you today. afterimage bridges that gap:

- **Ingest** — Drop videos into a watched folder. afterimage extracts audio, transcribes speech (Whisper, OpenAI, or any STT provider), generates thumbnails and web-ready previews, and builds daily combined videos.
- **Store** — Everything lands in a structured file tree (metadata, transcripts, thumbnails, previews) with SQLite-ready JSON. No vendor lock-in.
- **Serve** — A zero-dependency Node.js server exposes a web UI for browsing, a REST API for programmatic access, and an MCP server so AI agents (Claude, Hermes, OpenClaw, etc.) can query your day.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/kandotrun/afterimage.git
cd afterimage

# 2. Configure
cp .env.example .env
# Edit .env — set AFTERIMAGE_ROOT to your video folder

# 3. Run with Docker
docker compose up -d

# 4. Open
# Web UI:  http://localhost:8901/app
# MCP:     http://localhost:8901/mcp
# Health:  http://localhost:8901/_health
```

### Without Docker

```bash
# Node.js server (web UI + API + MCP)
npm install
AFTERIMAGE_ROOT=/path/to/videos node src/server.mjs

# Ingest pipeline (Python, requires ffmpeg)
cd scripts
pip install -r requirements.txt
python ingest.py --root /path/to/videos
```

## Architecture

```
[Camera / Video Source]  RTSP · RTMP · USB · File · Phone
        │
        ▼   ingest (Python)
  ┌─────────────────────────────────┐
  │  ffprobe → audio extract        │
  │  STT (Whisper / OpenAI / …)     │
  │  thumbnail + web preview        │
  │  daily combined video           │
  └─────────────────────────────────┘
        │
        ▼   store
  ┌─────────────────────────────────┐
  │  daily/YYYY/MMDD/*.mp4  (source)│
  │  audio/   transcripts/          │
  │  thumbnails/  web/  metadata/   │
  │  memory/ (daily markdown)       │
  └─────────────────────────────────┘
        │
        ▼   serve (Node.js)
  ┌─────────────────────────────────┐
  │  /app        Web UI             │
  │  /api/*      REST API           │
  │  /mcp        MCP Server         │
  │  /_health    Health check       │
  └─────────────────────────────────┘
```

## MCP Tools

Connect any MCP-compatible AI agent to `http://<host>:8901/mcp`:

| Tool | Description |
|------|-------------|
| `list_daily_entries` | List videos by date with transcription status |
| `get_daily_entry` | Get full metadata + transcript for one video |
| `search_daily_transcripts` | Full-text search across all transcripts |
| `get_daily_memory_context` | Get a day's videos as Markdown for AI memory |

## Configuration

All configuration via environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `AFTERIMAGE_ROOT` | *(required)* | Path to your video storage root |
| `AFTERIMAGE_MODE` | `lifelog` | Server mode: `lifelog` or `public` |
| `AFTERIMAGE_ORIGIN` | `http://localhost:8901` | Public origin for MCP endpoint |
| `AFTERIMAGE_ASSET_ORIGIN` | *(same as origin)* | Origin for video/asset URLs |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8901` | Listen port |
| `STT_PROVIDER` | `whisper` | STT backend: `whisper`, `openai`, `none` |
| `OPENAI_API_KEY` | | Required when `STT_PROVIDER=openai` |
| `WHISPER_MODEL` | `base` | Whisper model size (tiny/base/small/medium/large) |

## Storage Layout

```
$AFTERIMAGE_ROOT/
├── daily/2026/0724/clip001.mp4      # Source videos (you add these)
├── audio/2026/0724/clip001.mp4.mp3  # Extracted audio
├── transcripts/2026/0724/clip001.mp4.json  # STT results
├── thumbnails/2026/0724/clip001.mp4.jpg    # Preview thumbnails
├── web/2026/0724/clip001.mp4.mp4    # Web-ready previews
├── web/2026/0724/day.mp4            # Combined daily video
├── metadata/2026/0724/clip001.mp4.json     # ffprobe metadata
└── memory/2026/0724.md              # Daily markdown summary
```

## Roadmap

- [x] Core ingest pipeline (audio, STT, thumbnails, previews, daily video)
- [x] Web UI with daily player, chapter navigation, live transcript
- [x] REST API (entries, search, memory context)
- [x] MCP server (4 read-only tools)
- [x] Docker Compose deployment
- [ ] VLM scene analysis (Gemini, OpenAI, Ollama — pluggable)
- [ ] RTSP/RTMP live stream ingestion
- [ ] SQLite index for large libraries
- [ ] Authentication (Basic Auth / token)
- [ ] Multi-user support
- [ ] Mobile upload endpoint

## License

[MIT](LICENSE)
