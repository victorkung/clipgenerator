<p align="center">
  <img src="brand/logo-lockup-with-tagline.png" alt="clipgenerator — a local clip desk" width="420" />
</p>

# clipgenerator

**Local multi-clip studio** for long YouTube and X videos: download → on-device transcription → mark in/out against a live transcript → export clean H.264+AAC clips (optional SRT captions).

This public repo is the **editor only** — no in-app LLM agents and no social publish.

No cloud speech bill. No accounts. Runs on **your machine** (Apple Silicon recommended for MLX Whisper).

```text
URL → yt-dlp download → MLX Whisper STT → multi-clip editor → export clips/
```

| | |
|--|--|
| **UI** | http://127.0.0.1:5173 (Vite) |
| **API** | http://127.0.0.1:8787 (FastAPI) |

---

## Screenshots

### Welcome desk

![Welcome screen with sources rail and onboarding paper](docs/images/welcome.png)

### Editor — transcript + clip craft

![Three-column editor with transcript, video, and clip controls](docs/images/editor.png)

### Captions

![Captions tab with clip-relative cues](docs/images/captions.png)

---

## Workflow

1. **Ingest** a YouTube or X URL (download + local Whisper). Use a **watch / status** URL, not the site homepage.
2. **Play** the source; click transcript lines to seek.
3. **Mark** start/end with **I** / **O**, typed times, or Set start / Set end.
4. Optionally **Generate captions** → edit text on the Captions tab; style the **Caption plate** in craft.
5. **Export clip** → `videos/…/clips/` with burned-in plates when cues exist, plus `.srt`.

| Action | How |
|--------|-----|
| Set start | Playhead → **Set start**, key **I** |
| Set end | Playhead → **Set end**, key **O** |
| Type times | Start/End fields → Enter or **Apply** |
| Seek from transcript | Click a line |
| Captions | **Generate captions** → Captions tab |
| New clip on same source | **Add clip** |
| Open exports | **Open in Finder** |

**Caption note:** You scrub the **source** video. Caption times are **relative to the clip start**. If you change in/out, regenerate captions.

---

## Prerequisites

| Tool | Why | Install (macOS) |
|------|-----|-----------------|
| **macOS + Apple Silicon** | MLX Whisper is optimized for M-series | — |
| **Homebrew** | Installs CLI tools | [brew.sh](https://brew.sh) |
| **yt-dlp** | Download YouTube / X | `brew install yt-dlp` |
| **ffmpeg** | Normalize + export H.264/AAC | `brew install ffmpeg` |
| **Python 3.10+** | API + Whisper | system or `brew install python` |
| **Node.js 18+** | Vite UI | `brew install node` |

---

## Install

```bash
git clone https://github.com/victorkung/Clipgenerator-Public.git
cd Clipgenerator-Public

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cd app/frontend && npm install && cd ../..
cp .env.example .env
```

Speech-to-text is on-device via `mlx-whisper`. The first run downloads model weights from Hugging Face.

**UI / API models:** `small` (default, faster) or `medium` (clearer names, ~2× slower).

```bash
./scripts/dev.sh
# UI  http://127.0.0.1:5173
# API http://127.0.0.1:8787
```

Do not use `RELOAD=1` while long downloads/STT are running.

---

## Folder layout

`videos/YYYY-MM-DD ShowName/` — date is **ingest day (today)**, not the original publish date. Library is gitignored `data/library.json`.

---

## Never commit

`.env`, `videos/`, `data/`, `.venv/`, transcripts, audio sidecars.

---

## License

MIT. See [LICENSE](LICENSE).
