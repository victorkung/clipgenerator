# yt-x-vid-downloader-transcriber

Local CLI to **download YouTube or X (Twitter) videos** and **generate searchable, timestamped transcripts**.

Typical use case: grab a video you want offline, then skim a transcript with approximate `[m:ss]` timestamps to find moments worth clipping.

Downloads are saved as **H.264 + AAC MP4** (X-upload compatible). Transcription prefers free sidecar captions when available; otherwise it uses **xAI Speech-to-Text** with **your own API key**.

## Important notes

### Your own API key (required for STT)

This project does **not** ship or share an API key. For paid transcription you must use **your own** [xAI API key](https://console.x.ai/):

```bash
export XAI_API_KEY="…"
# or copy .env.example → .env and set XAI_API_KEY there (never commit .env)
```

YouTube downloads can often skip STT entirely if you pull captions:

```bash
./scripts/download.sh --with-subs "https://www.youtube.com/watch?v=VIDEO_ID"
./scripts/transcribe.sh "videos/….mp4"
```

X posts usually have no captions, so STT (and a key) is expected.

### Legal / responsible use

- You are responsible for complying with **YouTube**, **X**, and **copyright** rules for any URL you download.
- Prefer content you own, are licensed to use, or that the platform allows you to save for personal use.
- Do not use this tool to redistribute copyrighted material or bypass access controls.
- Keep `.env` and everything under `videos/` private — they are gitignored on purpose.

### What this is (and isn’t)

| This repo | Not this repo |
|-----------|----------------|
| Local scripts on your machine | A hosted web app or public download API |
| BYO `XAI_API_KEY` for STT | Shared/server keys |
| Approximate timestamps for navigation | Frame-accurate burn-in captions (use FCP on clips) |

## Prerequisites

```bash
brew install yt-dlp ffmpeg
```

Also needs `python3` (macOS includes it).

Verify:

```bash
yt-dlp --version
ffmpeg -version | head -1
python3 --version
```

## Quick start

### 1) Clone and (optional) set API key

```bash
git clone https://github.com/victorkung/yt-x-vid-downloader-transcriber.git
cd yt-x-vid-downloader-transcriber
cp .env.example .env   # then edit: XAI_API_KEY=…
```

### 2) Download

```bash
./scripts/download.sh "https://www.youtube.com/watch?v=VIDEO_ID"
./scripts/download.sh "https://x.com/user/status/STATUS_ID"
```

Files land in `videos/`. Before the transfer, the script prints **title + duration** (and a size warning if the video is long). During the transfer you get **line-by-line progress** (`%`, speed, ETA). When finished it prints path, resolution, codec, and size. If height is under 1080p, it prints a **WARNING** (common for X) but still saves the best available stream.

**Note:** An X post URL can still attach a **full podcast/episode file** (e.g. ~1 hour / multi‑GB at 1080p), not just a short clip. Duration in the pre-download banner is the source of truth for how long the wait will be.

**Every download is forced to H.264 + AAC** before the script finishes (re-encode if YouTube only offered AV1/VP9).

**Speed notes (especially X / HLS):**

- Config uses **8 concurrent fragments** (`-N 8` in `config/yt-dlp.conf`). yt-dlp’s default is `1`, which serializes HLS and makes long X videos feel stuck. Override per run if needed: `./scripts/download.sh -N 16 "URL"`.
- We prefer **H.264 HLS** over fat progressive HTTP when both exist (same 1080p can be ~1.3 GB HLS vs ~4.5 GB progressive on X).
- Re-encode is skipped when the file is already H.264+AAC; otherwise macOS uses **VideoToolbox** hardware encode.
- Optional: install `aria2c` (`brew install aria2`) and pass `--downloader aria2c` for some non-HLS sources — native `-N` is usually enough for X.
- If you only need a rough offline copy for clipping, a lower ceiling is much faster, e.g.  
  `./scripts/download.sh -f "bv*[height<=720]+ba/b" "URL"`.

### 3) Transcribe

```bash
./scripts/transcribe.sh "videos/Uploader - Title [id].mp4"
```

Writes next to the video:

| File | Purpose |
|------|---------|
| `<stem>.transcript.txt` | Skim with `[m:ss]` lines — find clip-worthy moments |
| `<stem>.transcript.json` | Full payload (words/segments) for tooling |

**Cost-aware path:**

1. Prefer free captions when present (sidecar `.vtt` / `.srt`).
2. Otherwise extract audio and call **xAI STT** (see [xAI pricing](https://docs.x.ai/); cost scales with audio duration).

Timestamps are **approximate** — good for finding moments, not for burn-in. For on-screen captions on a finished short, use **FCP auto-captions on the clipped audio**.

## Quality policy (download)

| Setting | Behavior |
|---------|----------|
| Default | Prefer **H.264 ≥ 1080**, remux to **mp4**, then **always ensure H.264 + AAC** |
| Fallback | If nothing ≥1080 exists, download best available, still force H.264 + AAC |
| Strict | `./scripts/download.sh --strict-1080 "URL"` fails if no ≥1080 format exists |

yt-dlp **does not upscale**. Quality is limited by what the source hosts.

### X upload compatibility (always applied)

X rejects **AV1** / **VP9** with *“Incompatible video codecs”*. Final files always use:

- **Container:** MP4  
- **Video:** H.264 (`avc1`), yuv420p  
- **Audio:** AAC  

Pipeline:

1. `yt-dlp` prefers native H.264 streams when available (faster, no re-encode).  
2. `scripts/to-h264.sh` runs on every download and re-encodes only if needed.  

Manual conversion (clips you cut yourself, or old files):

```bash
./scripts/to-h264.sh "videos/your-clip.mp4"              # in-place
./scripts/to-h264.sh "videos/in.mp4" "videos/out.mp4"    # to new path
```

### What to expect

- **YouTube:** Most modern videos offer **1080p or higher**. Output is always H.264 for X.
- **X downloads:** Often **720p or lower**. Vertical clips are common (e.g. 1080×1920). Still forced to H.264.

Defaults live in `config/yt-dlp.conf`.

## Options

### download.sh

```bash
./scripts/download.sh "URL"
./scripts/download.sh --strict-1080 "URL"
./scripts/download.sh --with-subs "URL"          # English .vtt sidecars (YouTube)
./scripts/download.sh --cookies-from-browser chrome "URL"
yt-dlp -F "URL"                                 # list formats
./scripts/download.sh -f "bv*[height=1080]+ba" "URL"
```

### transcribe.sh

```bash
./scripts/transcribe.sh "videos/file.mp4"
./scripts/transcribe.sh --force "videos/file.mp4"   # regenerate
./scripts/transcribe.sh --stt "videos/file.mp4"     # ignore sidecar subs; use xAI
./scripts/transcribe.sh --language en "videos/file.mp4"
```

## Layout

```
.
├── README.md
├── .env.example         # template for XAI_API_KEY (copy to .env)
├── .env                 # your key — local only, gitignored
├── config/
│   └── yt-dlp.conf
├── scripts/
│   ├── download.sh      # URL → X-ready mp4
│   ├── to-h264.sh       # ensure H.264 + AAC
│   ├── transcribe.sh    # CLI entry for transcription
│   └── transcribe.py    # audio extract / captions / xAI STT
└── videos/              # downloads + transcript sidecars (gitignored)
```

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| Download fails / 403 / “sign in” | `brew upgrade yt-dlp`, then retry with `--cookies-from-browser chrome` (or `safari` / `firefox`) |
| Under-1080 warning | Source has no higher encode (typical on X). Use `--strict-1080` only if you want to abort |
| Want exact 1080, not 4K | Pass e.g. `-f "bv*[height=1080]+ba/b[height=1080]"` |
| `XAI_API_KEY not set` | Export the key, or add it to `.env`. Or use `./scripts/download.sh --with-subs` on YouTube then re-run transcribe |
| No sidecar captions on X | Expected — X rarely has subs; transcribe will use xAI STT |
| Transcript already exists | Pass `--force` to regenerate |
| Path issues | Scripts resolve the repo root themselves; paths to videos can be relative or absolute |

## Maintenance

```bash
brew upgrade yt-dlp ffmpeg
```

YouTube and X change their APIs periodically; keeping yt-dlp current fixes most breakage.
