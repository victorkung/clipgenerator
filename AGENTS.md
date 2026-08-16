# Agent instructions (public editor)

This repo is the **public editor** (`victorkung/clipgenerator`): download → Whisper → editor → export. No in-app LLM, Typefully, or X publish. Frozen artifact.

The human does not run git commits. Only commit when they ask.

Never commit `.env`, `videos/`, `data/`, `.venv/`, or live API keys.

## First clone

1. `yt-dlp` and `ffmpeg` (`brew install yt-dlp ffmpeg`). Apple Silicon for MLX Whisper.
2. `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
3. `cd app/frontend && npm install`
4. `cp .env.example .env` if missing
5. `./scripts/dev.sh` → UI :5173, API :8787

Paste a **watch / status** URL. **Remove** in the sources rail cancels that source’s work.

UI styles: `app/frontend/DESIGN.md`. API/ingest/export: `app/backend/main.py`.
