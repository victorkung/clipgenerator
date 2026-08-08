# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) for tagged releases.

## [Unreleased]

### Added

- **Caption plate designer + burn-in:** app-wide style (serif/sans, cream/night plate, size, position, align, vertical nudge) saved on-device; export burns plates when cues exist and always writes `.srt`
- **True WYSIWYG caption preview:** monitor uses the same Pillow PNG renderer as export (`/api/caption-plate-preview`) so wraps and opacity match the file
- **Monitor fullscreen with captions:** fullscreens the whole monitor (video + plate), not just the `<video>`; video controls fullscreen is promoted to the monitor
- **Clip captions:** generate from source transcript (clip-relative times), edit text in Captions tab
- **Pane tabs:** Transcript · Captions · Post · Agent handoff (`CLIPGENERATOR_AGENT_FLOW`, default off; `serve.sh` sets on)
- **Agent packages:** split `agent-export/summary/` and `agent-export/clip/`; lean X-only clip-plan import; editable post text + shared prompts
- **Public packaging:** public `prompts/` (pipeline docs + schema); private packs under gitignored `prompts/private/**`; brand assets; README screenshots; MIT `LICENSE`; [docs/PUBLIC_REPO.md](docs/PUBLIC_REPO.md)
- **Editor craft zones:** Clip / Caption / Export with clearer primary actions
- **Keyboard marks:** `I` set start · `O` set end (ignored while typing in fields)
- **Retry transcribe** when a source errors after video is on disk
- **Open in Finder** on successful media export paths
- **Short-source warning** when duration is under ~90s (promo-clip gotcha)
- **Import notice** after clip-plan import (persists until dismiss / switch source)
- Brand cut-mark glyph + **a local clip desk** tagline

### Changed

- **Opaque caption plates:** cream/night fills are fully solid in preview and burn-in (no translucent wash)
- **Export progress:** fix ffmpeg `out_time_ms` unit (no 99% flash); single percent in the status line; preparing-captions stage before encode
- **Caption craft actions:** primary **Apply changes** (save cues); regenerate is secondary
- **Post text:** copy/save no longer re-appends `@handles`; handles are baked once on clip-plan import only
- **Clip title / post drafts:** focus-protected so poll/reload does not wipe mid-edit
- **Clip select:** seeks to `t_in`, opens Transcript, scrolls the in-line to the top of the paper (works while playing)
- **Transcript margin in/out:** positioned from real line boxes (not linear time %), so marks match the yellow range wash
- **Sources sidebar:** newest ingest first (`created_at`), not status-grouped
- **Clip delete control:** on the meta row like sources (no longer overlapping status)
- **Transcript scroll:** big seeks pin near top; playhead crawl stays `nearest`
- **Craft accordion:** Clip / Caption plate / Export sections collapse independently (all open by default)
- **Whisper model copy:** small = faster default; medium = clearer when names/jargon/noise fail
- **Post-STT resilience:** heal sources to ready when transcript exists on disk after API restart; ignore transient poll errors during long STT
- **Honest STT progress:** Whisper no longer fakes “% done” or a precise ETA; shows real elapsed time, indeterminate bar, and a rough wall-time range (download still uses real yt-dlp %)
- Agent handoff paper fills the center pane (no dark void under short content)
- Agent prompts persist on-device via localStorage (every edit) + debounced library mirror; labels say “saved on this device”
- Public repo renamed to `victorkung/clipgenerator`; private companion repo retired
- Docs cleanup: single-repo private packs (no companion private repo required); removed superseded design plan docs
- **Desk feedback pass:** Post is a center tab; craft = Clip → Caption → Export; Start/End labels; wider transcript + craft column
- **Whisper allowlist:** UI and API accept **small** and **medium** only (unknown sizes fall back to small); CLI still supports more models
- Export success paths show `/clips/…` only; sidebar foot is **Open in Finder**
- Agent handoff: shared editable prompts (localStorage), general-purpose copy, brand assets under `brand/`, favicons in frontend public
- Source folder date is **ingest/posting day** (today), not the content’s original upload date
- Typed Start/End times seek the player and scroll the transcript (Apply / Enter / blur)
- Whisper model dropdown: least → most powerful, with length guidance
- `AGENTS.md` / README: short session bootstrap so new Grok sessions skip re-discovery
- Export progress (message + %) shows under the clip-bar export buttons, not the top page banner
- Export ffmpeg: drain stderr (fixes deadlock hang at 0%) and seek with pre-input `-ss` so long sources start encoding quickly
- Export success/progress clears when switching sources (no leftover banner on the next video)
- **Desk theme (Claude Design):** warm ink desk + paper transcript, Newsreader / Instrument Sans / IBM Plex Mono, terracotta craft accent, square 2px radius, no glow/mesh
- **Three-column IA:** Sources + Clips rail · paper center · craft (monitor / ruler / mark / export / post); clips list moved out of the player column
- **Pane tabs:** Transcript | Captions | Agent handoff (flag); collapses prior Editor/Agent main-tab split — product behaviour unchanged
- Export all always visible next to Export clip; captions show absolute source time column; status words replace pills
- Post package **collapses when empty**; expands when plan-imported or has post text
- Sidebar shows duration; ready sources sort first
- Copy post / URLs flash “Copied”; captions feedback separated from media export status
- Design system docs rewritten for Desk (`app/frontend/DESIGN.md`)

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
