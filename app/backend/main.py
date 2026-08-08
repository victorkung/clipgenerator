"""clipgenerator local API — localhost only."""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import threading
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
from agent_io import (  # noqa: E402
    extract_json_object,
    normalize_clip_plan,
    plan_item_to_clip_fields,
    save_clip_plan_copy,
    write_clip_export,
    write_summary_export,
)
from captions import (  # noqa: E402
    cues_to_srt,
    normalize_caption_style,
    normalize_cues,
    prepare_burn_overlays,
    render_caption_plate_image,
    slice_transcript_to_clip,
)
from naming import clean_title, make_project_dir  # noqa: E402
from store import Library, make_clip, make_source, _now, new_id  # noqa: E402

VIDEOS.mkdir(exist_ok=True)
DATA.mkdir(exist_ok=True)

# Agent flow tab (Summary → Clips → Import). Default OFF for open-source / plain API.
# ./scripts/serve.sh sets CLIPGENERATOR_AGENT_FLOW=1 for local daily-driver use.
# Private editorial packs live in prompts/private/ (gitignored) — not required at runtime.
# Whisper models offered in the UI / accepted by the API (daily driver only).
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


AGENT_FLOW_ENABLED = os.environ.get("CLIPGENERATOR_AGENT_FLOW", "0").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

lib = Library(LIBRARY_PATH)
jobs_lock = threading.Lock()
# source_id → {stage, message, percent, stages, detail, eta_s?}
job_status: dict[str, dict[str, Any]] = {}
# export_job_id → progress / result for clip exports
export_jobs: dict[str, dict[str, Any]] = {}
export_jobs_lock = threading.Lock()

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


def _run_download(url: str, out_template: str, source_id: str) -> Path:
    """Run download.sh with a fixed output template; stream progress into job_status."""
    cmd = [str(DOWNLOAD_SH), "-o", out_template, url]
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.Popen(
        cmd,
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )
    last_path: str | None = None
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip()
        if not line:
            continue
        # Progress: [download]  12.3% of …
        m = re.search(r"\[download\]\s+(\d+(?:\.\d+)?)%", line)
        if m:
            pct = float(m.group(1))
            # Download phase maps to ~10–55% of overall pipeline
            overall = 10 + int(pct * 0.45)
            _set_job(
                source_id,
                stage="downloading",
                percent=overall,
                progress_kind="measured",
                message=f"Downloading… {pct:.1f}%",
                detail=line[:160],
            )
        path_m = re.search(r"^Path:\s+(.+)$", line)
        if path_m:
            last_path = path_m.group(1).strip()
        frag_m = re.search(r"frag\s+(\d+)/(\d+)", line)
        if frag_m and not m:
            cur_f, tot_f = int(frag_m.group(1)), max(1, int(frag_m.group(2)))
            pct = 100.0 * cur_f / tot_f
            overall = 10 + int(pct * 0.45)
            _set_job(
                source_id,
                stage="downloading",
                percent=overall,
                progress_kind="measured",
                message=f"Downloading fragments {cur_f}/{tot_f}",
                detail=line[:160],
            )
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"download failed (exit {rc})")
    if last_path and Path(last_path).is_file():
        return Path(last_path)
    # Prefer source.* in template directory
    tmpl_dir = Path(out_template).parent
    candidates = sorted(tmpl_dir.glob("source.*"), key=lambda p: p.stat().st_mtime, reverse=True)
    for c in candidates:
        if c.suffix.lower() in {".mp4", ".mkv", ".webm", ".mov"} and c.is_file():
            return c
    raise RuntimeError("download finished but source video not found")


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

    Not live progress — used only as a rough expectation in the UI.
    Low = healthy machine; high = memory pressure / thermal / longer audio.
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


def _run_transcribe(
    video_path: Path,
    *,
    source_id: str,
    model: str,
    force: bool,
    duration_s: float | None,
) -> None:
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

    # Whisper does not emit decode % over the pipe — do not invent one.
    lo_s, hi_s = _stt_rough_range_s(model, duration_s)
    audio_label = _fmt_dur_short(duration_s)
    rough_label = f"roughly {_fmt_dur_short(lo_s)}–{_fmt_dur_short(hi_s)} total (machine-dependent)"
    started = __import__("time").time()

    stop_hb = threading.Event()

    def heartbeat() -> None:
        while not stop_hb.wait(2.0):
            elapsed = int(__import__("time").time() - started)
            _set_job(
                source_id,
                stage="transcribing",
                # Stage band only — bar is indeterminate in the UI for STT
                percent=None,
                progress_kind="indeterminate",
                message=f"Transcribing with Whisper ({model})… elapsed {_fmt_dur_short(elapsed)}",
                detail=(
                    f"Local MLX Whisper · model {model} · audio {audio_label} · "
                    f"{rough_label} · not live decode progress"
                ),
                elapsed_s=elapsed,
                rough_est_lo_s=lo_s,
                rough_est_hi_s=hi_s,
                eta_s=None,
            )

    # Immediate first paint before subprocess blocks
    _set_job(
        source_id,
        stage="transcribing",
        percent=None,
        progress_kind="indeterminate",
        message=f"Transcribing with Whisper ({model})… starting",
        detail=(
            f"Local MLX Whisper · model {model} · audio {audio_label} · "
            f"{rough_label} · not live decode progress"
        ),
        elapsed_s=0,
        rough_est_lo_s=lo_s,
        rough_est_hi_s=hi_s,
        eta_s=None,
    )

    hb = threading.Thread(target=heartbeat, daemon=True)
    hb.start()
    try:
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        proc = subprocess.run(
            cmd,
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            env=env,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"transcribe failed:\n{(proc.stderr or proc.stdout or '')[-2000:]}"
            )
    finally:
        stop_hb.set()


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
        "agent_flow": AGENT_FLOW_ENABLED,
    }


@app.get("/api/sources")
def list_sources() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for s in lib.list_sources():
        try:
            out.append(_maybe_heal_ready(s))
        except Exception:
            out.append(s)
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


class SourceUpdate(BaseModel):
    title: str | None = None
    podbrief_text: str | None = None
    summary_post_url: str | None = None
    summary_prompt_text: str | None = None
    clip_prompt_text: str | None = None


class ClipPlanImportBody(BaseModel):
    """Grok clip-plan JSON, or raw chat paste containing a fenced JSON block."""

    plan: dict[str, Any] | list[Any] | None = None
    text: str | None = None  # paste fallback


@app.patch("/api/sources/{source_id}")
def patch_source(source_id: str, body: SourceUpdate) -> dict[str, Any]:
    if not lib.get_source(source_id):
        raise HTTPException(404, "source not found")
    patch: dict[str, Any] = {}
    if body.podbrief_text is not None:
        patch["podbrief_text"] = body.podbrief_text
    if body.summary_post_url is not None:
        patch["summary_post_url"] = body.summary_post_url.strip() or None
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
    if not lib.delete_source(source_id):
        raise HTTPException(404, "source not found")
    with jobs_lock:
        job_status.pop(source_id, None)
    return {"status": "deleted"}


def _run_ingest(source_id: str, body: IngestBody) -> None:
    s = lib.get_source(source_id)
    if not s:
        return
    try:
        video_path: Path | None = None
        project_dir: Path | None = None

        if body.url:
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
            lib.upsert_source(s)

            # Prefer channel/uploader as "Podcast Name" in folder: YYYY-MM-DD All-In Podcast
            # Date = ingest/posting day (today), not original publish date.
            podcast = meta.get("uploader") or nice_title
            project_dir = make_project_dir(
                VIDEOS,
                title=nice_title,
                media_id=meta.get("id"),
                podcast_name=clean_title(podcast, max_len=50),
            )
            s["folder"] = str(project_dir)
            lib.upsert_source(s)

            _set_job(
                source_id,
                stage="downloading",
                percent=10,
                message="Downloading video…",
                detail=str(project_dir.name),
            )
            out_tmpl = str(project_dir / "source.%(ext)s")
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
        lib.upsert_source(s)

        json_path = video_path.parent / f"{video_path.stem}.transcript.json"
        txt_path = video_path.parent / f"{video_path.stem}.transcript.txt"

        need_stt = body.force_transcribe or not (json_path.is_file() and txt_path.is_file())
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

            _run_transcribe(
                video_path,
                source_id=source_id,
                model=body.model,
                force=body.force_transcribe,
                duration_s=s.get("duration"),
            )
        else:
            _set_job(
                source_id,
                stage="transcribing",
                percent=90,
                message="Reusing existing transcript",
            )

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
        _set_job(
            source_id,
            stage="done",
            percent=100,
            progress_kind="measured",
            message="Ready",
            detail="Transcript ready — create clips in the editor",
            eta_s=0,
            elapsed_s=None,
        )
    except Exception as e:
        # If STT actually wrote a transcript before we failed, prefer ready over error
        try:
            s_chk = lib.get_source(source_id) or s
            healed = _maybe_heal_ready(dict(s_chk))
            if healed.get("status") == "ready":
                return
        except Exception:
            pass
        s = lib.get_source(source_id) or s
        s["status"] = "error"
        s["error"] = str(e)
        lib.upsert_source(s)
        _set_job(source_id, stage="error", percent=0, message=str(e))


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

@app.post("/api/sources/{source_id}/retry-transcribe")
def retry_transcribe(source_id: str, model: str | None = None) -> dict[str, Any]:
    """Resume STT on an existing source video (e.g. after a crash). Does not re-download."""
    s = lib.get_source(source_id)
    if not s:
        raise HTTPException(404, "source not found")
    if not s.get("video_path") or not Path(s["video_path"]).is_file():
        raise HTTPException(400, "source has no video file to transcribe")
    use_model = normalize_whisper_model(model or s.get("model") or DEFAULT_WHISPER_MODEL)
    body = IngestBody(
        video_path=s["video_path"],
        model=use_model,
        title=s.get("title"),
        force_transcribe=True,
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
            src["status"] = "transcribing"
            src["model"] = use_model
            src["error"] = None
            # Clean title if still ugly
            src["title"] = clean_title(src.get("title") or video_path.stem)
            lib.upsert_source(src)
            _set_job(
                source_id,
                stage="transcribing",
                percent=None,
                progress_kind="indeterminate",
                message=f"Transcribing with Whisper ({use_model})… preparing",
                detail="Retry — using existing download (no live decode %)",
                stages=PIPELINE_STAGES,
                elapsed_s=0,
            )
            _run_transcribe(
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
            _set_job(
                source_id,
                stage="done",
                percent=100,
                message="Ready",
                eta_s=0,
            )
        except Exception as e:
            src = lib.get_source(source_id) or src
            src["status"] = "error"
            src["error"] = str(e)
            lib.upsert_source(src)
            _set_job(source_id, stage="error", message=str(e), percent=0)

    threading.Thread(target=_retry, daemon=True).start()
    return {"status": "transcribing", "id": source_id, "model": use_model}


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


def _project_dir_for_source(s: dict[str, Any]) -> Path:
    folder = s.get("folder")
    video = Path(s["video_path"]) if s.get("video_path") else None
    project_dir = Path(folder) if folder else (video.parent if video else None)
    if not project_dir or not project_dir.is_dir():
        raise HTTPException(400, "source folder missing on disk")
    return project_dir


def _ready_source_with_transcript(source_id: str) -> tuple[dict[str, Any], dict[str, Any], Path]:
    s = lib.get_source(source_id)
    if not s:
        raise HTTPException(404, "source not found")
    if s.get("status") != "ready":
        raise HTTPException(400, "source not ready — wait for transcript")
    project_dir = _project_dir_for_source(s)
    tpath = s.get("transcript_json")
    data = _load_transcript(Path(tpath) if tpath else None)
    if not data:
        raise HTTPException(400, "transcript not ready")
    return s, data, project_dir


@app.post("/api/sources/{source_id}/agent-export/summary")
def export_summary_package(source_id: str) -> dict[str, Any]:
    """Write agent-export/summary/ for the Grok Summary project."""
    s, data, project_dir = _ready_source_with_transcript(source_id)
    written = write_summary_export(
        s,
        segments=data.get("segments") or [],
        project_dir=project_dir,
    )
    return {
        "status": "ok",
        "kind": "summary",
        "dir": written["dir"],
        "root": written["root"],
        "files": written["files"],
        "message": "Summary package ready — drag into the Summary Grok project",
    }


@app.post("/api/sources/{source_id}/agent-export/clip")
def export_clip_package(source_id: str) -> dict[str, Any]:
    """Write agent-export/clip/ for the Grok Clipping project (needs summary_post_url)."""
    s, data, project_dir = _ready_source_with_transcript(source_id)
    try:
        written = write_clip_export(
            s,
            segments=data.get("segments") or [],
            project_dir=project_dir,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {
        "status": "ok",
        "kind": "clip",
        "dir": written["dir"],
        "root": written["root"],
        "files": written["files"],
        "message": "Clip package ready — drag into the Clipping Grok project",
    }


@app.post("/api/sources/{source_id}/agent-brief")
@app.post("/api/sources/{source_id}/agent-export")
def export_agent_packages_legacy(source_id: str) -> dict[str, Any]:
    """Legacy: export summary (always) + clip if summary_post_url is set."""
    s, data, project_dir = _ready_source_with_transcript(source_id)
    summary = write_summary_export(
        s,
        segments=data.get("segments") or [],
        project_dir=project_dir,
    )
    clip = None
    clip_error = None
    try:
        clip = write_clip_export(
            s,
            segments=data.get("segments") or [],
            project_dir=project_dir,
        )
    except ValueError as e:
        clip_error = str(e)
    return {
        "status": "ok",
        "dir": str(project_dir / "agent-export"),
        "summary_dir": summary["dir"],
        "clip_dir": clip["dir"] if clip else None,
        "files": {
            "summary": summary["files"],
            "clip": clip["files"] if clip else {},
        },
        "clip_error": clip_error,
        "message": "Agent export written (summary always; clip only if summary_post_url set)",
    }


@app.post("/api/sources/{source_id}/clip-plan/import")
def import_clip_plan(source_id: str, body: ClipPlanImportBody) -> dict[str, Any]:
    """
    Create clips from a Grok clip-plan JSON (or chat paste containing a JSON block).
    Does not re-encode video — use Export after reviewing on the timeline.
    """
    s = lib.get_source(source_id)
    if not s:
        raise HTTPException(404, "source not found")

    raw_text = body.text
    try:
        if body.plan is not None:
            raw_plan: Any = body.plan
        elif body.text:
            raw_plan = extract_json_object(body.text)
        else:
            raise HTTPException(400, "provide plan JSON or text paste")
        plan = normalize_clip_plan(raw_plan)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    # Persist for audit / re-import (best-effort)
    plan_path = None
    try:
        project_dir = _project_dir_for_source(s)
        plan_path = save_clip_plan_copy(project_dir, plan, raw_text=raw_text)
    except Exception:
        plan_path = None

    created: list[dict[str, Any]] = []
    errors: list[str] = []
    for i, item in enumerate(plan["clips"]):
        label = (
            (item.get("title") if isinstance(item, dict) else None) or f"clip {i + 1}"
        )
        try:
            fields = plan_item_to_clip_fields(item)
            clip = make_clip(
                title=fields.pop("title"),
                t_in=fields.pop("t_in"),
                t_out=fields.pop("t_out"),
            )
            clip.update(fields)
            out = lib.add_clip(source_id, clip)
            if out:
                created.append(out)
            else:
                errors.append(f"{label}: source missing")
        except (ValueError, TypeError, KeyError) as e:
            errors.append(f"{label}: {e}")

    if not created and errors:
        raise HTTPException(400, "; ".join(errors))

    refreshed = lib.get_source(source_id)
    return {
        "status": "ok",
        "created": len(created),
        "clips": created,
        "errors": errors,
        "source": refreshed,
        "plan_notes": plan.get("notes"),
        "plan_path": plan_path,
        "summary": [
            {
                "id": c.get("id"),
                "title": c.get("title"),
                "t_in": c.get("t_in"),
                "t_out": c.get("t_out"),
                "has_post": bool((c.get("post_text") or "").strip()),
            }
            for c in created
        ],
    }


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
    meta = {
        "t_in": t_in,
        "t_out": t_out,
        "generated_at": _now(),
        "count": len(cues),
        "source": "transcript",
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


def _export_clip(
    video: Path,
    clip: dict[str, Any],
    out_dir: Path,
    *,
    on_progress: Any | None = None,
    caption_style: dict[str, Any] | None = None,
    burn_captions: bool = True,
) -> Path:
    """Cut a range and re-encode to clean H.264 + AAC (stream-safe for players/X).

    When the clip has cues and burn_captions is True, styled ASS is burned in
    during the same encode. SRT is written separately by the export job.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    from naming import slugify

    safe = slugify(clip.get("title") or "clip", max_len=40) or "clip"
    # Last 6 chars of clip id — keeps filenames unique if two clips share a title
    short = (clip.get("id") or "x")[-6:]
    out = out_dir / f"{safe}-{short}.mp4"
    t_in = float(clip["t_in"])
    t_out = float(clip["t_out"])
    if t_out <= t_in:
        raise RuntimeError("t_out must be greater than t_in")
    duration = t_out - t_in

    cues = clip.get("captions") or []
    style = normalize_caption_style(caption_style)
    burn_dir: Path | None = None
    overlays: list[dict[str, Any]] = []
    if burn_captions and cues:
        play_w, play_h = _probe_video_size(video)
        burn_dir = out_dir / f".burn-{safe}-{short}"
        burn_dir.mkdir(parents=True, exist_ok=True)
        overlays = prepare_burn_overlays(
            cues, style, video_w=play_w, video_h=play_h, work_dir=burn_dir
        )

    # -ss BEFORE -i: keyframe seek (fast on long sources). Re-encode below keeps
    # A/V usable. Caption plates are PNG overlays timed to clip-relative cues
    # (Pillow) — works without libass. Explicit -map so audio is never dropped.
    # -progress pipe:1 emits out_time_ms=… for UI percent.
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
    for ov in overlays:
        # Finite still so overlay doesn't hang the graph
        cmd.extend(["-loop", "1", "-t", f"{duration:.3f}", "-i", str(ov["path"])])
    cmd.extend(["-t", f"{duration:.3f}"])

    if overlays:
        # [0:v] base, [1:v]… plate stills. Chain overlays with enable=between.
        # Plates are fully opaque RGB (alpha 0 or 255 only). alpha=straight avoids
        # premultiplied wash that made solid cream/night look translucent.
        n = len(overlays)
        filter_parts: list[str] = []
        for i in range(n):
            filter_parts.append(f"[{i + 1}:v]format=rgba,setsar=1[p{i}]")
        prev = "[0:v]"
        for i, ov in enumerate(overlays):
            out_label = "[v]" if i == n - 1 else f"[v{i}]"
            # times are clip-relative; -ss before -i means timeline starts at 0
            # Commas escaped for filtergraph
            en = f"between(t\\,{ov['start']:.3f}\\,{ov['end']:.3f})"
            filter_parts.append(
                f"{prev}[p{i}]overlay={ov['x']}:{ov['y']}"
                f":format=auto:alpha=straight:enable='{en}'{out_label}"
            )
            prev = out_label
        filter_complex = ";".join(filter_parts)
        cmd.extend(
            [
                "-filter_complex",
                filter_complex,
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
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-nostats",
            str(out),
        ]
    )
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
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
    finally:
        rc = proc.wait()
        drain.join(timeout=5)
        if proc.stdout:
            proc.stdout.close()
        if proc.stderr:
            proc.stderr.close()

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


def _run_export_job(
    job_id: str,
    source_id: str,
    video: Path,
    clips: list[dict[str, Any]],
    *,
    caption_style: dict[str, Any] | None = None,
    burn_captions: bool = True,
) -> None:
    out_dir = video.parent / "clips"
    exported: list[dict[str, Any]] = []
    errors: list[str] = []
    total = len(clips)
    style = normalize_caption_style(caption_style)

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
                path = _export_clip(
                    video,
                    c,
                    out_dir,
                    on_progress=on_prog,
                    caption_style=style,
                    burn_captions=burn_captions,
                )
                cues = c.get("captions") or []
                srt_path = None
                # Always write SRT when cues exist (sidecar for edit / accessibility)
                if cues:
                    srt_path = path.with_suffix(".srt")
                    srt_path.write_text(cues_to_srt(cues), encoding="utf-8")
                updated = lib.update_clip(
                    source_id,
                    c["id"],
                    {
                        "status": "rendered",
                        "export_path": str(path),
                        **({"captions_srt": str(srt_path)} if srt_path else {}),
                    },
                )
                row = updated or {**c, "export_path": str(path), "status": "rendered"}
                if srt_path:
                    row["captions_srt"] = str(srt_path)
                exported.append(row)
            except Exception as e:
                errors.append(f"{title}: {e}")

        _set_export_job(
            job_id,
            status="done" if exported else "error",
            percent=100 if exported else 0,
            message=(
                f"Exported {len(exported)} clip(s)"
                + (f" · {len(errors)} failed" if errors else "")
            ),
            detail=str(out_dir),
            exported=exported,
            errors=errors,
            out_dir=str(out_dir),
        )
    except Exception as e:
        _set_export_job(
            job_id,
            status="error",
            percent=0,
            message=str(e),
            exported=exported,
            errors=errors + [str(e)],
            out_dir=str(out_dir),
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
    return FileResponse(p)


# Optional: serve built frontend if present
_frontend_dist = ROOT / "app" / "frontend" / "dist"
if _frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_frontend_dist), html=True), name="ui")
