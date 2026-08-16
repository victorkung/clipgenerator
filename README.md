<p align="center">
  <img src="brand/logo-lockup-with-tagline.png" alt="clipgenerator — a local clip desk" width="420" />
</p>

# clipgenerator

A **local clip desk**. Paste a YouTube or X link. The video downloads and transcribes on your Mac. You mark clips against the transcript and export H.264 files.

No account. No cloud speech bill. Nothing leaves the machine.

```text
URL  →  download  →  Whisper (on device)  →  mark clips  →  export
```

<p align="center">
  <img src="docs/images/welcome.png" alt="clipgenerator welcome desk: paste a link, it becomes a transcript you can cut from" width="920" />
</p>

---

## What you get

Three columns, like a cutting room:

1. **Sources + clips** — every video you’ve ingested, and the cuts on the one that’s open.
2. **Paper** — the transcript. Click a line to seek. The highlighted wash is the clip you’re marking.
3. **Craft** — the full-source player, start/end times, caption plate, export.

Captions are optional. You still scrub the **source** video; caption times are relative to the clip start. Export burns plates when cues exist and always writes an `.srt`.

<p align="center">
  <img src="docs/images/editor.png" alt="Editor: transcript in the center, source video and clip controls on the right" width="920" />
</p>

<p align="center">
  <img src="docs/images/captions.png" alt="Captions tab with clip-relative cues" width="920" />
</p>

This public repo is the **editor**. It does not draft posts or publish to social networks.

---

## Run it

**Need:** macOS on Apple Silicon, [Homebrew](https://brew.sh), then:

```bash
brew install yt-dlp ffmpeg python node
```

```bash
git clone https://github.com/victorkung/clipgenerator.git
cd clipgenerator

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cd app/frontend && npm install && cd ../..
cp .env.example .env

./scripts/dev.sh
```

Open **http://127.0.0.1:5173**. The API is **http://127.0.0.1:8787**.

The first transcribe downloads the Whisper model (a few minutes). Later runs use the cache.

| Model | When to pick it |
|-------|-----------------|
| **small** (default) | Faster. Fine for most shows. |
| **medium** | Clearer names and jargon. About 2× slower. |

---

## Cut a clip

1. Paste a YouTube **watch** URL or an X **status** URL (not the homepage) → **Add source**.
2. Wait until the source is **ready**. Check the duration — some X posts are 30-second promos, not the full show.
3. Play. Click a transcript line to jump.
4. **I** sets start at the playhead, **O** sets end. Or type times and press Enter / **Apply**.
5. **Add clip** if you want another cut on the same source.
6. Optional: **Generate captions**, edit text on the Captions tab, set the plate style in craft.
7. **Export** — files land in `videos/YYYY-MM-DD ShowName/clips/`. **Open in Finder** to see them.

Wrong URL? **Remove** the source in the rail. That cancels download / Whisper / export. Files on disk stay.

| Key / control | What it does |
|---------------|----------------|
| **I** | Start at playhead |
| **O** | End at playhead |
| Start / End fields | Type a time, Enter or Apply |
| Click a transcript line | Seek the player |
| **Add clip** | Another cut on this source |

Do not run the API with `RELOAD=1` during a long download or transcribe.

---

## Layout on disk

```text
videos/YYYY-MM-DD ShowName/
  source.mp4
  source.transcript.json
  clips/
    01-…/video.mp4
    01-…/captions.srt
```

The date is the day you ingested (today), not the original publish date. The library file is local `data/library.json` (not committed).

---

## License

MIT. See [LICENSE](LICENSE).
