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

# Long continuous MLX Whisper decode can wedge mid-file (reproduced: rasmr ~1h39m always
# froze at ~75% / 4460s while the same audio in 8–10 min chunks ran at ~30×). Chunk long
# audio into separate transcribe() calls so model/GPU state resets.
# Override with WHISPER_CHUNK_S / WHISPER_CHUNK_MIN_S (seconds). Set CHUNK_MIN very high to disable.
_CHUNK_S = float(os.environ.get("WHISPER_CHUNK_S", "600") or "600")  # 10 min
_CHUNK_MIN_S = float(os.environ.get("WHISPER_CHUNK_MIN_S", "900") or "900")  # only if ≥15 min


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


def extract_audio(video: Path, audio: Path, force: bool) -> dict[str, Any]:
    """Extract AAC sidecar. Returns timing meta for pipeline analytics."""
    import time

    t0 = time.perf_counter()
    reused = False
    if audio.is_file() and not force:
        video_mtime = video.stat().st_mtime
        if audio.stat().st_mtime >= video_mtime:
            print(f"Reusing existing audio: {audio}")
            reused = True
            return {
                "extract_s": round(time.perf_counter() - t0, 3),
                "audio_reused": True,
            }
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
    return {
        "extract_s": round(time.perf_counter() - t0, 3),
        "audio_reused": reused,
    }


def _emit_progress(payload: dict[str, Any]) -> None:
    """One clean stdout line for the API parent (never mixed with tqdm \\r bars)."""
    print(f"PROGRESS_JSON:{json.dumps(payload, separators=(',', ':'))}", flush=True)


def _audio_duration_s(path: Path) -> float | None:
    try:
        out = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                str(path),
            ],
            text=True,
        ).strip()
        return float(out) if out else None
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError):
        return None


def _install_stt_progress_reporter(
    *,
    pos_offset_s: float = 0.0,
    total_s: float | None = None,
    wall_t0: float | None = None,
    chunk_i: int | None = None,
    chunks: int | None = None,
) -> None:
    """
    Patch tqdm so mlx_whisper emits machine-readable progress while decoding.

    mlx_whisper uses tqdm when verbose=False (frame bar over mel frames).
    100 mel frames = 1 second of audio (SAMPLE_RATE/HOP_LENGTH).

    Important: tqdm rewrites the same line with \\r (no newline), so the API parent
    never sees updates if we only print on that stream. We silence the bar to
    /dev/null and emit PROGRESS_JSON on its own flushed newline instead.

    pos_offset_s / total_s map chunk-local frames onto the full-job timeline.
    """
    import time

    import tqdm as tqdm_mod

    t0 = wall_t0 if wall_t0 is not None else time.perf_counter()
    last_emit = [0.0]
    # Min interval between JSON lines (tqdm itself may tick faster)
    interval = float(os.environ.get("WHISPER_PROGRESS_INTERVAL_S", "1.0") or "1.0")
    devnull = open(os.devnull, "w")  # noqa: SIM115 — lives for process lifetime

    class _ProgressTqdm(tqdm_mod.tqdm):  # type: ignore[misc, name-defined]
        def __init__(self, *args: Any, **kwargs: Any) -> None:  # type: ignore[no-untyped-def]
            # Hide the bar; we report via PROGRESS_JSON only
            kwargs["file"] = devnull
            kwargs["disable"] = False
            kwargs.setdefault("mininterval", interval)
            super().__init__(*args, **kwargs)

        def update(self, n: float = 1) -> bool | None:  # type: ignore[override]
            result = super().update(n)
            now = time.perf_counter()
            total = float(self.total or 0)
            cur = float(self.n or 0)
            # Always emit on completion; otherwise throttle
            done = total > 0 and cur >= total
            if not done and (now - last_emit[0]) < interval:
                return result
            last_emit[0] = now
            # mel frames → audio seconds (chunk-local), then map onto full job
            local_pos = cur / 100.0
            audio_pos_s = float(pos_offset_s) + local_pos
            if total_s is not None and total_s > 0:
                audio_total_s = float(total_s)
            elif total > 0:
                audio_total_s = float(pos_offset_s) + (total / 100.0)
            else:
                audio_total_s = None
            wall_s = now - t0
            if audio_total_s and audio_total_s > 0:
                pct = 100.0 * audio_pos_s / audio_total_s
            elif total > 0:
                pct = 100.0 * cur / total
            else:
                pct = None
            rtf = (audio_pos_s / wall_s) if wall_s >= 0.5 and audio_pos_s > 0 else None
            payload: dict[str, Any] = {
                "phase": "decode",
                "audio_pos_s": round(audio_pos_s, 2),
                "audio_total_s": round(audio_total_s, 2)
                if audio_total_s is not None
                else None,
                "percent": round(pct, 2) if pct is not None else None,
                "wall_s": round(wall_s, 2),
                "rtf": round(rtf, 2) if rtf is not None else None,
                "frames": int(cur),
                "frames_total": int(total) if total > 0 else None,
            }
            if chunk_i is not None:
                payload["chunk"] = chunk_i
            if chunks is not None:
                payload["chunks"] = chunks
            _emit_progress(payload)
            return result

    tqdm_mod.tqdm = _ProgressTqdm  # type: ignore[misc, assignment]


def call_mlx_whisper(
    audio: Path,
    *,
    model: str,
    language: str | None,
    progress_offset_s: float = 0.0,
    progress_total_s: float | None = None,
    wall_t0: float | None = None,
    chunk_i: int | None = None,
    chunks: int | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run MLX Whisper. Returns (result, timing_meta)."""
    import time

    # Patch tqdm *before* mlx_whisper decode loop uses it
    _install_stt_progress_reporter(
        pos_offset_s=progress_offset_s,
        total_s=progress_total_s,
        wall_t0=wall_t0,
        chunk_i=chunk_i,
        chunks=chunks,
    )

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
        f" (word_timestamps={word_ts}"
        + (f", chunk {chunk_i}/{chunks}" if chunk_i and chunks else "")
        + ")…",
        flush=True,
    )
    _emit_progress(
        {
            "phase": "load_model",
            "model": model,
            "audio": audio.name,
            "chunk": chunk_i,
            "chunks": chunks,
            "audio_pos_s": progress_offset_s,
            "audio_total_s": progress_total_s,
            "percent": (
                round(100.0 * progress_offset_s / progress_total_s, 2)
                if progress_total_s and progress_total_s > 0
                else None
            ),
        }
    )
    kwargs: dict[str, Any] = {
        "path_or_hf_repo": repo,
        "word_timestamps": word_ts,
        # verbose=False enables tqdm progress (we patch it → PROGRESS_JSON)
        "verbose": False,
        # Single greedy pass is much faster than temperature fallbacks on clean podcast audio
        "temperature": 0.0,
        "condition_on_previous_text": False,
    }
    if language:
        kwargs["language"] = language

    t0 = time.perf_counter()
    try:
        result = mlx_whisper.transcribe(str(audio), **kwargs)
    except Exception as e:
        die(f"MLX Whisper failed: {e}")
    whisper_s = round(time.perf_counter() - t0, 3)

    if not isinstance(result, dict):
        result = {"text": str(result), "segments": []}
    meta = {
        "whisper_s": whisper_s,
        "model": model,
        "model_repo": repo,
        "word_timestamps": word_ts,
    }
    return result, meta


def _cut_audio_chunk(src: Path, dest: Path, start_s: float, dur_s: float) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        f"{start_s:.3f}",
        "-t",
        f"{dur_s:.3f}",
        "-i",
        str(src),
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        str(dest),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except FileNotFoundError:
        die("ffmpeg not found. Install with: brew install ffmpeg")
    except subprocess.CalledProcessError as e:
        err = (e.stderr or b"").decode("utf-8", errors="replace")[-800:]
        die(f"ffmpeg chunk cut failed at {start_s:.1f}s:\n{err}")


def _maybe_clear_mlx_cache() -> None:
    """Best-effort free Metal temps between chunks (hangs often correlate with long runs)."""
    try:
        import mlx.core as mx  # type: ignore

        if hasattr(mx, "clear_cache"):
            mx.clear_cache()
        elif hasattr(mx, "metal") and hasattr(mx.metal, "clear_cache"):
            mx.metal.clear_cache()
    except Exception:
        pass


def call_mlx_whisper_chunked(
    audio: Path,
    *,
    model: str,
    language: str | None,
    duration_s: float,
    chunk_s: float = _CHUNK_S,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    Transcribe long audio as sequential short files and merge timestamps.

    Each chunk is a fresh mlx_whisper.transcribe() so decode state / GPU memory
    from the first hour cannot wedge the last 25% (reproduced on multi-hour lives).
    """
    import math
    import time

    wall_t0 = time.perf_counter()
    chunk_s = max(60.0, float(chunk_s))
    n = max(1, int(math.ceil(duration_s / chunk_s)))
    print(
        f"Chunked STT: {duration_s:.0f}s audio → {n}×{chunk_s:.0f}s chunks "
        f"(avoids long continuous MLX hang)",
        flush=True,
    )
    _emit_progress(
        {
            "phase": "decode",
            "audio_pos_s": 0.0,
            "audio_total_s": duration_s,
            "percent": 0.0,
            "wall_s": 0.0,
            "chunks": n,
            "chunk": 0,
        }
    )

    all_segments: list[dict[str, Any]] = []
    text_parts: list[str] = []
    language_out: str | None = language
    whisper_total = 0.0
    repo = resolve_model_repo(model)

    for i in range(n):
        start = i * chunk_s
        if start >= duration_s - 0.05:
            break
        dur = min(chunk_s, duration_s - start)
        chunk_path = audio.parent / f".{audio.stem}.chunk{i:03d}.m4a"
        try:
            print(
                f"  chunk {i + 1}/{n}: {start:.0f}s–{start + dur:.0f}s",
                flush=True,
            )
            _cut_audio_chunk(audio, chunk_path, start, dur)
            result, meta = call_mlx_whisper(
                chunk_path,
                model=model,
                language=language,
                progress_offset_s=start,
                progress_total_s=duration_s,
                wall_t0=wall_t0,
                chunk_i=i + 1,
                chunks=n,
            )
            whisper_total += float(meta.get("whisper_s") or 0.0)
            if result.get("language"):
                language_out = str(result["language"])
            text_parts.append((result.get("text") or "").strip())
            for seg in result.get("segments") or []:
                seg_out: dict[str, Any] = {
                    "start": float(seg.get("start", 0.0)) + start,
                    "end": float(seg.get("end", 0.0)) + start,
                    "text": (seg.get("text") or "").strip(),
                }
                # Offset word timestamps if present
                words_in = seg.get("words") or []
                if words_in:
                    seg_out["words"] = [
                        {
                            **w,
                            "start": float(w.get("start", 0.0)) + start,
                            "end": float(w.get("end", 0.0)) + start,
                        }
                        for w in words_in
                        if isinstance(w, dict)
                    ]
                all_segments.append(seg_out)
            # End-of-chunk progress tick (tqdm may not emit 100% on tiny tails)
            wall_s = time.perf_counter() - wall_t0
            end_pos = start + dur
            _emit_progress(
                {
                    "phase": "decode",
                    "audio_pos_s": round(end_pos, 2),
                    "audio_total_s": round(duration_s, 2),
                    "percent": round(100.0 * end_pos / duration_s, 2),
                    "wall_s": round(wall_s, 2),
                    "rtf": round(end_pos / wall_s, 2) if wall_s >= 0.5 else None,
                    "chunk": i + 1,
                    "chunks": n,
                }
            )
        finally:
            try:
                chunk_path.unlink(missing_ok=True)
            except OSError:
                pass
            _maybe_clear_mlx_cache()

    merged = {
        "text": " ".join(t for t in text_parts if t).strip(),
        "segments": all_segments,
        "language": language_out,
    }
    meta = {
        "whisper_s": round(whisper_total, 3),
        "model": model,
        "model_repo": repo,
        "word_timestamps": os.environ.get("WHISPER_WORD_TIMESTAMPS", "").strip()
        in ("1", "true", "yes"),
        "chunked": True,
        "chunk_s": chunk_s,
        "chunks": n,
    }
    return merged, meta


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
) -> tuple[Path, Path, dict[str, Any]]:
    import time

    t_all = time.perf_counter()
    audio = video.parent / f"{video.stem}{AUDIO_SUFFIX}"
    _emit_progress({"phase": "extract", "audio": audio.name})
    extract_meta = extract_audio(video, audio, force=force_audio)
    _emit_progress(
        {
            "phase": "extract_done",
            "extract_s": extract_meta.get("extract_s"),
            "audio_reused": extract_meta.get("audio_reused"),
        }
    )

    duration_s = _audio_duration_s(audio)
    use_chunks = (
        duration_s is not None
        and duration_s >= _CHUNK_MIN_S
        and _CHUNK_S > 0
        and _CHUNK_MIN_S > 0
    )
    if use_chunks:
        assert duration_s is not None
        result, whisper_meta = call_mlx_whisper_chunked(
            audio,
            model=model,
            language=language,
            duration_s=duration_s,
            chunk_s=_CHUNK_S,
        )
    else:
        result, whisper_meta = call_mlx_whisper(audio, model=model, language=language)

    text, words, segments = normalize_whisper_result(result)
    out_json, out_txt = write_outputs(
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
            "chunked": bool(whisper_meta.get("chunked")),
            "chunk_s": whisper_meta.get("chunk_s"),
            "chunks": whisper_meta.get("chunks"),
        },
    )
    timing: dict[str, Any] = {
        "source": "mlx-whisper",
        "extract_s": extract_meta.get("extract_s"),
        "audio_reused": extract_meta.get("audio_reused"),
        "whisper_s": whisper_meta.get("whisper_s"),
        "total_s": round(time.perf_counter() - t_all, 3),
        "model": model,
        "model_repo": whisper_meta.get("model_repo"),
        "word_timestamps": whisper_meta.get("word_timestamps"),
        "segments": len(segments),
        "chunked": bool(whisper_meta.get("chunked")),
        "chunk_s": whisper_meta.get("chunk_s"),
        "chunks": whisper_meta.get("chunks"),
        "audio_duration_s": duration_s,
    }
    # Machine-readable line for the API parent process (pipeline analytics).
    print(f"TIMING_JSON:{json.dumps(timing, separators=(',', ':'))}", flush=True)
    return out_json, out_txt, timing


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
            import time

            t0 = time.perf_counter()
            out_json, out_txt = from_subs(video, subs)
            timing = {
                "source": "youtube-subs",
                "extract_s": 0.0,
                "whisper_s": 0.0,
                "total_s": round(time.perf_counter() - t0, 3),
                "model": None,
            }
            print(f"TIMING_JSON:{json.dumps(timing, separators=(',', ':'))}", flush=True)
            print()
            print("=== Transcript complete (YouTube/sidecar captions) ===")
            print(f"JSON: {out_json}")
            print(f"Text: {out_txt}")
            print("Note: timestamps are approximate — for burn-in, caption the clip later.")
            return

    lang = args.language.strip() or None
    out_json, out_txt, timing = from_whisper(
        video, force_audio=args.force, model=args.model, language=lang
    )
    print()
    print(f"=== Transcript complete (MLX Whisper / {args.model}) ===")
    print(f"JSON: {out_json}")
    print(f"Text: {out_txt}")
    if timing.get("whisper_s") is not None:
        print(
            f"Timing: extract {timing.get('extract_s')}s · "
            f"whisper {timing.get('whisper_s')}s · total {timing.get('total_s')}s"
        )
    print("Note: timestamps are approximate — for burn-in, caption the clip later.")

if __name__ == "__main__":
    main()
