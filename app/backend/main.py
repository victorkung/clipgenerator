"""clipgenerator local API — localhost only."""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# Repo root: app/backend/main.py → parents[2]
ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
VIDEOS = ROOT / "videos"
DATA = ROOT / "data"
LIBRARY_PATH = DATA / "library.json"
DOWNLOAD_SH = SCRIPTS / "download.sh"
TRANSCRIBE_PY = SCRIPTS / "transcribe.py"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from agent_io import format_ts_label  # noqa: E402
from captions import (  # noqa: E402
    build_overlay_timeline,
    cues_to_srt,
    normalize_caption_style,
    normalize_cues,
    render_caption_plate_image,
    slice_transcript_to_clip,
)
from naming import clean_title, make_project_dir  # noqa: E402
from store import Library, make_clip, make_source, _now, new_id  # noqa: E402
from envload import load_dotenv  # noqa: E402

VIDEOS.mkdir(exist_ok=True)
DATA.mkdir(exist_ok=True)
load_dotenv(ROOT)

# Whisper models offered in the UI / accepted by the API.
# CLI scripts/transcribe.py still accepts more sizes for power users.
ALLOWED_WHISPER_MODELS = frozenset({"small", "medium"})
DEFAULT_WHISPER_MODEL = "small"


def normalize_whisper_model(model: str | None) -> str:
    """Map to an allowed model; unknown / heavy sizes fall back to small."""
    m = (model or DEFAULT_WHISPER_MODEL).strip()
    if m in ALLOWED_WHISPER_MODELS:
        return m
    # Common aliases / retired UI options
    if m in {"small.en"}:
        return "small"
    if m in {"medium.en"}:
        return "medium"
    return DEFAULT_WHISPER_MODEL


lib = Library(LIBRARY_PATH)
jobs_lock = threading.Lock()
# source_id → {stage, message, percent, stages, detail, eta_s?}
job_status: dict[str, dict[str, Any]] = {}
# export_job_id → progress / result for clip exports
export_jobs: dict[str, dict[str, Any]] = {}
export_jobs_lock = threading.Lock()
# Remove-source cancel: workers check this; Popen tracked for killpg.
cancelled_sources: set[str] = set()
source_procs: dict[str, list[subprocess.Popen[Any]]] = {}
source_procs_lock = threading.Lock()


class SourceCancelled(Exception):
    """Human removed the source while ingest/export/publish was running."""


def _source_cancelled(source_id: str) -> bool:
    with jobs_lock:
        if source_id in cancelled_sources:
            return True
    return lib.get_source(source_id) is None


def _abort_if_cancelled(source_id: str) -> None:
    if _source_cancelled(source_id):
        raise SourceCancelled(source_id)


def _track_proc(source_id: str, proc: subprocess.Popen[Any]) -> None:
    with source_procs_lock:
        source_procs.setdefault(source_id, []).append(proc)


def _untrack_proc(source_id: str, proc: subprocess.Popen[Any]) -> None:
    with source_procs_lock:
        lst = source_procs.get(source_id) or []
        source_procs[source_id] = [p for p in lst if p is not proc]
        if not source_procs[source_id]:
            source_procs.pop(source_id, None)


def _popen_tracked(source_id: str, cmd: list[str], **kwargs: Any) -> subprocess.Popen[Any]:
    kwargs.setdefault("start_new_session", True)
    proc = subprocess.Popen(cmd, **kwargs)
    _track_proc(source_id, proc)
    return proc


def _kill_source_work(source_id: str) -> None:
    with jobs_lock:
        cancelled_sources.add(source_id)
        job_status.pop(source_id, None)
    with source_procs_lock:
        procs = list(source_procs.pop(source_id, []))
    for proc in procs:
        if proc.poll() is not None:
            continue
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except Exception:
                pass
    msg = "cancelled — source removed"
    with export_jobs_lock:
        for job in export_jobs.values():
            if job.get("source_id") == source_id and job.get("status") in (
                "queued",
                "running",
            ):
                job["status"] = "error"
                job["message"] = msg


def _clear_cancelled(source_id: str) -> None:
    with jobs_lock:
        cancelled_sources.discard(source_id)

PIPELINE_STAGES = [
    {"id": "queued", "label": "Queued"},
    {"id": "resolving", "label": "Resolve"},
    {"id": "downloading", "label": "Download"},
    {"id": "transcribing", "label": "Transcribe"},
    {"id": "done", "label": "Ready"},
]

app = FastAPI(title="clipgenerator", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8787",
        "http://localhost:8787",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _venv_python() -> str:
    venv_py = ROOT / ".venv" / "bin" / "python"
    if venv_py.is_file():
        return str(venv_py)
    return sys.executable


def _set_job(source_id: str, **kwargs: Any) -> None:
    with jobs_lock:
        cur = job_status.get(source_id, {})
        cur.setdefault("stages", PIPELINE_STAGES)
        for k, v in kwargs.items():
            # Drop null metrics so clients never see JSON null for % / ETA
            if v is None and k in ("percent", "eta_s", "elapsed_s"):
                cur.pop(k, None)
            else:
                cur[k] = v
        job_status[source_id] = cur


# ── Pipeline timing analytics (persisted on each source as `pipeline`) ──────


def _pipeline_get(source_id: str) -> dict[str, Any]:
    s = lib.get_source(source_id) or {}
    pipe = s.get("pipeline")
    return dict(pipe) if isinstance(pipe, dict) else {}


def _pipeline_save(source_id: str, pipe: dict[str, Any]) -> dict[str, Any]:
    """Persist pipeline blob on the source and mirror onto live job status."""
    lib.update_source(source_id, {"pipeline": pipe})
    with jobs_lock:
        cur = job_status.get(source_id)
        if cur is not None:
            cur["pipeline"] = pipe
    return pipe


def _pipeline_begin(
    source_id: str,
    *,
    model: str | None = None,
    audio_duration_s: float | None = None,
    reset: bool = True,
) -> dict[str, Any]:
    """Start (or soft-attach) a pipeline run for this source."""
    if not reset:
        existing = _pipeline_get(source_id)
        if existing.get("started_at") and existing.get("finished_at") is None:
            if model is not None:
                existing["model"] = model
            if audio_duration_s is not None:
                existing["audio_duration_s"] = audio_duration_s
            return _pipeline_save(source_id, existing)
    pipe: dict[str, Any] = {
        "started_at": _now(),
        "finished_at": None,
        "model": model,
        "audio_duration_s": audio_duration_s,
        "stages": {},
        "total_s": None,
        # audio_duration_s / stt_wall_s — higher means faster than real-time
        "stt_realtime_factor": None,
        "ok": None,
        "transcript_source": None,  # mlx-whisper | youtube-subs | reuse
    }
    return _pipeline_save(source_id, pipe)


def _pipeline_stage_start(source_id: str, stage: str) -> float:
    t0 = time.perf_counter()
    pipe = _pipeline_get(source_id)
    if not pipe.get("started_at"):
        pipe = _pipeline_begin(source_id)
    stages = dict(pipe.get("stages") or {})
    stages[stage] = {
        "started_at": _now(),
        "ended_at": None,
        "duration_s": None,
    }
    pipe["stages"] = stages
    _pipeline_save(source_id, pipe)
    return t0


def _pipeline_stage_end(
    source_id: str,
    stage: str,
    t0: float,
    *,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    dur = round(time.perf_counter() - t0, 3)
    pipe = _pipeline_get(source_id)
    stages = dict(pipe.get("stages") or {})
    prev = dict(stages.get(stage) or {})
    if not prev.get("started_at"):
        prev["started_at"] = _now()
    prev["ended_at"] = _now()
    prev["duration_s"] = dur
    if extra:
        for k, v in extra.items():
            if v is not None:
                prev[k] = v
    stages[stage] = prev
    pipe["stages"] = stages
    return _pipeline_save(source_id, pipe)


def _pipeline_finish(
    source_id: str,
    *,
    ok: bool,
    error: str | None = None,
    transcript_source: str | None = None,
) -> dict[str, Any]:
    pipe = _pipeline_get(source_id)
    if not pipe:
        return pipe
    pipe["finished_at"] = _now()
    total: float | None = None
    started = pipe.get("started_at")
    if started:
        try:
            start_dt = datetime.fromisoformat(str(started))
            end_dt = datetime.fromisoformat(str(pipe["finished_at"]))
            total = round((end_dt - start_dt).total_seconds(), 3)
        except Exception:
            total = None
    if total is None:
        stages = pipe.get("stages") or {}
        total = round(
            sum(float(st.get("duration_s") or 0) for st in stages.values() if isinstance(st, dict)),
            3,
        )
    pipe["total_s"] = total

    stt = (pipe.get("stages") or {}).get("transcribe") or {}
    # Prefer pure Whisper wall time when extract/whisper were split out.
    stt_s = stt.get("whisper_s")
    if stt_s is None:
        stt_s = stt.get("duration_s")
    audio = pipe.get("audio_duration_s")
    if stt_s and float(stt_s) > 0 and audio:
        pipe["stt_realtime_factor"] = round(float(audio) / float(stt_s), 2)
    else:
        pipe["stt_realtime_factor"] = None

    pipe["ok"] = ok
    if transcript_source:
        pipe["transcript_source"] = transcript_source
    if error:
        pipe["error"] = str(error)[:500]
    elif "error" in pipe and ok:
        pipe.pop("error", None)
    return _pipeline_save(source_id, pipe)


def _parse_timing_json(stdout: str | None) -> dict[str, Any] | None:
    """Extract TIMING_JSON:{…} line emitted by scripts/transcribe.py."""
    if not stdout:
        return None
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith("TIMING_JSON:"):
            continue
        raw = line[len("TIMING_JSON:") :].strip()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return None
        return data if isinstance(data, dict) else None
    return None


def _estimate_pipeline_from_files(source: dict[str, Any]) -> dict[str, Any] | None:
    """
    Best-effort timings for older sources that predate pipeline analytics.
    Uses file mtimes (audio → transcript ≈ STT wall) — approximate only.
    """
    vp = source.get("video_path")
    if not vp:
        return None
    video = Path(vp)
    if not video.is_file():
        return None
    audio = video.parent / f"{video.stem}.audio.m4a"
    tr_json = video.parent / f"{video.stem}.transcript.json"
    if not tr_json.is_file():
        return None
    stages: dict[str, Any] = {}
    tr_m = tr_json.stat().st_mtime
    if audio.is_file():
        a_m = audio.stat().st_mtime
        if tr_m >= a_m:
            stages["transcribe"] = {
                "duration_s": round(tr_m - a_m, 3),
                "note": "estimated from audio→transcript mtimes",
            }
        v_m = video.stat().st_mtime
        if a_m >= v_m:
            stages["extract"] = {
                "duration_s": round(max(0.0, a_m - v_m), 3),
                "note": "estimated from video→audio mtimes",
            }
    else:
        v_m = video.stat().st_mtime
        if tr_m >= v_m:
            stages["transcribe"] = {
                "duration_s": round(tr_m - v_m, 3),
                "note": "estimated from video→transcript mtimes",
            }
    if not stages:
        return None
    audio_dur = source.get("duration")
    stt_s = (stages.get("transcribe") or {}).get("duration_s")
    rtf = None
    if stt_s and stt_s > 0 and audio_dur:
        rtf = round(float(audio_dur) / float(stt_s), 2)
    total = round(sum(float(st.get("duration_s") or 0) for st in stages.values()), 3)
    return {
        "estimated": True,
        "started_at": None,
        "finished_at": None,
        "model": source.get("model"),
        "audio_duration_s": audio_dur,
        "stages": stages,
        "total_s": total,
        "stt_realtime_factor": rtf,
        "ok": source.get("status") == "ready",
        "transcript_source": None,
    }


def _maybe_heal_ready(source: dict[str, Any]) -> dict[str, Any]:
    """
    If STT finished on disk but the API died before marking ready (restart mid-job),
    promote the source to ready so the UI does not stick on 'transcribing' / 500 loops.
    """
    status = source.get("status")
    if status not in ("transcribing", "downloading", "pending", "error"):
        return source
    vp = source.get("video_path")
    if not vp:
        return source
    video = Path(vp)
    if not video.is_file():
        return source
    json_path = video.parent / f"{video.stem}.transcript.json"
    if not json_path.is_file():
        return source
    # Transcript exists — heal
    txt_path = video.parent / f"{video.stem}.transcript.txt"
    patch: dict[str, Any] = {
        "status": "ready",
        "error": None,
        "transcript_json": str(json_path),
        "transcript_txt": str(txt_path) if txt_path.is_file() else source.get("transcript_txt"),
    }
    if not source.get("clips"):
        end = min(30.0, float(source.get("duration") or 30.0))
        patch["clips"] = [make_clip(title="Clip 1", t_in=0.0, t_out=end)]
    updated = lib.update_source(source["id"], patch)
    if updated:
        _set_job(
            source["id"],
            stage="done",
            percent=100,
            progress_kind="measured",
            message="Ready",
            detail="Transcript ready — create clips in the editor",
        )
        return updated
    return {**source, **patch}


def _probe_url(url: str) -> dict[str, Any]:
    """Lightweight yt-dlp metadata (title, id, duration, upload_date)."""
    cmd = [
        "yt-dlp",
        "--config-locations",
        str(ROOT / "config" / "yt-dlp.conf"),
        "--skip-download",
        "--no-warnings",
        "--print",
        "%(title)s\t%(id)s\t%(duration)s\t%(upload_date)s\t%(uploader)s",
        url,
    ]
    proc = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)
    if proc.returncode != 0:
        return {}
    line = (proc.stdout or "").strip().splitlines()[-1] if proc.stdout else ""
    parts = line.split("\t")
    if len(parts) < 2:
        return {}
    title, mid = parts[0], parts[1]
    duration = None
    if len(parts) > 2 and parts[2] not in ("", "NA", "None"):
        try:
            duration = float(parts[2])
        except ValueError:
            duration = None
    upload_date = parts[3] if len(parts) > 3 and parts[3] not in ("NA", "None", "") else None
    uploader = parts[4] if len(parts) > 4 else None
    return {
        "title": title,
        "id": mid,
        "duration": duration,
        "upload_date": upload_date,
        "uploader": uploader,
    }


# Ingest download is video → audio → glue, mapped onto pipeline 10–55%.
# File % from the first yt-dlp job must not fill that whole range.
_DOWNLOAD_PHASE_VIDEO = "video"
_DOWNLOAD_PHASE_AUDIO = "audio"
_DOWNLOAD_PHASE_GLUE = "glue"


def _download_phase_from_line(line: str, current: str) -> str:
    """Advance video/audio/glue from download.sh banners (not yt-dlp % lines)."""
    if "--- Picture ---" in line or "Reusing picture" in line:
        return _DOWNLOAD_PHASE_VIDEO
    if "--- Sound" in line or "Reusing complete sound" in line:
        return _DOWNLOAD_PHASE_AUDIO
    if (
        "=== Mux ===" in line
        or "Muxing clean" in line
        or line.startswith("Muxing ")
        or "Normalizing to H.264" in line
    ):
        return _DOWNLOAD_PHASE_GLUE
    return current


def _download_phase_banner_job(line: str, phase: str) -> tuple[int, str] | None:
    """Headline when a phase banner prints — even if ffmpeg never emits %."""
    if "Reusing picture" in line:
        return 40, "Video already on disk"
    if "Reusing complete sound" in line:
        return 50, "Audio already on disk"
    if "--- Picture ---" in line:
        return 10, "Downloading video…"
    if "--- Sound" in line:
        return 40, "Downloading audio…"
    if phase == _DOWNLOAD_PHASE_GLUE and (
        "=== Mux ===" in line
        or "Muxing" in line
        or "Normalizing to H.264" in line
    ):
        return 52, "Gluing video + audio…"
    return None


def _map_download_file_pct(phase: str, file_pct: float) -> tuple[int, str]:
    """Map one file's 0–100% onto the pipeline slice for that chore."""
    pct = max(0.0, min(100.0, file_pct))
    if phase == _DOWNLOAD_PHASE_AUDIO:
        return 40 + int(pct * 0.12), f"Downloading audio… {pct:.1f}%"
    if phase == _DOWNLOAD_PHASE_GLUE:
        return 52 + int(pct * 0.03), "Gluing video + audio…"
    return 10 + int(pct * 0.30), f"Downloading video… {pct:.1f}%"


def _run_download(url: str, out_template: str, source_id: str) -> Path:
    """Run download.sh with a fixed output template; stream progress into job_status."""
    t0 = _pipeline_stage_start(source_id, "download")
    cmd = [str(DOWNLOAD_SH), "-o", out_template, url]
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    proc = _popen_tracked(
        source_id,
        cmd,
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )
    last_path: str | None = None
    tail: list[str] = []
    phase = _DOWNLOAD_PHASE_VIDEO
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            if _source_cancelled(source_id):
                raise SourceCancelled(source_id)
            line = line.rstrip()
            if not line:
                continue
            tail.append(line)
            if len(tail) > 40:
                tail = tail[-40:]
            next_phase = _download_phase_from_line(line, phase)
            if next_phase != phase:
                phase = next_phase
            banner = _download_phase_banner_job(line, phase)
            if banner:
                overall, message = banner
                _set_job(
                    source_id,
                    stage="downloading",
                    percent=overall,
                    progress_kind="measured",
                    message=message,
                    detail=line[:160],
                )
            # Progress: [download]  12.3% of …
            m = re.search(r"\[download\]\s+(\d+(?:\.\d+)?)%", line)
            if m:
                pct = float(m.group(1))
                overall, message = _map_download_file_pct(phase, pct)
                _set_job(
                    source_id,
                    stage="downloading",
                    percent=overall,
                    progress_kind="measured",
                    message=message,
                    detail=line[:160],
                )
            path_m = re.search(r"^Path:\s+(.+)$", line)
            if path_m:
                last_path = path_m.group(1).strip()
            frag_m = re.search(r"frag\s+(\d+)/(\d+)", line)
            if frag_m and not m:
                cur_f, tot_f = int(frag_m.group(1)), max(1, int(frag_m.group(2)))
                pct = 100.0 * cur_f / tot_f
                overall, _msg = _map_download_file_pct(phase, pct)
                noun = (
                    "audio"
                    if phase == _DOWNLOAD_PHASE_AUDIO
                    else "video"
                    if phase == _DOWNLOAD_PHASE_VIDEO
                    else "glue"
                )
                _set_job(
                    source_id,
                    stage="downloading",
                    percent=overall,
                    progress_kind="measured",
                    message=f"Downloading {noun} fragments {cur_f}/{tot_f}",
                    detail=line[:160],
                )
        rc = proc.wait()
        tmpl_dir = Path(out_template).parent

        def _pick_source() -> Path | None:
            if last_path and Path(last_path).is_file():
                return Path(last_path)
            candidates = sorted(
                tmpl_dir.glob("source.*"), key=lambda p: p.stat().st_mtime, reverse=True
            )
            for c in candidates:
                if c.suffix.lower() in {".mp4", ".mkv", ".webm", ".mov", ".ts"} and c.is_file():
                    return c
            return None

        path = _pick_source()
        if rc != 0:
            # yt-dlp / remux can exit 1 after writing a usable file (mpegts merge).
            if path and path.is_file() and path.stat().st_size > 1_000_000:
                dur = _ffprobe_duration(path)
                if dur is not None and dur > 5:
                    _set_job(
                        source_id,
                        stage="downloading",
                        message="Download reported an error but the file is usable — continuing",
                        detail=(tail[-1] if tail else "")[:160],
                    )
                else:
                    path = None
            if path is None:
                useful = [
                    ln
                    for ln in tail
                    if "Opening 'http" not in ln and "https @ 0x" not in ln
                ]
                pick = useful[-15:] if useful else tail[-8:]
                label = (
                    f"download finished with warnings (exit {rc})"
                    if rc == 2
                    else f"download failed (exit {rc})"
                )
                hint = "\n".join(pick) if pick else f"exit {rc}"
                raise RuntimeError(f"{label}\n{hint}")
        if path is None:
            raise RuntimeError("download finished but source video not found")
        try:
            size_mb = round(path.stat().st_size / (1024 * 1024), 1)
        except OSError:
            size_mb = None
        _pipeline_stage_end(
            source_id,
            "download",
            t0,
            extra={"bytes_mb": size_mb, "path": path.name},
        )
        return path
    except SourceCancelled:
        try:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, OSError):
            pass
        raise
    except Exception:
        # Still record partial duration on failure
        try:
            _pipeline_stage_end(source_id, "download", t0, extra={"failed": True})
        except Exception:
            pass
        raise
    finally:
        _untrack_proc(source_id, proc)

def _fmt_dur_short(seconds: float | None) -> str:
    """Human duration for job messages (e.g. 2h 17m, 12m 05s)."""
    if seconds is None or seconds < 0:
        return "—"
    s = int(round(float(seconds)))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h > 0:
        return f"{h}h {m:02d}m"
    if m > 0:
        return f"{m}m {sec:02d}s"
    return f"{sec}s"


def _stt_rough_range_s(model: str, duration_s: float | None) -> tuple[int, int]:
    """
    Conservative wall-time *range* for segment-only MLX STT on Apple Silicon.

    Used as expectation band in the UI; live health uses RTF + progress stalls.
    """
    # factor of audio duration (wall / audio)
    bands = {
        "tiny": (0.04, 0.12),
        "small": (0.05, 0.18),
        "small.en": (0.05, 0.16),
        "medium": (0.10, 0.35),
        "turbo": (0.07, 0.22),
        "large-v3-turbo": (0.07, 0.22),
        "distil-large-v3": (0.06, 0.20),
        "large-v3": (0.18, 0.55),
    }
    lo_f, hi_f = bands.get(model, (0.08, 0.25))
    audio = float(duration_s or 3600.0)
    load = 30  # model load / audio extract buffer
    lo = max(45, int(audio * lo_f + load))
    hi = max(lo + 60, int(audio * hi_f + load * 2))
    return lo, hi


def _stt_rtf_thresholds(model: str) -> tuple[float, float]:
    """
    (healthy_min_rtf, slow_min_rtf) — audio_seconds decoded per wall second.

    Calibrated from this project's observed healthy runs (~25–35× on small).
    Floors are intentionally below peak so we only alert on real pathology.
    """
    m = (model or "small").strip()
    table = {
        "tiny": (20.0, 8.0),
        "small": (12.0, 5.0),
        "small.en": (12.0, 5.0),
        "medium": (6.0, 2.5),
        "medium.en": (6.0, 2.5),
        "turbo": (10.0, 4.0),
        "large-v3-turbo": (10.0, 4.0),
        "distil-large-v3": (10.0, 4.0),
        "large-v3": (4.0, 1.5),
    }
    return table.get(m, (8.0, 3.0))


def _eval_stt_health(
    *,
    model: str,
    elapsed_s: float,
    audio_pos_s: float | None,
    audio_total_s: float | None,
    last_progress_at: float | None,
    rtf: float | None,
    lo_s: int,
    hi_s: int,
    now: float | None = None,
) -> dict[str, Any]:
    """
    Decide whether on-device STT looks healthy.

    Levels: starting | ok | slow | critical | stalled
    """
    now = now if now is not None else time.time()
    healthy_min, slow_min = _stt_rtf_thresholds(model)
    progress_age = (now - last_progress_at) if last_progress_at else None
    pct = None
    if audio_pos_s is not None and audio_total_s and audio_total_s > 0:
        pct = max(0.0, min(100.0, 100.0 * float(audio_pos_s) / float(audio_total_s)))

    # Stall: no ticks at all (process may be wedged before first emit)
    if last_progress_at is None and elapsed_s >= 180:
        return {
            "level": "stalled",
            "code": "no_progress",
            "message": (
                f"STT issue: no progress signal after {_fmt_dur_short(elapsed_s)} "
                f"(extract/model load should emit well before this)"
            ),
            "rtf": rtf,
            "rtf_healthy_min": healthy_min,
            "audio_pos_s": audio_pos_s,
            "percent": pct,
            "progress_age_s": progress_age,
        }
    # Decode stall: only after we've seen real audio position ticks
    if (
        audio_pos_s is not None
        and progress_age is not None
        and progress_age >= 90
        and elapsed_s >= 60
    ):
        return {
            "level": "stalled",
            "code": "progress_stalled",
            "message": (
                f"STT issue: decode stalled — no progress for "
                f"{_fmt_dur_short(progress_age)} "
                f"(last audio pos {_fmt_dur_short(audio_pos_s)})"
            ),
            "rtf": rtf,
            "rtf_healthy_min": healthy_min,
            "audio_pos_s": audio_pos_s,
            "percent": pct,
            "progress_age_s": progress_age,
        }
    # Pre-decode hang (extract / mel / model) — longer leash than decode ticks
    if (
        audio_pos_s is None
        and progress_age is not None
        and progress_age >= 600
        and elapsed_s >= 600
    ):
        return {
            "level": "stalled",
            "code": "load_stalled",
            "message": (
                f"STT issue: stuck before decode for {_fmt_dur_short(progress_age)} "
                f"(extract / model load / mel)"
            ),
            "rtf": rtf,
            "rtf_healthy_min": healthy_min,
            "audio_pos_s": audio_pos_s,
            "percent": pct,
            "progress_age_s": progress_age,
        }

    # Warm-up window: model load + first windows (don't cry wolf)
    if (
        elapsed_s < 45
        or audio_pos_s is None
        or (audio_pos_s is not None and audio_pos_s < 15)
    ):
        return {
            "level": "starting",
            "code": "warmup",
            "message": "Starting local Whisper (extract / model load / first windows)…",
            "rtf": rtf,
            "rtf_healthy_min": healthy_min,
            "audio_pos_s": audio_pos_s,
            "percent": pct,
            "progress_age_s": progress_age,
        }

    # Past high estimate with weak throughput
    if elapsed_s > max(hi_s * 1.5, hi_s + 120) and (rtf is None or rtf < healthy_min):
        return {
            "level": "critical",
            "code": "over_estimate",
            "message": (
                f"STT issue: {_fmt_dur_short(elapsed_s)} elapsed "
                f"(expected up to ~{_fmt_dur_short(hi_s)}) · "
                f"live {rtf:.1f}× realtime" if rtf is not None else
                f"STT issue: {_fmt_dur_short(elapsed_s)} elapsed "
                f"(expected up to ~{_fmt_dur_short(hi_s)}) · no live RTF yet"
            ),
            "rtf": rtf,
            "rtf_healthy_min": healthy_min,
            "audio_pos_s": audio_pos_s,
            "percent": pct,
            "progress_age_s": progress_age,
        }

    if rtf is not None:
        if rtf >= healthy_min:
            return {
                "level": "ok",
                "code": "healthy_rtf",
                "message": f"STT healthy · {rtf:.1f}× realtime (floor {healthy_min:.0f}×)",
                "rtf": rtf,
                "rtf_healthy_min": healthy_min,
                "audio_pos_s": audio_pos_s,
                "percent": pct,
                "progress_age_s": progress_age,
            }
        if rtf >= slow_min:
            return {
                "level": "slow",
                "code": "slow_rtf",
                "message": (
                    f"STT slow · {rtf:.1f}× realtime "
                    f"(healthy ≥{healthy_min:.0f}× on {model}) — "
                    f"decode is moving but well below this machine's normal"
                ),
                "rtf": rtf,
                "rtf_healthy_min": healthy_min,
                "audio_pos_s": audio_pos_s,
                "percent": pct,
                "progress_age_s": progress_age,
            }
        return {
            "level": "critical",
            "code": "critical_rtf",
            "message": (
                f"STT issue · {rtf:.1f}× realtime "
                f"(healthy ≥{healthy_min:.0f}× on {model}) — "
                f"pathologically slow vs other sources on this Mac"
            ),
            "rtf": rtf,
            "rtf_healthy_min": healthy_min,
            "audio_pos_s": audio_pos_s,
            "percent": pct,
            "progress_age_s": progress_age,
        }

    # Have position but no RTF yet
    return {
        "level": "starting",
        "code": "warmup",
        "message": "Decoding… measuring throughput",
        "rtf": rtf,
        "rtf_healthy_min": healthy_min,
        "audio_pos_s": audio_pos_s,
        "percent": pct,
        "progress_age_s": progress_age,
    }


def _parse_progress_json(line: str) -> dict[str, Any] | None:
    """Parse PROGRESS_JSON even if tqdm or other noise shares the line."""
    marker = "PROGRESS_JSON:"
    idx = line.find(marker)
    if idx < 0:
        return None
    raw = line[idx + len(marker) :].strip()
    # If trailing junk, try progressive trim from first { to last }
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            data = json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            return None
    return data if isinstance(data, dict) else None


def _run_transcribe(
    video_path: Path,
    *,
    source_id: str,
    model: str,
    force: bool,
    duration_s: float | None,
) -> dict[str, Any] | None:
    """
    Run scripts/transcribe.py with *streamed* PROGRESS_JSON for health monitoring.
    Returns TIMING_JSON payload when present.
    """
    t0 = _pipeline_stage_start(source_id, "transcribe")
    # Keep audio duration on the pipeline for RTF calc even if set earlier.
    pipe = _pipeline_get(source_id)
    if duration_s is not None or model:
        if duration_s is not None:
            pipe["audio_duration_s"] = duration_s
        if model:
            pipe["model"] = model
        _pipeline_save(source_id, pipe)

    cmd = [
        _venv_python(),
        str(TRANSCRIBE_PY),
        str(video_path),
        "--stt",
        "--model",
        model,
    ]
    if force:
        cmd.append("--force")

    lo_s, hi_s = _stt_rough_range_s(model, duration_s)
    audio_label = _fmt_dur_short(duration_s)
    rough_label = f"expected ~{_fmt_dur_short(lo_s)}–{_fmt_dur_short(hi_s)}"
    started = time.time()
    healthy_min, _slow_min = _stt_rtf_thresholds(model)

    # Live decode state (updated by stdout reader)
    prog_lock = threading.Lock()
    prog: dict[str, Any] = {
        "audio_pos_s": None,
        "audio_total_s": duration_s,
        "percent": None,
        "rtf": None,
        "phase": None,
        "last_progress_at": None,
        "last_health": None,
    }

    def _publish_job(*, terminal_fail: str | None = None) -> dict[str, Any]:
        elapsed = int(time.time() - started)
        with prog_lock:
            audio_pos = prog.get("audio_pos_s")
            audio_total = prog.get("audio_total_s") or duration_s
            rtf = prog.get("rtf")
            last_at = prog.get("last_progress_at")
            pct = prog.get("percent")
            phase = prog.get("phase")
            chunk = prog.get("chunk")
            chunks = prog.get("chunks")
        health = _eval_stt_health(
            model=model,
            elapsed_s=float(elapsed),
            audio_pos_s=float(audio_pos) if audio_pos is not None else None,
            audio_total_s=float(audio_total) if audio_total is not None else None,
            last_progress_at=float(last_at) if last_at is not None else None,
            rtf=float(rtf) if rtf is not None else None,
            lo_s=lo_s,
            hi_s=hi_s,
        )
        with prog_lock:
            prog["last_health"] = health

        # Prefer live decode % when we have it
        live_pct = health.get("percent")
        if live_pct is None:
            live_pct = pct
        has_live = live_pct is not None
        level = health.get("level") or "starting"

        phase_label = {
            "extract": "extracting audio",
            "extract_done": "audio ready",
            "load_model": "loading model",
            "decode": "decoding",
        }.get(str(phase or ""), None)
        chunk_label = None
        if chunk is not None and chunks is not None:
            chunk_label = f"chunk {chunk}/{chunks}"

        if terminal_fail:
            message = terminal_fail
        elif level in ("critical", "stalled"):
            message = health["message"]
        elif level == "slow":
            message = (
                f"Transcribing ({model})… slow · "
                f"{_fmt_dur_short(elapsed)} elapsed"
                + (f" · {live_pct:.0f}% audio" if has_live else "")
                + (f" · {rtf:.1f}×" if rtf is not None else "")
            )
        elif has_live:
            message = (
                f"Transcribing ({model})… {live_pct:.0f}% of audio"
                + (f" · {rtf:.1f}× realtime" if rtf is not None else "")
                + (f" · {chunk_label}" if chunk_label else "")
                + f" · elapsed {_fmt_dur_short(elapsed)}"
            )
        elif phase_label:
            message = (
                f"Transcribing ({model})… {phase_label}"
                + (f" · {chunk_label}" if chunk_label else "")
                + f" · elapsed {_fmt_dur_short(elapsed)}"
            )
        else:
            message = f"Transcribing with Whisper ({model})… elapsed {_fmt_dur_short(elapsed)}"

        detail_parts = [
            f"Local MLX Whisper · {model}",
            f"audio {audio_label}",
            rough_label,
        ]
        if chunk_label:
            detail_parts.append(chunk_label)
        if phase_label:
            detail_parts.append(phase_label)
        if rtf is not None:
            detail_parts.append(f"live {rtf:.1f}× realtime (healthy ≥{healthy_min:.0f}×)")
        if audio_pos is not None:
            detail_parts.append(f"decoded {_fmt_dur_short(audio_pos)}")
        if level in ("slow", "critical", "stalled"):
            detail_parts.append(f"health={level}")

        # ETA from live RTF when available
        eta_s = None
        if (
            rtf is not None
            and rtf > 0.2
            and audio_pos is not None
            and audio_total is not None
            and float(audio_total) > float(audio_pos)
        ):
            remaining_audio = float(audio_total) - float(audio_pos)
            eta_s = int(remaining_audio / rtf)

        _set_job(
            source_id,
            stage="transcribing",
            percent=round(float(live_pct), 1) if has_live else None,
            progress_kind="measured" if has_live else "indeterminate",
            message=message,
            detail=" · ".join(detail_parts),
            elapsed_s=elapsed,
            rough_est_lo_s=lo_s,
            rough_est_hi_s=hi_s,
            eta_s=eta_s,
            stt_health=health,
            stt_rtf=rtf,
            stt_audio_pos_s=audio_pos,
            stt_audio_total_s=audio_total,
            stt_phase=phase,
        )
        return health

    def heartbeat() -> None:
        while not stop_hb.wait(2.0):
            _publish_job()

    stop_hb = threading.Event()
    _publish_job()
    hb = threading.Thread(target=heartbeat, daemon=True)
    hb.start()

    timing: dict[str, Any] | None = None
    stdout_chunks: list[str] = []
    try:
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        # Force line-buffered progress even if tqdm fights us
        env["WHISPER_PROGRESS_INTERVAL_S"] = env.get("WHISPER_PROGRESS_INTERVAL_S", "1.0")
        proc = _popen_tracked(
            source_id,
            cmd,
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
        )
        assert proc.stdout is not None
        for raw_line in proc.stdout:
            if _source_cancelled(source_id):
                raise SourceCancelled(source_id)
            stdout_chunks.append(raw_line)
            line = raw_line.rstrip("\n")
            p = _parse_progress_json(line)
            if p:
                with prog_lock:
                    phase = p.get("phase")
                    if phase:
                        prog["phase"] = phase
                    # Decode ticks carry audio position; phase-only lines still count
                    # as liveness so we don't false-stall during extract/model load.
                    prev_pos = prog.get("audio_pos_s")
                    if p.get("audio_pos_s") is not None:
                        prog["audio_pos_s"] = float(p["audio_pos_s"])
                    if p.get("audio_total_s") is not None:
                        prog["audio_total_s"] = float(p["audio_total_s"])
                    if p.get("percent") is not None:
                        prog["percent"] = float(p["percent"])
                    if p.get("rtf") is not None:
                        prog["rtf"] = float(p["rtf"])
                    if p.get("chunk") is not None:
                        prog["chunk"] = p.get("chunk")
                    if p.get("chunks") is not None:
                        prog["chunks"] = p.get("chunks")
                    # Only treat as real progress if audio position advanced (or first tick)
                    new_pos = prog.get("audio_pos_s")
                    if (
                        new_pos is None
                        or prev_pos is None
                        or float(new_pos) > float(prev_pos) + 0.05
                        or phase in ("extract", "extract_done", "load_model")
                    ):
                        prog["last_progress_at"] = time.time()
                _publish_job()
                continue
            if line.startswith("TIMING_JSON:"):
                try:
                    timing = json.loads(line[len("TIMING_JSON:") :].strip())
                except json.JSONDecodeError:
                    pass
        rc = proc.wait()
        full_out = "".join(stdout_chunks)
        if timing is None:
            timing = _parse_timing_json(full_out)
        if rc != 0:
            raise RuntimeError(f"transcribe failed:\n{full_out[-2000:]}")
    except SourceCancelled:
        try:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, OSError, NameError):
            pass
        raise
    except Exception as e:
        try:
            health = _publish_job(terminal_fail=f"STT failed: {e}")
            _pipeline_stage_end(
                source_id,
                "transcribe",
                t0,
                extra={
                    "failed": True,
                    "stt_health": (health or {}).get("level"),
                    "stt_health_code": (health or {}).get("code"),
                },
            )
        except Exception:
            pass
        raise
    finally:
        stop_hb.set()
        try:
            _untrack_proc(source_id, proc)
        except NameError:
            pass

    # Final health snapshot for analytics
    final_health = _publish_job()
    extra: dict[str, Any] = {
        "stt_health": (final_health or {}).get("level"),
        "stt_health_code": (final_health or {}).get("code"),
        "stt_rtf_final": (final_health or {}).get("rtf"),
    }
    if timing:
        for k in (
            "extract_s",
            "whisper_s",
            "total_s",
            "audio_reused",
            "word_timestamps",
            "segments",
            "source",
            "model_repo",
        ):
            if k in timing and timing[k] is not None:
                extra[k] = timing[k]
        # Nested extract stage for clearer analytics UI
        if timing.get("extract_s") is not None:
            pipe2 = _pipeline_get(source_id)
            stages = dict(pipe2.get("stages") or {})
            stages["extract"] = {
                "duration_s": timing.get("extract_s"),
                "audio_reused": timing.get("audio_reused"),
                "note": "inside transcribe subprocess",
            }
            if timing.get("whisper_s") is not None:
                stages["whisper"] = {
                    "duration_s": timing.get("whisper_s"),
                    "word_timestamps": timing.get("word_timestamps"),
                    "note": "inside transcribe subprocess",
                }
            pipe2["stages"] = stages
            if timing.get("source"):
                pipe2["transcript_source"] = timing["source"]
            # Persist health on pipeline root
            pipe2["stt_health"] = extra.get("stt_health")
            pipe2["stt_health_code"] = extra.get("stt_health_code")
            _pipeline_save(source_id, pipe2)
    else:
        pipe2 = _pipeline_get(source_id)
        pipe2["stt_health"] = extra.get("stt_health")
        pipe2["stt_health_code"] = extra.get("stt_health_code")
        _pipeline_save(source_id, pipe2)
    _pipeline_stage_end(source_id, "transcribe", t0, extra=extra or None)
    return timing


def _ffprobe_duration(path: Path) -> float | None:
    try:
        out = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                str(path),
            ],
            text=True,
        ).strip()
        return float(out) if out else None
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError):
        return None


def _load_transcript(path: Path | None) -> dict[str, Any] | None:
    if not path or not Path(path).is_file():
        return None
    return json.loads(Path(path).read_text(encoding="utf-8"))


class IngestBody(BaseModel):
    url: str | None = None
    video_path: str | None = None
    model: str = DEFAULT_WHISPER_MODEL
    title: str | None = None
    force_transcribe: bool = False


class ClipCreate(BaseModel):
    title: str = "Untitled clip"
    t_in: float = 0.0
    t_out: float = 30.0
    notes: str = ""


class ClipUpdate(BaseModel):
    title: str | None = None
    t_in: float | None = None
    t_out: float | None = None
    notes: str | None = None
    status: str | None = None
    captions: list[dict[str, Any]] | None = None
    post_text: str | None = None
    tags: list[str] | None = None


class CaptionsPut(BaseModel):
    """Full replace of clip-relative caption cues."""

    captions: list[dict[str, Any]] = Field(default_factory=list)


class ExportBody(BaseModel):
    clip_ids: list[str] | None = None  # None = all clips on source
    # App-wide caption plate style (viral burn-in). When omitted, defaults apply.
    caption_style: dict[str, Any] | None = None
    # Burn when cues exist (default True). SRT is always written when cues exist.
    burn_captions: bool = True


class CaptionPlatePreviewBody(BaseModel):
    """Render one plate with the same engine as export burn-in (for monitor parity)."""

    text: str = ""
    caption_style: dict[str, Any] | None = None
    video_w: int = Field(1920, ge=16, le=7680)
    video_h: int = Field(1080, ge=16, le=4320)


@app.post("/api/caption-plate-preview")
def caption_plate_preview(body: CaptionPlatePreviewBody) -> dict[str, Any]:
    """
    Return a base64 PNG + placement for the active cue.

    Uses the identical Pillow renderer as export, so line wraps match burn-in.
    """
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "text required")
    style = normalize_caption_style(body.caption_style)
    try:
        img, ox, oy, lines = render_caption_plate_image(
            text,
            style,
            video_w=int(body.video_w),
            video_h=int(body.video_h),
        )
    except Exception as e:
        raise HTTPException(500, f"plate render failed: {e}") from e
    buf = BytesIO()
    img.save(buf, format="PNG")
    return {
        "png_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
        "x": ox,
        "y": oy,
        "plate_w": img.width,
        "plate_h": img.height,
        "video_w": int(body.video_w),
        "video_h": int(body.video_h),
        "lines": lines,
        "line_count": len(lines),
        "caption_style": style,
    }


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "root": str(ROOT),
        "videos": str(VIDEOS),
        "python": _venv_python(),
    }


@app.get("/api/sources")
def list_sources() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for s in lib.list_sources():
        try:
            row = _maybe_heal_ready(s)
        except Exception:
            row = s
        with jobs_lock:
            job = job_status.get(row.get("id") or "")
        if job:
            row = {**row, "job": job}
        out.append(row)
    return out


@app.get("/api/sources/{source_id}")
def get_source(source_id: str) -> dict[str, Any]:
    s = lib.get_source(source_id)
    if not s:
        raise HTTPException(404, "source not found")
    try:
        s = _maybe_heal_ready(s)
    except Exception:
        pass
    with jobs_lock:
        s = {**s, "job": job_status.get(source_id)}
    return s


@app.get("/api/sources/{source_id}/transcript")
def get_transcript(source_id: str) -> dict[str, Any]:
    s = lib.get_source(source_id)
    if not s:
        raise HTTPException(404, "source not found")
    tpath = s.get("transcript_json")
    data = _load_transcript(Path(tpath) if tpath else None)
    if not data:
        raise HTTPException(404, "transcript not ready")
    return data


@app.get("/api/sources/{source_id}/job")
def get_job(source_id: str) -> dict[str, Any]:
    with jobs_lock:
        return job_status.get(source_id) or {"stage": "idle"}


@app.get("/api/analytics/pipeline")
def pipeline_analytics() -> dict[str, Any]:
    """
    Compare wall-time for resolve / download / STT across sources.

    Uses persisted `pipeline` when present; otherwise estimates from file mtimes
    so older library rows are still comparable.
    """
    rows: list[dict[str, Any]] = []
    for s in lib.list_sources():
        pipe = s.get("pipeline") if isinstance(s.get("pipeline"), dict) else None
        estimated = False
        if not pipe or not (pipe.get("stages") or pipe.get("total_s") is not None):
            est = _estimate_pipeline_from_files(s)
            if est:
                pipe = est
                estimated = True
            else:
                pipe = pipe or {}
        stages = pipe.get("stages") or {}

        def _stage_s(name: str) -> float | None:
            st = stages.get(name)
            if not isinstance(st, dict):
                return None
            d = st.get("duration_s")
            return float(d) if d is not None else None

        stt_s = _stage_s("transcribe")
        whisper_s = _stage_s("whisper")
        if whisper_s is None and isinstance(stages.get("transcribe"), dict):
            w = stages["transcribe"].get("whisper_s")
            if w is not None:
                whisper_s = float(w)
        extract_s = _stage_s("extract")
        if extract_s is None and isinstance(stages.get("transcribe"), dict):
            e = stages["transcribe"].get("extract_s")
            if e is not None:
                extract_s = float(e)

        audio_s = pipe.get("audio_duration_s")
        if audio_s is None:
            audio_s = s.get("duration")
        rtf = pipe.get("stt_realtime_factor")
        if rtf is None and stt_s and stt_s > 0 and audio_s:
            rtf = round(float(audio_s) / float(stt_s), 2)

        # Final health from last run (ok/slow/critical/stalled) when recorded
        stt_health = pipe.get("stt_health")
        if not stt_health and isinstance(stages.get("transcribe"), dict):
            stt_health = stages["transcribe"].get("stt_health")
        # Infer from RTF for estimated historical rows
        if not stt_health and rtf is not None and s.get("model"):
            hmin, smin = _stt_rtf_thresholds(str(s.get("model") or "small"))
            if rtf >= hmin:
                stt_health = "ok"
            elif rtf >= smin:
                stt_health = "slow"
            else:
                stt_health = "critical"

        rows.append(
            {
                "id": s.get("id"),
                "title": s.get("title"),
                "status": s.get("status"),
                "model": pipe.get("model") or s.get("model"),
                "audio_duration_s": audio_s,
                "resolve_s": _stage_s("resolve"),
                "download_s": _stage_s("download"),
                "extract_s": extract_s,
                "whisper_s": whisper_s,
                "transcribe_s": stt_s,
                "total_s": pipe.get("total_s"),
                "stt_realtime_factor": rtf,
                "stt_health": stt_health,
                "transcript_source": pipe.get("transcript_source"),
                "ok": pipe.get("ok"),
                "estimated": estimated or bool(pipe.get("estimated")),
                "started_at": pipe.get("started_at") or s.get("created_at"),
                "finished_at": pipe.get("finished_at"),
                "pipeline": pipe if pipe else None,
            }
        )

    # Newest first
    rows.sort(key=lambda r: str(r.get("started_at") or ""), reverse=True)
    return {"sources": rows, "count": len(rows)}


class SourceUpdate(BaseModel):
    title: str | None = None
    podbrief_text: str | None = None
    summary_post_url: str | None = None
    summary_post_text: str | None = None
    summary_prompt_text: str | None = None
    clip_prompt_text: str | None = None


@app.patch("/api/sources/{source_id}")
def patch_source(source_id: str, body: SourceUpdate) -> dict[str, Any]:
    if not lib.get_source(source_id):
        raise HTTPException(404, "source not found")
    patch: dict[str, Any] = {}
    if body.podbrief_text is not None:
        patch["podbrief_text"] = body.podbrief_text
    if body.summary_post_url is not None:
        patch["summary_post_url"] = body.summary_post_url.strip() or None
    if body.summary_post_text is not None:
        # Preserve intentional whitespace; empty → clear
        text = body.summary_post_text
        patch["summary_post_text"] = text if (text or "").strip() else None
    if body.summary_prompt_text is not None:
        patch["summary_prompt_text"] = body.summary_prompt_text
    if body.clip_prompt_text is not None:
        patch["clip_prompt_text"] = body.clip_prompt_text
    if body.title is not None:
        t = clean_title(body.title.strip()) if body.title.strip() else ""
        if not t:
            raise HTTPException(400, "title cannot be empty")
        patch["title"] = t[:200]
    if not patch:
        raise HTTPException(400, "no fields to update")
    out = lib.update_source(source_id, patch)
    if not out:
        raise HTTPException(404, "source not found")
    return out


@app.delete("/api/sources/{source_id}")
def delete_source(source_id: str) -> dict[str, str]:
    """Remove source from the library sidebar only (does not delete files on disk)."""
    if not lib.get_source(source_id):
        raise HTTPException(404, "source not found")
    _kill_source_work(source_id)
    lib.delete_source(source_id)
    return {"status": "deleted"}


def _run_ingest(source_id: str, body: IngestBody) -> None:
    s = lib.get_source(source_id)
    if not s:
        return
    _clear_cancelled(source_id)
    _pipeline_begin(source_id, model=body.model)
    try:
        video_path: Path | None = None
        project_dir: Path | None = None
        timing: dict[str, Any] | None = None

        if body.url:
            t_resolve = _pipeline_stage_start(source_id, "resolve")
            _set_job(
                source_id,
                stage="resolving",
                percent=3,
                message="Resolving media metadata…",
                detail=body.url,
            )
            s["status"] = "downloading"
            s["error"] = None
            s["url"] = body.url
            lib.upsert_source(s)

            meta = _probe_url(body.url)
            raw_title = body.title or meta.get("title") or "Untitled"
            nice_title = clean_title(raw_title)
            s["title"] = nice_title
            if meta.get("duration") is not None:
                s["duration"] = meta["duration"]
                # Seed audio length early for STT estimates + RTF
                pipe = _pipeline_get(source_id)
                pipe["audio_duration_s"] = meta["duration"]
                _pipeline_save(source_id, pipe)
            lib.upsert_source(s)

            # Prefer channel/uploader as "Podcast Name" in folder: YYYY-MM-DD All-In Podcast
            # Date = ingest/posting day (today), not original publish date.
            existing_dir = Path(s["folder"]) if s.get("folder") else None
            if existing_dir is not None and existing_dir.is_dir():
                # Retry / resume: stay in the same folder so leftover picture/audio are reused.
                project_dir = existing_dir
                (project_dir / "clips").mkdir(exist_ok=True)
            else:
                podcast = meta.get("uploader") or nice_title
                project_dir = make_project_dir(
                    VIDEOS,
                    title=nice_title,
                    media_id=meta.get("id"),
                    podcast_name=clean_title(podcast, max_len=50),
                )
            s["folder"] = str(project_dir)
            lib.upsert_source(s)
            _pipeline_stage_end(
                source_id,
                "resolve",
                t_resolve,
                extra={"uploader": meta.get("uploader"), "media_id": meta.get("id")},
            )

            _set_job(
                source_id,
                stage="downloading",
                percent=10,
                message="Downloading video…",
                detail=str(project_dir.name),
            )
            out_tmpl = str(project_dir / "source.mp4")
            video_path = _run_download(body.url, out_tmpl, source_id)

            # Normalize extension to source.mp4 if remuxed oddly
            if video_path.name != "source.mp4" and video_path.suffix.lower() == ".mp4":
                dest = project_dir / "source.mp4"
                if video_path.resolve() != dest.resolve():
                    video_path.replace(dest)
                    video_path = dest

            s["video_path"] = str(video_path)
            s["title"] = nice_title
            lib.upsert_source(s)

        elif body.video_path:
            video_path = Path(body.video_path).expanduser().resolve()
            if not video_path.is_file():
                raise RuntimeError(f"video not found: {video_path}")
            s["video_path"] = str(video_path)
            s["title"] = clean_title(body.title or video_path.stem)
            s["folder"] = str(video_path.parent)
            project_dir = video_path.parent
            (project_dir / "clips").mkdir(exist_ok=True)
        else:
            raise RuntimeError("url or video_path required")

        dur = _ffprobe_duration(video_path)
        if dur is not None:
            s["duration"] = dur
            pipe = _pipeline_get(source_id)
            pipe["audio_duration_s"] = dur
            _pipeline_save(source_id, pipe)
        lib.upsert_source(s)

        json_path = video_path.parent / f"{video_path.stem}.transcript.json"
        txt_path = video_path.parent / f"{video_path.stem}.transcript.txt"

        need_stt = body.force_transcribe or not (json_path.is_file() and txt_path.is_file())
        transcript_source = "reuse"
        if need_stt:
            _set_job(
                source_id,
                stage="transcribing",
                percent=None,
                progress_kind="indeterminate",
                message=f"Transcribing with Whisper ({body.model})… preparing",
                detail="Extracting audio then running local MLX Whisper (no live decode %)",
                elapsed_s=0,
            )
            s["status"] = "transcribing"
            s["model"] = body.model
            lib.upsert_source(s)

            timing = _run_transcribe(
                video_path,
                source_id=source_id,
                model=body.model,
                force=body.force_transcribe,
                duration_s=s.get("duration"),
            )
            transcript_source = (timing or {}).get("source") or "mlx-whisper"
        else:
            t_reuse = _pipeline_stage_start(source_id, "transcribe")
            _set_job(
                source_id,
                stage="transcribing",
                percent=90,
                message="Reusing existing transcript",
            )
            _pipeline_stage_end(
                source_id,
                "transcribe",
                t_reuse,
                extra={"reused": True, "duration_s": 0.0},
            )
            transcript_source = "reuse"

        if not json_path.is_file():
            raise RuntimeError("transcript json missing after STT")

        # Re-read library row so we don't clobber concurrent renames / clips
        s = lib.get_source(source_id) or s
        s["transcript_json"] = str(json_path)
        s["transcript_txt"] = str(txt_path) if txt_path.is_file() else None
        s["video_path"] = str(video_path)
        s["status"] = "ready"
        s["error"] = None
        s["model"] = body.model
        if not s.get("clips"):
            end = min(30.0, float(s.get("duration") or 30.0))
            s["clips"] = [make_clip(title="Clip 1", t_in=0.0, t_out=end)]
        lib.upsert_source(s)
        pipe = _pipeline_finish(
            source_id, ok=True, transcript_source=transcript_source
        )
        detail_bits = ["Transcript ready — create clips in the editor"]
        if pipe.get("total_s") is not None:
            detail_bits.append(f"total {_fmt_dur_short(pipe['total_s'])}")
        stt = (pipe.get("stages") or {}).get("transcribe") or {}
        if stt.get("duration_s") is not None:
            detail_bits.append(f"STT {_fmt_dur_short(stt['duration_s'])}")
        if pipe.get("stt_realtime_factor") is not None:
            detail_bits.append(f"{pipe['stt_realtime_factor']}× realtime")
        _set_job(
            source_id,
            stage="done",
            percent=100,
            progress_kind="measured",
            message="Ready",
            detail=" · ".join(detail_bits),
            eta_s=0,
            elapsed_s=None,
            pipeline=pipe,
        )
    except SourceCancelled:
        return
    except Exception as e:
        if _source_cancelled(source_id):
            return
        # If STT actually wrote a transcript before we failed, prefer ready over error
        try:
            s_chk = lib.get_source(source_id) or s
            healed = _maybe_heal_ready(dict(s_chk))
            if healed.get("status") == "ready":
                _pipeline_finish(source_id, ok=True, transcript_source="healed")
                return
        except Exception:
            pass
        s = lib.get_source(source_id)
        if not s:
            return
        s["status"] = "error"
        s["error"] = str(e)
        lib.upsert_source(s)
        pipe = _pipeline_finish(source_id, ok=False, error=str(e))
        _set_job(source_id, stage="error", percent=0, message=str(e), pipeline=pipe)

@app.post("/api/ingest")
def ingest(body: IngestBody) -> dict[str, Any]:
    body.model = normalize_whisper_model(body.model)
    if not body.url and not body.video_path:
        raise HTTPException(400, "url or video_path required")
    title = clean_title(body.title or body.url or body.video_path or "Untitled")
    source = make_source(title=title[:200], url=body.url, status="pending")
    lib.upsert_source(source)
    _set_job(
        source["id"],
        stage="queued",
        percent=0,
        message="Queued",
        stages=PIPELINE_STAGES,
    )
    t = threading.Thread(target=_run_ingest, args=(source["id"], body), daemon=True)
    t.start()
    return source


_ORPHAN_INGEST_STATUSES = frozenset({"pending", "downloading", "transcribing"})
_ORPHAN_INGEST_MSG = "ingest interrupted — retry download"


def _mark_orphaned_ingests() -> None:
    """Jobs live in memory. After an API restart, leftover downloading rows are dead."""
    for row in lib.list_sources():
        sid = row.get("id")
        if not sid or row.get("status") not in _ORPHAN_INGEST_STATUSES:
            continue
        lib.update_source(
            sid,
            {"status": "error", "error": _ORPHAN_INGEST_MSG},
        )


@app.on_event("startup")
def _on_startup() -> None:
    _mark_orphaned_ingests()


@app.post("/api/sources/{source_id}/retry-download")
def retry_download(source_id: str, model: str | None = None) -> dict[str, Any]:
    """Resume ingest on the same source/folder (picture leftovers reused)."""
    s = lib.get_source(source_id)
    if not s:
        raise HTTPException(404, "source not found")
    url = (s.get("url") or "").strip()
    if not url:
        raise HTTPException(400, "source has no URL to download")
    use_model = normalize_whisper_model(model or s.get("model") or DEFAULT_WHISPER_MODEL)
    s["status"] = "downloading"
    s["error"] = None
    s["model"] = use_model
    lib.upsert_source(s)
    _set_job(
        source_id,
        stage="queued",
        percent=0,
        message="Retrying download…",
        detail=s.get("folder") or url,
        stages=PIPELINE_STAGES,
    )
    body = IngestBody(url=url, title=s.get("title"), model=use_model)
    threading.Thread(target=_run_ingest, args=(source_id, body), daemon=True).start()
    out = lib.get_source(source_id) or s
    with jobs_lock:
        out = {**out, "job": job_status.get(source_id)}
    return out


@app.post("/api/sources/{source_id}/retry-transcribe")
def retry_transcribe(source_id: str, model: str | None = None) -> dict[str, Any]:
    """Resume STT on an existing source video (e.g. after a crash). Does not re-download."""
    s = lib.get_source(source_id)
    if not s:
        raise HTTPException(404, "source not found")
    video = Path(s["video_path"]) if s.get("video_path") else None
    if video is None or not video.is_file():
        folder = Path(s["folder"]) if s.get("folder") else None
        guess = folder / "source.mp4" if folder else None
        if guess is not None and guess.is_file():
            s["video_path"] = str(guess)
            video = guess
            lib.update_source(source_id, {"video_path": str(guess)})
    if video is None or not video.is_file():
        raise HTTPException(400, "source has no video file to transcribe")
    use_model = normalize_whisper_model(model or s.get("model") or DEFAULT_WHISPER_MODEL)

    # Flip status *before* the worker thread so UI poll sees transcribing immediately
    # (no page refresh required).
    s["status"] = "transcribing"
    s["model"] = use_model
    s["error"] = None
    s["title"] = clean_title(s.get("title") or Path(s["video_path"]).stem)
    lib.upsert_source(s)
    _pipeline_begin(
        source_id,
        model=use_model,
        audio_duration_s=s.get("duration"),
        reset=True,
    )
    _set_job(
        source_id,
        stage="transcribing",
        percent=None,
        progress_kind="indeterminate",
        message=f"Transcribing with Whisper ({use_model})… preparing",
        detail="Retry — using existing download",
        stages=PIPELINE_STAGES,
        elapsed_s=0,
    )

    # Keep same source id: run transcribe steps in-thread against existing record
    def _retry() -> None:
        src = lib.get_source(source_id)
        if not src:
            return
        try:
            video_path = Path(src["video_path"])
            dur = _ffprobe_duration(video_path)
            if dur is not None:
                src["duration"] = dur
                pipe = _pipeline_get(source_id)
                pipe["audio_duration_s"] = dur
                _pipeline_save(source_id, pipe)
                lib.upsert_source(src)
            timing = _run_transcribe(
                video_path,
                source_id=source_id,
                model=use_model,
                force=True,
                duration_s=src.get("duration"),
            )
            json_path = video_path.parent / f"{video_path.stem}.transcript.json"
            txt_path = video_path.parent / f"{video_path.stem}.transcript.txt"
            if not json_path.is_file():
                raise RuntimeError("transcript json missing after STT")
            src = lib.get_source(source_id) or src
            src["transcript_json"] = str(json_path)
            src["transcript_txt"] = str(txt_path) if txt_path.is_file() else None
            src["status"] = "ready"
            src["error"] = None
            if not src.get("clips"):
                end = min(30.0, float(src.get("duration") or 30.0))
                src["clips"] = [make_clip(title="Clip 1", t_in=0.0, t_out=end)]
            lib.upsert_source(src)
            pipe = _pipeline_finish(
                source_id,
                ok=True,
                transcript_source=(timing or {}).get("source") or "mlx-whisper",
            )
            detail_bits = ["Ready (retry)"]
            stt = (pipe.get("stages") or {}).get("transcribe") or {}
            if stt.get("duration_s") is not None:
                detail_bits.append(f"STT {_fmt_dur_short(stt['duration_s'])}")
            if pipe.get("stt_realtime_factor") is not None:
                detail_bits.append(f"{pipe['stt_realtime_factor']}× realtime")
            _set_job(
                source_id,
                stage="done",
                percent=100,
                message="Ready",
                detail=" · ".join(detail_bits),
                eta_s=0,
                pipeline=pipe,
            )
        except Exception as e:
            src = lib.get_source(source_id) or src
            src["status"] = "error"
            src["error"] = str(e)
            lib.upsert_source(src)
            pipe = _pipeline_finish(source_id, ok=False, error=str(e))
            _set_job(
                source_id, stage="error", message=str(e), percent=0, pipeline=pipe
            )

    threading.Thread(target=_retry, daemon=True).start()
    # Return current row + job so the client can paint without a second fetch race
    out = lib.get_source(source_id) or s
    with jobs_lock:
        out = {**out, "job": job_status.get(source_id)}
    return out


@app.post("/api/sources/{source_id}/rebuild-audio")
def rebuild_audio(source_id: str) -> dict[str, Any]:
    """Re-fetch sound via ffmpeg HLS and remux onto the existing picture."""
    s = lib.get_source(source_id)
    if not s:
        raise HTTPException(404, "source not found")
    url = (s.get("url") or "").strip()
    if not url:
        raise HTTPException(400, "source has no URL to rebuild audio from")
    folder = Path(s["folder"]) if s.get("folder") else None
    dest = (folder / "source.mp4") if folder else None
    video = Path(s["video_path"]) if s.get("video_path") else None
    if dest is None and video is not None:
        dest = video.parent / "source.mp4"
        folder = video.parent
    if video is None or not video.is_file():
        guesses: list[Path] = []
        if dest is not None:
            guesses.append(dest)
        if folder is not None:
            guesses.extend(sorted(folder.glob(".source.video.tmp.*")))
        for guess in guesses:
            if guess.is_file() and guess.stat().st_size > 1_000_000:
                video = guess
                break
    if dest is None or video is None or not video.is_file():
        raise HTTPException(400, "source has no video file")

    prev_status = s.get("status") or "ready"
    s["status"] = "downloading"
    s["error"] = None
    lib.upsert_source(s)
    _set_job(
        source_id,
        stage="downloading",
        percent=10,
        progress_kind="measured",
        message="Rebuilding audio (ffmpeg HLS)…",
        detail="Keeping the picture; replacing the sound track only",
        stages=PIPELINE_STAGES,
    )

    def _rebuild() -> None:
        src = lib.get_source(source_id)
        if not src:
            return
        try:
            _run_rebuild_audio(source_id, url, dest)
            src = lib.get_source(source_id) or src
            src["video_path"] = str(dest)
            src["error"] = None
            src["updated_at"] = datetime.now(timezone.utc).isoformat()
            if prev_status == "error" and not (dest.parent / f"{dest.stem}.transcript.json").is_file():
                # Picture+sound are on disk; STT still needed.
                src["status"] = "error"
                src["error"] = None
            else:
                src["status"] = prev_status if prev_status != "downloading" else "ready"
            lib.upsert_source(src)
            _set_job(
                source_id,
                stage="done",
                percent=100,
                message="Audio rebuilt. Re-export clips to hear it.",
                detail=str(dest),
            )
        except SourceCancelled:
            return
        except Exception as e:
            if _source_cancelled(source_id):
                return
            src = lib.get_source(source_id)
            if not src:
                return
            src["status"] = "error"
            src["error"] = str(e)
            lib.upsert_source(src)
            _set_job(source_id, stage="error", percent=0, message=str(e))

    threading.Thread(target=_rebuild, daemon=True).start()
    out = lib.get_source(source_id) or s
    with jobs_lock:
        out = {**out, "job": job_status.get(source_id)}
    return out


def _run_rebuild_audio(source_id: str, url: str, video: Path) -> None:
    cmd = [str(DOWNLOAD_SH), "--rebuild-audio", "-o", str(video), url]
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    proc = _popen_tracked(
        source_id,
        cmd,
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )
    tail: list[str] = []
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            if _source_cancelled(source_id):
                raise SourceCancelled(source_id)
            line = line.rstrip()
            if not line:
                continue
            tail.append(line)
            if len(tail) > 30:
                tail = tail[-30:]
            m = re.search(r"\[download\]\s+(\d+(?:\.\d+)?)%", line)
            if m:
                pct = float(m.group(1))
                _set_job(
                    source_id,
                    stage="downloading",
                    percent=min(95, 10 + int(pct * 0.8)),
                    message=f"Rebuilding audio… {pct:.0f}%",
                    detail=line[:160],
                )
            elif "Muxing" in line or "Sound" in line:
                _set_job(
                    source_id,
                    stage="downloading",
                    percent=85,
                    message=line[:120],
                )
        rc = proc.wait()
        if rc != 0:
            hint = "\n".join(tail[-10:]) if tail else f"exit {rc}"
            raise RuntimeError(f"rebuild audio failed (exit {rc})\n{hint}")
    except SourceCancelled:
        try:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, OSError):
            pass
        raise
    finally:
        _untrack_proc(source_id, proc)


@app.post("/api/sources/{source_id}/clips")
def create_clip(source_id: str, body: ClipCreate) -> dict[str, Any]:
    if not lib.get_source(source_id):
        raise HTTPException(404, "source not found")
    clip = make_clip(title=body.title, t_in=body.t_in, t_out=body.t_out)
    clip["notes"] = body.notes
    out = lib.add_clip(source_id, clip)
    if not out:
        raise HTTPException(404, "source not found")
    return out


@app.patch("/api/sources/{source_id}/clips/{clip_id}")
def patch_clip(source_id: str, clip_id: str, body: ClipUpdate) -> dict[str, Any]:
    raw = body.model_dump(exclude_unset=True)
    patch: dict[str, Any] = {}
    for k, v in raw.items():
        # Allow clearing post_text with ""; still skip other explicit nulls
        if v is None and k not in ("captions", "post_text"):
            continue
        if k == "captions":
            patch["captions"] = normalize_cues(v)
        elif k == "post_text":
            patch["post_text"] = "" if v is None else str(v)
        else:
            patch[k] = v
    if not patch:
        raise HTTPException(400, "no fields to update")
    out = lib.update_clip(source_id, clip_id, patch)
    if not out:
        raise HTTPException(404, "clip not found")
    return out


@app.delete("/api/sources/{source_id}/clips/{clip_id}")
def remove_clip(source_id: str, clip_id: str) -> dict[str, str]:
    if not lib.delete_clip(source_id, clip_id):
        raise HTTPException(404, "clip not found")
    return {"status": "deleted"}


@app.post("/api/reveal-path")
def reveal_path(body: dict[str, Any]) -> dict[str, str]:
    """Open a path in Finder (macOS) / file manager — only under videos/."""
    raw = body.get("path") if isinstance(body, dict) else None
    if not raw or not isinstance(raw, str):
        raise HTTPException(400, "path required")
    path = Path(raw).expanduser().resolve()
    try:
        path.relative_to(VIDEOS.resolve())
    except ValueError as e:
        raise HTTPException(400, "path must be under videos/") from e
    if not path.exists():
        raise HTTPException(404, "path not found")
    target = path if path.is_dir() else path.parent
    try:
        if sys.platform == "darwin":
            subprocess.run(["open", str(target)], check=False)
        elif sys.platform.startswith("linux"):
            subprocess.run(["xdg-open", str(target)], check=False)
        else:
            subprocess.run(["explorer", str(target)], check=False)
    except FileNotFoundError as e:
        raise HTTPException(500, f"could not open file manager: {e}") from e
    return {"status": "ok", "opened": str(target)}


def _get_clip(source: dict[str, Any], clip_id: str) -> dict[str, Any] | None:
    for c in source.get("clips") or []:
        if c.get("id") == clip_id:
            return c
    return None


@app.post("/api/sources/{source_id}/clips/{clip_id}/captions/generate")
def generate_clip_captions(source_id: str, clip_id: str) -> dict[str, Any]:
    """
    Slice the source Whisper transcript into clip-relative captions.

    Workflow: still scrub on the **source** video; captions times are 0-based
    from the clip's t_in so they match the exported MP4 and a future burn-in step.
    """
    s = lib.get_source(source_id)
    if not s:
        raise HTTPException(404, "source not found")
    clip = _get_clip(s, clip_id)
    if not clip:
        raise HTTPException(404, "clip not found")
    t_in = float(clip.get("t_in") or 0.0)
    t_out = float(clip.get("t_out") or 0.0)
    if t_out <= t_in:
        raise HTTPException(400, "clip end must be after start")

    tpath = s.get("transcript_json")
    data = _load_transcript(Path(tpath) if tpath else None)
    if not data:
        raise HTTPException(400, "source transcript not ready — ingest/transcribe first")

    segments = data.get("segments") or []
    cues = slice_transcript_to_clip(segments, t_in=t_in, t_out=t_out)
    cues = normalize_cues(cues)
    meta = {
        "t_in": t_in,
        "t_out": t_out,
        "generated_at": _now(),
        "count": len(cues),
        "source": "transcript",
        "cleaned": False,
        "cleaning": False,
        "clean_error": None,
        "clean_model": None,
    }
    out = lib.update_clip(
        source_id,
        clip_id,
        {"captions": cues, "captions_meta": meta},
    )
    if not out:
        raise HTTPException(404, "clip not found")
    return out


@app.put("/api/sources/{source_id}/clips/{clip_id}/captions")
def put_clip_captions(source_id: str, clip_id: str, body: CaptionsPut) -> dict[str, Any]:
    """Save edited clip-relative caption cues (text + timing)."""
    s = lib.get_source(source_id)
    if not s:
        raise HTTPException(404, "source not found")
    clip = _get_clip(s, clip_id)
    if not clip:
        raise HTTPException(404, "clip not found")
    cues = normalize_cues(body.captions)
    meta = dict(clip.get("captions_meta") or {})
    meta.update(
        {
            "count": len(cues),
            "edited_at": _now(),
            "t_in": float(clip.get("t_in") or meta.get("t_in") or 0.0),
            "t_out": float(clip.get("t_out") or meta.get("t_out") or 0.0),
        }
    )
    out = lib.update_clip(
        source_id,
        clip_id,
        {"captions": cues, "captions_meta": meta},
    )
    if not out:
        raise HTTPException(404, "clip not found")
    return out


def _set_export_job(job_id: str, **kwargs: Any) -> None:
    with export_jobs_lock:
        cur = export_jobs.get(job_id, {})
        cur.update(kwargs)
        export_jobs[job_id] = cur


def _probe_video_size(video: Path) -> tuple[int, int]:
    """Return (width, height) for ASS PlayRes; fall back to 1920×1080."""
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=p=0:s=x",
                str(video),
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        line = (r.stdout or "").strip().split("\n")[0]
        if "x" in line:
            w_s, h_s = line.split("x", 1)
            w, h = int(w_s), int(h_s)
            if w > 0 and h > 0:
                return w, h
    except Exception:
        pass
    return 1920, 1080


def _source_audio_is_aac(video: Path) -> bool:
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "csv=p=0",
                str(video),
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
        return (r.stdout or "").strip().split("\n")[0].strip() == "aac"
    except Exception:
        return False


def _export_clip(
    video: Path,
    clip: dict[str, Any],
    out_dir: Path,
    *,
    source_id: str | None = None,
    on_progress: Any | None = None,
    caption_style: dict[str, Any] | None = None,
    burn_captions: bool = True,
) -> Path:
    """Cut a range and re-encode to clean H.264 + AAC (stream-safe for players/X).

    When the clip has cues and burn_captions is True, Pillow plates are burned
    in via a single timed overlay (one ffmpeg input, not one per cue). SRT is
    written separately by the export job.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    from naming import slugify

    safe = slugify(clip.get("title") or "clip", max_len=40) or "clip"
    short = (clip.get("id") or "x")[-6:]
    out = out_dir / "video.mp4"
    t_in = float(clip["t_in"])
    t_out = float(clip["t_out"])
    if t_out <= t_in:
        raise RuntimeError("t_out must be greater than t_in")
    duration = t_out - t_in

    cues = clip.get("captions") or []
    style = normalize_caption_style(caption_style)
    burn_dir: Path | None = None
    overlay_concat: Path | None = None
    if burn_captions and cues:
        play_w, play_h = _probe_video_size(video)
        burn_dir = out_dir / f".burn-{safe}-{short}"
        burn_dir.mkdir(parents=True, exist_ok=True)
        overlay_concat = build_overlay_timeline(
            cues,
            style,
            video_w=play_w,
            video_h=play_h,
            duration=duration,
            work_dir=burn_dir,
        )

    # -ss BEFORE -i: keyframe seek (fast on long sources). Always re-encode
    # audio — `-c:a copy` after an input-seek leaves broken AAC packets that
    # play as static. Caption plates are a single concat overlay (Pillow
    # stills) so hundreds of cues do not open hundreds of PNG decoders.
    # Explicit -map so audio is never dropped. -progress pipe:1 for UI %.
    cmd: list[str] = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{t_in:.3f}",
        "-i",
        str(video),
    ]
    if overlay_concat is not None:
        cmd.extend(
            [
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(overlay_concat),
            ]
        )
    cmd.extend(["-t", f"{duration:.3f}"])

    if overlay_concat is not None:
        # [0:v] source, [1:v] full-frame RGBA timeline. alpha=straight avoids
        # the premultiplied wash that made solid cream/night look translucent.
        cmd.extend(
            [
                "-filter_complex",
                "[1:v]format=rgba,setsar=1,setpts=PTS-STARTPTS[ov];"
                "[0:v][ov]overlay=0:0:format=auto:alpha=straight:eof_action=repeat[v]",
                "-map",
                "[v]",
                "-map",
                "0:a:0?",
            ]
        )
    else:
        cmd.extend(["-map", "0:v:0", "-map", "0:a:0?"])

    cmd.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-af",
            "aresample=async=1:first_pts=0",
            "-avoid_negative_ts",
            "make_zero",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-nostats",
            str(out),
        ]
    )
    proc = (
        _popen_tracked(
            source_id,
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        if source_id
        else subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    )
    assert proc.stdout is not None
    assert proc.stderr is not None
    stderr_chunks: list[str] = []

    def _drain_stderr() -> None:
        try:
            for chunk in proc.stderr:
                stderr_chunks.append(chunk)
        except Exception:
            pass

    drain = threading.Thread(target=_drain_stderr, daemon=True)
    drain.start()

    last_pct = -1
    try:
        for line in proc.stdout:
            if source_id and _source_cancelled(source_id):
                raise SourceCancelled(source_id)
            line = line.strip()
            # ffmpeg -progress keys:
            #   out_time_us = microseconds (preferred)
            #   out_time_ms = ALSO microseconds historically (name is a lie)
            # Treating out_time_ms as real milliseconds makes 1s look like 1000s → 99%.
            if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                raw = line.split("=", 1)[1].strip()
            elif line.startswith("out_time=") and "." in line:
                # out_time=HH:MM:SS.micro
                raw_t = line.split("=", 1)[1].strip()
                try:
                    parts = raw_t.split(":")
                    if len(parts) == 3:
                        secs = (
                            int(parts[0]) * 3600
                            + int(parts[1]) * 60
                            + float(parts[2])
                        )
                        frac = min(0.99, max(0.0, secs / max(duration, 0.001)))
                        pct = int(frac * 100)
                        if on_progress and pct > last_pct:
                            last_pct = pct
                            on_progress(pct, secs)
                except ValueError:
                    pass
                continue
            else:
                continue
            if raw in ("N/A", ""):
                continue
            try:
                val = int(raw)
                if val < 0:
                    continue
                secs = val / 1_000_000.0  # always µs for out_time_us / out_time_ms
                if secs > duration * 1.25:
                    # Unusable spike — skip rather than clamp to 99%
                    continue
                frac = min(0.99, max(0.0, secs / max(duration, 0.001)))
                pct = int(frac * 100)
                # Only advance — never report a lower or equal %
                if on_progress and pct > last_pct:
                    last_pct = pct
                    on_progress(pct, secs)
            except ValueError:
                continue
    except SourceCancelled:
        try:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, OSError):
            pass
        raise
    finally:
        rc = proc.wait()
        drain.join(timeout=5)
        if proc.stdout:
            proc.stdout.close()
        if proc.stderr:
            proc.stderr.close()
        if source_id:
            _untrack_proc(source_id, proc)

    stderr = "".join(stderr_chunks)
    try:
        if rc != 0:
            raise RuntimeError((stderr or "ffmpeg failed")[-2000:])
        if not out.is_file() or out.stat().st_size < 1000:
            raise RuntimeError("export produced empty file")
    finally:
        if burn_dir and burn_dir.is_dir():
            for p in burn_dir.glob("*"):
                try:
                    p.unlink()
                except OSError:
                    pass
            try:
                burn_dir.rmdir()
            except OSError:
                pass

    # Sanity: require an audio stream when the source had one
    try:
        probe = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "csv=p=0",
                str(out),
            ],
            text=True,
        ).strip()
        src_a = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "csv=p=0",
                str(video),
            ],
            text=True,
        ).strip()
        if src_a and not probe:
            raise RuntimeError("export has no audio stream (source had audio)")
    except subprocess.CalledProcessError:
        pass

    if on_progress:
        on_progress(100, duration)
    return out


def _clip_pack_dir(clips_root: Path, index: int, clip: dict[str, Any]) -> Path:
    from naming import slugify

    safe = slugify(clip.get("title") or "clip", max_len=40) or "clip"
    return clips_root / f"{index:02d}-{safe}"


def _write_clip_post_txt(pack: Path, clip: dict[str, Any]) -> Path:
    t_in = float(clip.get("t_in") or 0.0)
    t_out = float(clip.get("t_out") or t_in)
    lines = [
        clip.get("title") or "Untitled clip",
        f"{format_ts_label(t_in)} – {format_ts_label(t_out)}",
        "",
        (clip.get("post_text") or "").strip(),
        "",
    ]
    path = pack / "post.txt"
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return path


def _write_thread_txt(clips_root: Path, source: dict[str, Any], clips: list[dict[str, Any]]) -> Path:
    parts: list[str] = ["# Thread", ""]
    opener = (source.get("summary_post_text") or "").strip()
    if opener:
        parts.extend(["## Opener", "", opener, ""])
    for i, c in enumerate(clips, 1):
        title = c.get("title") or f"clip {i}"
        t_in = float(c.get("t_in") or 0.0)
        t_out = float(c.get("t_out") or t_in)
        parts.extend(
            [
                f"## {i}. {title}",
                f"{format_ts_label(t_in)} – {format_ts_label(t_out)}",
                "",
                (c.get("post_text") or "").strip() or "_(no post)_",
                "",
            ]
        )
    closer = (
        ((source.get("agent_run") or {}).get("closer") or {}).get("post_text")
        or ""
    ).strip()
    if closer:
        parts.extend(["## Closer", "", closer, ""])
    reply = (
        ((source.get("agent_run") or {}).get("reply") or {}).get("post_text")
        or (source.get("reply_post_text") or "")
    ).strip()
    if reply:
        parts.extend(["## Reply under original", "", reply, ""])
    path = clips_root / "thread.txt"
    path.write_text("\n".join(parts).rstrip() + "\n", encoding="utf-8")
    return path


def _run_export_job(
    job_id: str,
    source_id: str,
    video: Path,
    clips: list[dict[str, Any]],
    *,
    caption_style: dict[str, Any] | None = None,
    burn_captions: bool = True,
) -> None:
    clips_root = video.parent / "clips"
    clips_root.mkdir(parents=True, exist_ok=True)
    source = lib.get_source(source_id) or {}
    all_clips = list(source.get("clips") or [])
    id_to_idx = {c.get("id"): i + 1 for i, c in enumerate(all_clips)}
    exported: list[dict[str, Any]] = []
    errors: list[str] = []
    total = len(clips)
    style = normalize_caption_style(caption_style)
    last_pack: Path | None = None

    try:
        for i, c in enumerate(clips):
            title = c.get("title") or c.get("id") or "clip"
            clip_base = (i / total) * 100
            clip_span = 100 / total
            has_cues = bool(c.get("captions"))
            burning = bool(burn_captions and has_cues)

            def on_prog(pct: int, _secs: float, *, _i=i, _title=title, _burn=burning) -> None:
                overall = int(clip_base + (pct / 100.0) * clip_span)
                overall = min(99, max(0, overall))
                detail = (
                    f"H.264 + AAC · burn-in · clip {_i + 1} of {total}"
                    if _burn
                    else f"H.264 + AAC · clip {_i + 1} of {total}"
                )
                # Message has NO percent — UI shows job.percent once.
                short = (_title[:36] + "…") if len(_title) > 37 else _title
                _set_export_job(
                    job_id,
                    status="running",
                    percent=overall,
                    message=f"Encoding {_i + 1}/{total}: “{short}”",
                    detail=detail,
                    current_clip=_i + 1,
                    total_clips=total,
                    clip_percent=pct,
                )

            short_title = (title[:36] + "…") if len(title) > 37 else title
            _set_export_job(
                job_id,
                status="running",
                percent=int(clip_base),
                message=(
                    f"Preparing captions {i + 1}/{total}: “{short_title}”"
                    if burning
                    else f"Encoding {i + 1}/{total}: “{short_title}”"
                ),
                detail=(
                    f"Starting clip {i + 1} of {total}"
                    + (" · rendering caption plates" if burning else "")
                ),
                current_clip=i + 1,
                total_clips=total,
                clip_percent=0,
            )
            try:
                idx = id_to_idx.get(c.get("id"), i + 1)
                pack = _clip_pack_dir(clips_root, idx, c)
                if pack.exists():
                    shutil.rmtree(pack)
                pack.mkdir(parents=True, exist_ok=True)
                last_pack = pack
                _abort_if_cancelled(source_id)
                path = _export_clip(
                    video,
                    c,
                    pack,
                    source_id=source_id,
                    on_progress=on_prog,
                    caption_style=style,
                    burn_captions=burn_captions,
                )
                cues = c.get("captions") or []
                srt_path = None
                if cues:
                    srt_path = pack / "captions.srt"
                    srt_path.write_text(cues_to_srt(cues), encoding="utf-8")
                _write_clip_post_txt(pack, c)
                updated = lib.update_clip(
                    source_id,
                    c["id"],
                    {
                        "status": "rendered",
                        "export_path": str(path),
                        "export_dir": str(pack),
                        **({"captions_srt": str(srt_path)} if srt_path else {}),
                    },
                )
                row = updated or {**c, "export_path": str(path), "status": "rendered"}
                if srt_path:
                    row["captions_srt"] = str(srt_path)
                row["export_dir"] = str(pack)
                exported.append(row)
            except Exception as e:
                errors.append(f"{title}: {e}")

        reveal = clips_root
        if exported and total > 1:
            try:
                _write_thread_txt(clips_root, source, exported)
            except Exception as exc:
                errors.append(f"thread.txt: {exc}")
        elif last_pack is not None:
            reveal = last_pack

        _set_export_job(
            job_id,
            status="done" if exported else "error",
            percent=100 if exported else 0,
            message=(
                f"Exported {len(exported)} clip(s)"
                + (f" · {len(errors)} failed" if errors else "")
            ),
            detail=str(reveal),
            exported=exported,
            errors=errors,
            out_dir=str(reveal),
        )
    except SourceCancelled:
        _set_export_job(
            job_id,
            status="error",
            percent=0,
            message="cancelled — source removed",
            exported=exported,
            errors=errors + ["cancelled — source removed"],
            out_dir=str(clips_root),
        )
    except Exception as e:
        if _source_cancelled(source_id):
            return
        _set_export_job(
            job_id,
            status="error",
            percent=0,
            message=str(e),
            exported=exported,
            errors=errors + [str(e)],
            out_dir=str(clips_root),
        )


@app.post("/api/sources/{source_id}/export")
def export_clips(source_id: str, body: ExportBody = ExportBody()) -> dict[str, Any]:
    """Start an async export job; poll GET /api/export/{job_id} for progress."""
    s = lib.get_source(source_id)
    if not s:
        raise HTTPException(404, "source not found")
    video = Path(s["video_path"]) if s.get("video_path") else None
    if not video or not video.is_file():
        raise HTTPException(400, "source video missing")

    clips = s.get("clips") or []
    if body.clip_ids:
        clips = [c for c in clips if c["id"] in body.clip_ids]
    if not clips:
        raise HTTPException(400, "no clips to export")

    style = normalize_caption_style(body.caption_style)
    burn = bool(body.burn_captions)
    job_id = new_id("exp_")
    _set_export_job(
        job_id,
        id=job_id,
        source_id=source_id,
        status="queued",
        percent=0,
        message=f"Queued {len(clips)} clip(s)…",
        detail="Preparing ffmpeg"
        + (" · burn-in when cues exist" if burn else " · no burn-in"),
        current_clip=0,
        total_clips=len(clips),
        clip_percent=0,
        exported=[],
        errors=[],
        out_dir=str(video.parent / "clips"),
    )
    threading.Thread(
        target=_run_export_job,
        args=(job_id, source_id, video, list(clips)),
        kwargs={"caption_style": style, "burn_captions": burn},
        daemon=True,
    ).start()
    return {
        "job_id": job_id,
        "status": "queued",
        "total_clips": len(clips),
        "burn_captions": burn,
        "caption_style": style,
    }


@app.get("/api/export/{job_id}")
def get_export_job(job_id: str) -> dict[str, Any]:
    with export_jobs_lock:
        job = export_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "export job not found")
    return job


@app.get("/api/media")
def media(path: str) -> FileResponse:
    """Serve a file under videos/ only (path traversal safe)."""
    p = Path(path).expanduser().resolve()
    videos_root = VIDEOS.resolve()
    try:
        p.relative_to(videos_root)
    except ValueError:
        # Also allow absolute paths that are under ROOT/videos via symlink resolution
        if not str(p).startswith(str(videos_root)):
            raise HTTPException(403, "path not under videos/")
    if not p.is_file():
        raise HTTPException(404, "file not found")
    media_type = None
    if p.suffix.lower() in {".mp4", ".m4v"}:
        media_type = "video/mp4"
    elif p.suffix.lower() in {".m4a", ".aac"}:
        media_type = "audio/mp4"
    return FileResponse(p, media_type=media_type)


# Optional: serve built frontend if present
_frontend_dist = ROOT / "app" / "frontend" / "dist"
if _frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_frontend_dist), html=True), name="ui")
