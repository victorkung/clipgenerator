#!/usr/bin/env python3
"""Transcribe a local video for search/navigation (approximate timestamps).

Prefer sidecar YouTube captions (.vtt/.srt) when present; otherwise extract
audio and run local MLX Whisper. Writes *.transcript.json and *.transcript.txt
beside the video. Not intended for burn-in caption accuracy — use FCP or the
clipgenerator caption release on clips.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

AUDIO_SUFFIX = ".audio.m4a"
JSON_SUFFIX = ".transcript.json"
TXT_SUFFIX = ".transcript.txt"

# Pause (seconds) used to break word timestamps into readable lines
SEGMENT_GAP_S = 0.85
SEGMENT_MAX_WORDS = 16

# Friendly name → Hugging Face MLX repo
MODEL_REPOS: dict[str, str] = {
    "tiny": "mlx-community/whisper-tiny",
    "tiny.en": "mlx-community/whisper-tiny.en-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "base.en": "mlx-community/whisper-base.en-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "small.en": "mlx-community/whisper-small.en-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "medium.en": "mlx-community/whisper-medium.en-mlx",
    "turbo": "mlx-community/whisper-large-v3-turbo",
    "large": "mlx-community/whisper-large-v3-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "distil-large-v3": "mlx-community/distil-whisper-large-v3",
}

# Fast default for long pods (segment timestamps only — good enough for clip finding).
# medium + word_timestamps was ~10+ min on a 1.5h show; small ~sub-5 goal on M-series.
DEFAULT_MODEL = "small"


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


def resolve_model_repo(model: str) -> str:
    m = model.strip()
    if m in MODEL_REPOS:
        return MODEL_REPOS[m]
    # Allow full HF repo or local path
    return m


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
    body = content.replace("\r\n", "\n")
    if body.lstrip().startswith("WEBVTT"):
        body = re.sub(r"^WEBVTT[^\n]*\n", "", body.lstrip(), count=1)
    body = re.sub(r"(?m)^(NOTE|STYLE|REGION).*(?:\n(?!\n).*)*\n?", "", body)
    return parse_srt(body)


def find_sidecar_subs(video: Path) -> Path | None:
    stem = video.stem
    parent = video.parent
    candidates: list[Path] = []
    for ext in (".vtt", ".srt"):
        candidates.append(parent / f"{stem}{ext}")
        for lang in ("en", "en-US", "en-GB", "eng"):
            candidates.append(parent / f"{stem}.{lang}{ext}")
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


def call_mlx_whisper(
    audio: Path,
    *,
    model: str,
    language: str | None,
) -> dict[str, Any]:
    try:
        import mlx_whisper  # type: ignore
    except ImportError:
        die(
            "mlx-whisper is not installed. From the repo root:\n"
            "  python3 -m venv .venv && source .venv/bin/activate\n"
            "  pip install -r requirements.txt"
        )

    repo = resolve_model_repo(model)
    # Optional cache dir (external SSD, etc.)
    cache = os.environ.get("MODEL_DIR") or os.environ.get("HF_HOME")
    if cache:
        os.environ.setdefault("HF_HOME", cache)
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(Path(cache) / "hub"))

    # word_timestamps=True is much slower and not required for clip navigation
    # (segment start/end is enough). Opt in with WHISPER_WORD_TIMESTAMPS=1.
    word_ts = os.environ.get("WHISPER_WORD_TIMESTAMPS", "").strip() in ("1", "true", "yes")
    print(
        f"Running MLX Whisper model={model!r} repo={repo} on {audio.name}"
        f" (word_timestamps={word_ts})…"
    )
    kwargs: dict[str, Any] = {
        "path_or_hf_repo": repo,
        "word_timestamps": word_ts,
        "verbose": False,
        # Single greedy pass is much faster than temperature fallbacks on clean podcast audio
        "temperature": 0.0,
        "condition_on_previous_text": False,
    }
    if language:
        kwargs["language"] = language

    try:
        result = mlx_whisper.transcribe(str(audio), **kwargs)
    except Exception as e:
        die(f"MLX Whisper failed: {e}")

    return result if isinstance(result, dict) else {"text": str(result), "segments": []}


def normalize_whisper_result(result: dict[str, Any]) -> tuple[str, list[dict], list[dict]]:
    text = (result.get("text") or "").strip()
    words: list[dict[str, Any]] = []
    segments_out: list[dict[str, Any]] = []

    for seg in result.get("segments") or []:
        seg_words = seg.get("words") or []
        if seg_words:
            for w in seg_words:
                wtext = (w.get("word") or w.get("text") or "").strip()
                if not wtext:
                    continue
                words.append(
                    {
                        "text": wtext,
                        "start": float(w.get("start", seg.get("start", 0))),
                        "end": float(w.get("end", seg.get("end", 0))),
                    }
                )
        segments_out.append(
            {
                "start": float(seg.get("start", 0)),
                "end": float(seg.get("end", 0)),
                "text": (seg.get("text") or "").strip(),
            }
        )

    if not segments_out and words:
        segments_out = words_to_segments(words)
    if not segments_out and text:
        segments_out = [{"start": 0.0, "end": 0.0, "text": text}]

    return text, words, segments_out


def from_subs(video: Path, subs: Path) -> tuple[Path, Path]:
    print(f"Using sidecar captions (skipping local STT): {subs}")
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


def from_whisper(
    video: Path,
    *,
    force_audio: bool,
    model: str,
    language: str | None,
) -> tuple[Path, Path]:
    audio = video.parent / f"{video.stem}{AUDIO_SUFFIX}"
    extract_audio(video, audio, force=force_audio)
    result = call_mlx_whisper(audio, model=model, language=language)
    text, words, segments = normalize_whisper_result(result)
    return write_outputs(
        video,
        source="mlx-whisper",
        text=text,
        words=words,
        segments=segments,
        extra={
            "model": model,
            "model_repo": resolve_model_repo(model),
            "language": language or result.get("language"),
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
        help="Force local Whisper even if sidecar .vtt/.srt captions exist",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("WHISPER_MODEL", DEFAULT_MODEL),
        help=f"Whisper model size or HF repo (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--language",
        default="en",
        help="Language code for Whisper (default: en). Use '' to auto-detect.",
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
            print("Note: timestamps are approximate — for burn-in, caption the clip later.")
            return

    lang = args.language.strip() or None
    out_json, out_txt = from_whisper(
        video, force_audio=args.force, model=args.model, language=lang
    )
    print()
    print(f"=== Transcript complete (MLX Whisper / {args.model}) ===")
    print(f"JSON: {out_json}")
    print(f"Text: {out_txt}")
    print("Note: timestamps are approximate — for burn-in, caption the clip later.")


if __name__ == "__main__":
    main()
