# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) for tagged releases.

## [Unreleased]

### Added

- **Clip captions:** generate from source transcript (clip-relative times), edit text in Captions tab, live overlay on source player; export writes `.srt` sidecar
- **Main tabs:** Editor · Agent flow (`CLIPGENERATOR_AGENT_FLOW`, default off; `serve.sh` sets on)
- **Agent packages:** split `agent-export/summary/` and `agent-export/clip/`; lean X-only clip-plan import; editable post text
- **Option B packaging:** public `prompts/` (pipeline docs + schema); private packs under gitignored `prompts/private/**`
- **Editor craft zones:** Mark / Export / Post sections with clearer primary actions
- **Keyboard marks:** `I` set start · `O` set end (ignored while typing in fields)
- **Retry transcribe** when a source errors after video is on disk
- **Reveal in Finder** on successful media export paths
- **Short-source warning** when duration is under ~90s (promo-clip gotcha)
- **Import notice** after clip-plan import (persists until dismiss / switch source)
- Brand cut-mark glyph + **local clip studio** tagline
- Design redesign plan: `docs/DESIGN_REDESIGN.md`

### Changed

- Source folder date is **ingest/posting day** (today), not the content’s original upload date
- Typed Start/End times seek the player and scroll the transcript (Apply / Enter / blur)
- Whisper model dropdown: least → most powerful, with length guidance
- `AGENTS.md` / README: short session bootstrap so new Grok sessions skip re-discovery
- Export progress (message + %) shows under the clip-bar export buttons, not the top page banner
- Export ffmpeg: drain stderr (fixes deadlock hang at 0%) and seek with pre-input `-ss` so long sources start encoding quickly
- Export success/progress clears when switching sources (no leftover banner on the next video)
- **UI redesign (premium):** cool zinc + amber craft system, Inter + JetBrains Mono times, command-bar ingest, NLE mark rail + timeline strip, elevated cards, motion tokens, polished empty state
- **High-contrast pass:** solid control fills, stronger borders, visible inputs, solid green Set in, brighter timeline track/range, filled ghost buttons (no bare text on dark panels)
- Post package **collapses when empty**; expands when plan-imported or has post text
- Agent flow: source context strip, per-step status, clearer stepper chips
- Sidebar shows duration; ready sources sort first
- Copy post / URLs flash “Copied”; captions feedback separated from media export status
- Design system docs synced to live tokens (`app/frontend/DESIGN.md`)

### Planned

- Caption burn-in on export
- AI-suggested clip board
- Optional post scheduling

## [0.2.0] — 2026-08-03

Clip studio pivot: local multi-clip UI on top of the download CLI.

### Added

- Local **MLX Whisper** STT (default `small`, segment timestamps; no API key)
- **Web UI** (Vite + React) + **FastAPI** backend (`./scripts/serve.sh`, `app/frontend`)
- Multi-clip workflow: sources library, in/out marks, transcript highlight + seek
- Export clips as H.264 + AAC into `videos/…/clips/`
- Stage pipeline UI (resolve → download → transcribe → ready) with progress
- Source rename / remove from sidebar (disk files kept)
- Per-source folders: `videos/YYYY-MM-DD Podcast Name/source.mp4`
- Design system docs and tokens (`app/frontend/DESIGN.md`, Inter UI font)
- `CHANGELOG.md` for release notes

### Changed

- Product framing and README for **clipgenerator** (CLI + UI monorepo)
- Download defaults: concurrent HLS fragments (`-N 8`), clearer progress
- STT path optimized for speed (no word-level timestamps by default; single-pass decode)
- API default: no auto-reload (avoids killing long jobs)

### Fixed

- Export producing silent/corrupt audio (VideoToolbox + early seek); reliable libx264 + AAC path
- `--print` implying quiet mode and hiding download progress

### Removed

- xAI STT from the happy path (optional BYO cloud key no longer required)

## [0.1.0] — 2026-08-01

Initial public CLI.

### Added

- `download.sh` / `to-h264.sh` / `transcribe.sh` for YouTube and X
- yt-dlp config, H.264 ensure, optional YouTube captions path
- Agent git gatekeeper docs (`AGENTS.md`)

[Unreleased]: https://github.com/victorkung/clipgenerator/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/victorkung/clipgenerator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/victorkung/clipgenerator/releases/tag/v0.1.0
