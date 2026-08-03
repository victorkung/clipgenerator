# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) for tagged releases.

## [Unreleased]

### Changed

- Source folder date is **ingest/posting day** (today), not the content’s original upload date
- Typed Start/End times seek the player and scroll the transcript (Apply / Enter / blur)
- Whisper model dropdown: least → most powerful, with length guidance
- `AGENTS.md` / README: short session bootstrap so new Grok sessions skip re-discovery

### Planned

- Caption edit + burn-in
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
