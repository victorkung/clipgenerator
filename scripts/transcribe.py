#!/usr/bin/env python3
"""Transcribe a local video for search/navigation (approximate timestamps).

Prefer sidecar YouTube captions (.vtt/.srt) when present; otherwise extract
audio and call xAI Speech-to-Text. Writes *.transcript.json and *.transcript.txt
beside the video. Not intended for burn-in caption accuracy — use FCP on clips.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

STT_URL = "https://api.x.ai/v1/stt"
AUDIO_SUFFIX = ".audio.m4a"
JSON_SUFFIX = ".transcript.json"
TXT_SUFFIX = ".transcript.txt"

# Pause (seconds) used to break word timestamps into readable lines
SEGMENT_GAP_S = 0.85
# Soft max words per line when gaps are short
SEGMENT_MAX_WORDS = 16


def die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(code)


def load_dotenv(repo_root: Path) -> None:
    """Load KEY=VAL from repo .env into os.environ if not already set."""
    env_path = repo_root / ".env"
    if not env_path.is_file():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = val


def format_ts(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def parse_ts_to_seconds(ts: str) -> float:
    """Parse SRT/VTT timestamp (HH:MM:SS.mmm or HH:MM:SS,mmm) to seconds."""
    ts = ts.strip().replace(",", ".")
    parts = ts.split(":")
    if len(parts) == 3:
        h, m, s = parts
        return int(h) * 3600 + int(m) * 60 + float(s)
    if len(parts) == 2:
        m, s = parts
        return int(m) * 60 + float(s)
    return float(parts[0])


def strip_vtt_tags(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_srt(content: str) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    blocks = re.split(r"\n\s*\n", content.replace("\r\n", "\n").strip())
    ts_re = re.compile(
        r"(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})"
    )
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip() != ""]
        if not lines:
            continue
        ts_line = None
        text_start = 0
        for i, ln in enumerate(lines):
            if "-->" in ln:
                ts_line = ln
                text_start = i + 1
                break
        if not ts_line:
            continue
        m = ts_re.search(ts_line)
        if not m:
            continue
        text = strip_vtt_tags(" ".join(lines[text_start:]))
        if not text:
            continue
        segments.append(
            {
                "start": parse_ts_to_seconds(m.group(1)),
                "end": parse_ts_to_seconds(m.group(2)),
                "text": text,
            }
        )
    return segments


def parse_vtt(content: str) -> list[dict[str, Any]]:
    # Drop header / NOTE / STYLE blocks; reuse SRT-style cue parsing
    body = content.replace("\r\n", "\n")
    if body.lstrip().startswith("WEBVTT"):
        body = re.sub(r"^WEBVTT[^\n]*\n", "", body.lstrip(), count=1)
    body = re.sub(r"(?m)^(NOTE|STYLE|REGION).*(?:\n(?!\n).*)*\n?", "", body)
    return parse_srt(body)


def find_sidecar_subs(video: Path) -> Path | None:
    """Find yt-dlp-style subtitle sidecars next to the video."""
    stem = video.stem
    parent = video.parent
    candidates: list[Path] = []
    # Exact and common language-tagged names
    for ext in (".vtt", ".srt"):
        candidates.append(parent / f"{stem}{ext}")
        for lang in ("en", "en-US", "en-GB", "eng"):
            candidates.append(parent / f"{stem}.{lang}{ext}")
    # Broader: stem.*.vtt / stem.*.srt (prefer .en* then any)
    globbed = sorted(parent.glob(f"{stem}.*.vtt")) + sorted(
        parent.glob(f"{stem}.*.srt")
    )
    en_first = [p for p in globbed if ".en" in p.name.lower()]
    other = [p for p in globbed if p not in en_first]
    for path in candidates + en_first + other:
        if path.is_file():
            return path
    return None


def segments_from_subs(path: Path) -> list[dict[str, Any]]:
    content = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix.lower() == ".vtt" or content.lstrip().startswith("WEBVTT"):
        return parse_vtt(content)
    return parse_srt(content)


def words_to_segments(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not words:
        return []
    segments: list[dict[str, Any]] = []
    buf: list[dict[str, Any]] = []

    def flush() -> None:
        nonlocal buf
        if not buf:
            return
        text = " ".join(w["text"] for w in buf).strip()
        if text:
            segments.append(
                {
                    "start": float(buf[0]["start"]),
                    "end": float(buf[-1]["end"]),
                    "text": text,
                }
            )
        buf = []

    for w in words:
        if not buf:
            buf = [w]
            continue
        gap = float(w["start"]) - float(buf[-1]["end"])
        if gap >= SEGMENT_GAP_S or len(buf) >= SEGMENT_MAX_WORDS:
            flush()
            buf = [w]
        else:
            buf.append(w)
    flush()
    return segments


def write_outputs(
    video: Path,
    *,
    source: str,
    text: str,
    words: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    extra: dict[str, Any] | None = None,
) -> tuple[Path, Path]:
    payload: dict[str, Any] = {
        "source": source,
        "video": str(video),
        "text": text,
        "words": words,
        "segments": segments,
    }
    if extra:
        payload.update(extra)

    json_path = video.parent / f"{video.stem}{JSON_SUFFIX}"
    txt_path = video.parent / f"{video.stem}{TXT_SUFFIX}"

    json_path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    lines: list[str] = []
    for seg in segments:
        lines.append(f"[{format_ts(float(seg['start']))}] {seg['text']}")
    if not lines and text.strip():
        lines.append(text.strip())
    txt_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    return json_path, txt_path


def extract_audio(video: Path, audio: Path, force: bool) -> None:
    if audio.is_file() and not force:
        video_mtime = video.stat().st_mtime
        if audio.stat().st_mtime >= video_mtime:
            print(f"Reusing existing audio: {audio}")
            return
    print(f"Extracting audio → {audio}")
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(video),
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        str(audio),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except FileNotFoundError:
        die("ffmpeg not found. Install with: brew install ffmpeg")
    except subprocess.CalledProcessError as e:
        err = (e.stderr or b"").decode("utf-8", errors="replace")[-800:]
        die(f"ffmpeg audio extract failed:\n{err}")


def multipart_encode(
    fields: list[tuple[str, str]],
    file_field: str,
    filename: str,
    file_bytes: bytes,
    content_type: str,
) -> tuple[bytes, str]:
    boundary = "----ytxclipper" + os.urandom(8).hex()
    crlf = b"\r\n"
    parts: list[bytes] = []
    for name, value in fields:
        parts.append(f"--{boundary}".encode())
        parts.append(f'Content-Disposition: form-data; name="{name}"'.encode())
        parts.append(b"")
        parts.append(value.encode("utf-8"))
    parts.append(f"--{boundary}".encode())
    parts.append(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"'.encode()
    )
    parts.append(f"Content-Type: {content_type}".encode())
    parts.append(b"")
    parts.append(file_bytes)
    parts.append(f"--{boundary}--".encode())
    parts.append(b"")
    body = crlf.join(parts)
    return body, f"multipart/form-data; boundary={boundary}"


def call_xai_stt(audio: Path, api_key: str, language: str) -> dict[str, Any]:
    print(f"Calling xAI STT ({audio.name}, {audio.stat().st_size // 1024} KiB)…")
    file_bytes = audio.read_bytes()
    fields = [
        ("format", "true"),
        ("language", language),
    ]
    body, content_type = multipart_encode(
        fields, "file", audio.name, file_bytes, "audio/mp4"
    )
    req = urllib.request.Request(
        STT_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": content_type,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:1000]
        die(f"xAI STT HTTP {e.code}: {detail}")
    except urllib.error.URLError as e:
        die(f"xAI STT request failed: {e.reason}")


def from_subs(video: Path, subs: Path) -> tuple[Path, Path]:
    print(f"Using sidecar captions (skipping paid STT): {subs}")
    segments = segments_from_subs(subs)
    if not segments:
        die(f"no caption cues found in {subs}")
    text = " ".join(s["text"] for s in segments)
    return write_outputs(
        video,
        source="youtube-subs",
        text=text,
        words=[],
        segments=segments,
        extra={"subs_file": str(subs)},
    )


def from_stt(video: Path, *, force_audio: bool, language: str, api_key: str) -> tuple[Path, Path]:
    audio = video.parent / f"{video.stem}{AUDIO_SUFFIX}"
    extract_audio(video, audio, force=force_audio)
    result = call_xai_stt(audio, api_key, language)
    words_raw = result.get("words") or []
    words: list[dict[str, Any]] = []
    for w in words_raw:
        words.append(
            {
                "text": w.get("text", ""),
                "start": float(w.get("start", 0)),
                "end": float(w.get("end", 0)),
                **({"speaker": w["speaker"]} if "speaker" in w else {}),
            }
        )
    text = (result.get("text") or "").strip()
    segments = words_to_segments(words)
    if not segments and text:
        segments = [{"start": 0.0, "end": float(result.get("duration") or 0), "text": text}]
    return write_outputs(
        video,
        source="xai-stt",
        text=text,
        words=words,
        segments=segments,
        extra={
            "language": result.get("language"),
            "duration": result.get("duration"),
            "audio_file": str(audio),
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a searchable timestamped transcript from a local video."
    )
    parser.add_argument("video", help="Path to a local video file")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing transcript outputs (and refresh extracted audio)",
    )
    parser.add_argument(
        "--stt",
        action="store_true",
        help="Force xAI STT even if sidecar .vtt/.srt captions exist",
    )
    parser.add_argument(
        "--language",
        default="en",
        help="Language code for STT formatting (default: en)",
    )
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    repo_root = script_dir.parent
    load_dotenv(repo_root)

    video = Path(args.video).expanduser().resolve()
    if not video.is_file():
        die(f"video not found: {video}")

    json_path = video.parent / f"{video.stem}{JSON_SUFFIX}"
    txt_path = video.parent / f"{video.stem}{TXT_SUFFIX}"

    if json_path.is_file() and txt_path.is_file() and not args.force:
        print("Transcript already exists (use --force to regenerate):")
        print(f"  {json_path}")
        print(f"  {txt_path}")
        return

    if not args.stt:
        subs = find_sidecar_subs(video)
        if subs is not None:
            out_json, out_txt = from_subs(video, subs)
            print()
            print("=== Transcript complete (YouTube/sidecar captions) ===")
            print(f"JSON: {out_json}")
            print(f"Text: {out_txt}")
            print("Note: timestamps are approximate — for burn-in, caption the clip in FCP.")
            return

    api_key = os.environ.get("XAI_API_KEY", "").strip()
    if not api_key:
        die(
            "XAI_API_KEY not set. Export it or add it to a .env file in the repo root.\n"
            "  export XAI_API_KEY=...\n"
            "Or download YouTube with --with-subs and re-run to use free captions."
        )

    out_json, out_txt = from_stt(
        video, force_audio=args.force, language=args.language, api_key=api_key
    )
    print()
    print("=== Transcript complete (xAI STT) ===")
    print(f"JSON: {out_json}")
    print(f"Text: {out_txt}")
    print("Note: timestamps are approximate — for burn-in, caption the clip in FCP.")


if __name__ == "__main__":
    main()
