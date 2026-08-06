# clipgenerator

**Local multi-clip studio** for long YouTube and X videos: download → on-device transcription → mark in/out with a live transcript → export clean H.264+AAC clips (optional SRT captions).

No cloud speech bill. No accounts. No multi-tenant hosting. Runs on your machine (Apple Silicon recommended for MLX Whisper).

```text
URL → yt-dlp download → MLX Whisper STT → multi-clip editor → export clips/
```

| | |
|--|--|
| **UI** | http://127.0.0.1:5173 (Vite) |
| **API** | http://127.0.0.1:8787 (FastAPI) |
| **Changelog** | [CHANGELOG.md](CHANGELOG.md) |
| **Design system** | [app/frontend/DESIGN.md](app/frontend/DESIGN.md) |
| **Agent pipeline (optional)** | [prompts/AGENT_PIPELINE.md](prompts/AGENT_PIPELINE.md) |

## For AI coding agents

Auto-load **[AGENTS.md](AGENTS.md)** first (product map + git rules). Prefer that over re-exploring the tree. Recent changes: `CHANGELOG.md` → `[Unreleased]`.

## Features

- **Ingest** YouTube or X URLs (yt-dlp + H.264 normalize)
- **Local Whisper** (MLX) with progress — default model `small`
- **Multi-clip editor** on one source: playhead marks, typed times, transcript click / modifiers
- **Captions** from the source transcript (clip-relative times) + SRT on export
- **Export** H.264 + AAC into `videos/…/clips/`
- **Optional Agent flow** — export markdown packs for an external LLM, import a lean clip-plan JSON (bring your own prompts; see [prompts/](prompts/))

## Prerequisites

```bash
brew install yt-dlp ffmpeg
git clone https://github.com/victorkung/clipgenerator-public.git
cd clipgenerator-public   # or your local folder name
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd app/frontend && npm install && cd ../..
```

**Apple Silicon (M-series)** is expected for MLX Whisper. First transcribe downloads model weights (default **`small`**).

## Quick start — web UI

**Terminal 1 — API** (keep this running):

```bash
./scripts/serve.sh
# → http://127.0.0.1:8787
# Sets CLIPGENERATOR_AGENT_FLOW=1 by default (Agent flow tab).
# Editor-only: CLIPGENERATOR_AGENT_FLOW=0 ./scripts/serve.sh
# Do not use RELOAD=1 while long downloads/STT are running (restarts kill jobs).
```

**Terminal 2 — UI**:

```bash
cd app/frontend && npm run dev
# → http://127.0.0.1:5173  (proxies /api → 8787)
```

Then:

1. Paste a YouTube or X URL → **Ingest** (download + transcribe). Check duration — some X posts are short **promo clips**, not the full episode.
2. Wait for status **ready** (stage pipeline + progress bar).
3. Play video; transcript highlights by time; click a line to seek.
4. **Set start** / **Set end** from the playhead, or type `m:ss` / `h:mm:ss` (Enter or **Apply** seeks the player + transcript).
5. **Editor:** mark clips, optional captions, **Export clip**.
6. **Agent flow** (optional tab): brief → summary package → paste summary URL → clip package → import JSON — [prompts/AGENT_PIPELINE.md](prompts/AGENT_PIPELINE.md).
7. **Export clip** → `videos/…/clips/*.mp4` (+ `.srt` if captions exist). Burn-in onto video is not implemented yet.

### Private editorial packs (optional)

Brand-specific LLM instructions are **not** in this public repo. Keep them in a private folder or a separate private git remote under `prompts/private/` (gitignored except the public [prompts/private/README.md](prompts/private/README.md)). The app never requires a private pack — paste prompts into your LLM product of choice.

### Editing clips

| Action | How |
|--------|-----|
| Set start | Playhead → **Set start**, key **I**, or ⌥/Alt+click a transcript line |
| Set end | Playhead → **Set end**, key **O**, or Shift+click a transcript line |
| Type times | Start/End fields → Enter or **Apply** (jumps player + transcript to that time) |
| Agent flow | Optional tab (`CLIPGENERATOR_AGENT_FLOW=1`) → packages + import |
| Captions | **Generate captions** on the active clip → **Captions** tab to edit text; click a cue time to seek |
| Post package | Collapsible under Export; copy post / summary URL for manual X posting |
| New range on same video | **+ New clip** (Clips header) |
| Rename source | Click the title or **Rename** |
| Remove from sidebar | **×** or **Remove** (files on disk are kept) |
| Retry STT | On error (video present) → **Retry transcribe** |

**Caption workflow note:** There is no separate clip-only player yet. You always scrub the long source; captions are stored **relative to the clip’s start** so they match the exported file. If you change in/out after generating, regenerate captions.

Library state: gitignored `data/library.json` (sidebar only). Media: gitignored `videos/`.

### Folder layout

The date prefix is the **ingest / posting day** (when you download it), not the original publish date — so you can group by the day you’re posting clips.

```text
videos/
  2026-08-03 All-In Podcast/     ← today, if you ingested today
    source.mp4
    source.audio.m4a
    source.transcript.json
    source.transcript.txt
    agent-export/                ← Agent Export (for Grok web)
      summary/                   ← Summary agent package
      clip/                      ← Clipping agent package
    clips/
      chamath-leverage-cf4c1e.mp4
```

Typical cleanup after upload: delete `source.mp4` (+ audio/transcript) to save space; later delete the whole folder. Removing a source from the UI only drops the library row, not disk files.

## CLI (headless)

```bash
./scripts/download.sh "https://x.com/user/status/…"
./scripts/transcribe.sh "videos/….mp4"              # default: small
./scripts/transcribe.sh --model turbo "videos/….mp4"
./scripts/download.sh --with-subs "https://www.youtube.com/watch?v=…"
./scripts/transcribe.sh "videos/….mp4"              # prefers free captions when present
```

## Whisper models

Default is **`small`** with **segment** timestamps only (fast enough for clipping; no word-level karaoke timing).

Listed **least → most powerful**. Pick by length and how hard the audio is — not auto-selected by duration.

| Model | Power | When |
|-------|-------|------|
| **`small` (default)** | lightest | **Any length** daily driver. ~sub‑5 min STT on ~1.5h English pods (M-series). |
| `medium` | mid | Stronger than small. Prefer **under ~45–60 min**, or when small mangles names/jargon. |
| `turbo` | strong | Near-large quality, still relatively fast. Best upgrade for **long pods** that need accuracy. |
| `large-v3` | max | Highest accuracy; slowest / most RAM. **Short clips** or very hard audio only. |

Override in the UI dropdown or `--model`.

Optional model cache (e.g. external SSD):

```bash
# .env (never commit)
MODEL_DIR=/Volumes/YourDrive/Open Source Models
```

## Download notes

- Prefers ≥1080p H.264; always ensures H.264+AAC before finish
- **8 concurrent HLS fragments** (`-N 8` in `config/yt-dlp.conf`); try `-N 16` if the CDN allows
- Line-based download progress; X posts can attach full episodes (check duration banner)
- `./scripts/download.sh -h`

## Project layout

```text
clipgenerator/
├── scripts/             # download, transcribe, serve
├── app/
│   ├── backend/         # FastAPI: ingest, clips, export, agent packages
│   └── frontend/        # Vite + React UI + design tokens
├── prompts/             # public agent-pipeline docs + clip-plan schema
│   └── private/         # your packs only (gitignored) — see private/README.md
├── config/yt-dlp.conf
├── docs/                # design notes
├── data/                # library.json (gitignored)
└── videos/              # media (gitignored)
```

## Releases

We document user-facing changes in **[CHANGELOG.md](CHANGELOG.md)** under Keep a Changelog sections (`Added` / `Changed` / `Fixed`).

When shipping a tagged release:

```bash
# after merging/committing on main
git tag -a v0.2.0 -m "v0.2.0 — multi-clip UI + local Whisper"
git push origin main --tags
# optional: gh release create v0.2.0 --notes-file CHANGELOG.md
```

Bump the version header in `CHANGELOG.md` for each public drop.

## Responsible use

- You are responsible for complying with **YouTube**, **X**, and **copyright** rules for any URL you download or clip you publish.
- Prefer content you own, are licensed to use, or that the platform allows for personal offline use.
- This tool does **not** grant rights to redistribute others’ shows.
- Keep `.env`, `data/`, and `videos/` private (gitignored).
- Localhost only — do not expose the API to the public internet.

## Roadmap

| Status | Scope |
|--------|--------|
| **Shipped** | Local Whisper, multi-clip UI, captions + SRT, agent package export/import, design system |
| **Later** | Caption burn-in on export, richer publish board, optional schedulers |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `mlx-whisper is not installed` | `source .venv/bin/activate && pip install -r requirements.txt` |
| First STT is slow | Model download; later runs use cache. Prefer `small` / `turbo`. |
| STT / download dies mid-job | Don’t run `RELOAD=1` on the API while jobs run |
| Fans / heat on long pods | Normal under MLX; plug in |
| UI can’t reach API | `./scripts/serve.sh` on 8787; Vite on 5173 |
| Export silent / broken audio | Re-export after the 0.2 fix (libx264 + AAC, accurate seek). Delete old bad clip files. |
| Export feels stuck | Watch the yellow/green banner; long clips re-encode and take a moment |

Formerly known in git history as `yt-x-vid-downloader-transcriber`.
