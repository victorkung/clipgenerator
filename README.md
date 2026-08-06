# clipgenerator

Local tool: **download** a long YouTube/X video, **transcribe on-device** (MLX Whisper), then **cut many clips** with a live, highlighting transcript — and export X-ready H.264 MP4s.

Personal daily driver. No cloud STT bill. No multi-tenant hosting.

```text
URL → download → Whisper transcript → multi-clip editor → export clips/
```

Release history: **[CHANGELOG.md](CHANGELOG.md)** (Keep a Changelog style). UI design system: **[app/frontend/DESIGN.md](app/frontend/DESIGN.md)**.

## New Grok / AI session (shortest path)

Grok **auto-loads [AGENTS.md](AGENTS.md)** at session start (project rules). That file is the source of truth for agents — git rules + a compact product map. You do **not** need to paste chat history.

**Human / agent checklist for a fresh session:**

1. Work in this repo root: `clipgenerator` (`victorkung/clipgenerator`).
2. Trust **AGENTS.md** first; only open other files when the task needs them (table inside AGENTS.md).
3. For “what shipped / what’s next”: `CHANGELOG.md` → `[Unreleased]`.
4. To run the app: section **Quick start — web UI** below (API `:8787`, UI `:5173`).
5. Prefer a **new session** when context is large or the task is unrelated — don’t burn tokens re-exploring.

Optional (experimental): enable Grok cross-session memory if you want recall across days — see Grok docs on memory (`grok --experimental-memory` / config). Project facts still belong in **AGENTS.md**, not chat.

## Prerequisites

```bash
brew install yt-dlp ffmpeg
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
5. **Generate captions** (optional) → edit in the **Captions** tab; overlay previews on the player while scrubbing the **source** video.
6. **Export clip** → `videos/…/clips/*.mp4` (H.264 + AAC). If captions exist, also writes a matching `.srt` (times from clip start). Burn-in onto the video is not implemented yet.

### Editing clips

| Action | How |
|--------|-----|
| Set start | Playhead → **Set start**, or ⌥/Alt+click a transcript line |
| Set end | Playhead → **Set end**, or Shift+click a transcript line |
| Type times | Start/End fields → Enter or **Apply** (jumps player + transcript to that time) |
| Captions | **Generate captions** on the active clip → **Captions** tab to edit text; click a cue time to seek |
| New range on same video | **+ New clip** |
| Rename source | Click the title or **Rename** |
| Remove from sidebar | **×** or **Remove** (files on disk are kept) |

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
├── scripts/
│   ├── download.sh      # yt-dlp + H.264 ensure
│   ├── to-h264.sh
│   ├── transcribe.sh    # MLX Whisper / sidecar captions
│   ├── transcribe.py
│   └── serve.sh         # local FastAPI (no auto-reload by default)
├── app/
│   ├── backend/         # ingest, clips, export API
│   └── frontend/        # Vite + React UI + DESIGN.md
├── config/yt-dlp.conf
├── CHANGELOG.md         # release notes
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

| Release | Scope |
|---------|--------|
| **0.2 (this)** | Local Whisper, multi-clip UI, export with audio, design system |
| Later | Caption burn-in, AI clip suggestions, post scheduling |

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
