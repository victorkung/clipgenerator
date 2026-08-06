"""clipgenerator local API — localhost only."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
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
from captions import cues_to_srt, normalize_cues, slice_transcript_to_clip  # noqa: E402
from naming import clean_title, make_project_dir  # noqa: E402
from store import Library, make_clip, make_source, _now, new_id  # noqa: E402

VIDEOS.mkdir(exist_ok=True)
DATA.mkdir(exist_ok=True)

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
        cur.update(kwargs)
        job_status[source_id] = cur


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

    # Rough wall-clock estimate: medium ~4–8× realtime on Apple Silicon after load
    # Wall-time factor vs audio duration (segment-only STT on M-series; rough)
    rt = {
        "tiny": 0.04,
        "small": 0.06,
        "small.en": 0.05,
        "medium": 0.12,
        "turbo": 0.08,
        "large-v3-turbo": 0.08,
        "distil-large-v3": 0.07,
        "large-v3": 0.25,
    }.get(model, 0.1)
    est_s = (duration_s or 3600) * rt + 45  # + model load buffer
    started = __import__("time").time()

    stop_hb = threading.Event()

    def heartbeat() -> None:
        while not stop_hb.wait(2.0):
            elapsed = __import__("time").time() - started
            # Map 0–est into 55–96%
            frac = min(0.97, elapsed / max(est_s, 1))
            overall = 55 + int(frac * 41)
            remain = max(0, int(est_s - elapsed))
            mins, secs = divmod(remain, 60)
            _set_job(
                source_id,
                stage="transcribing",
                percent=overall,
                message=f"Transcribing with Whisper ({model})… ~{mins}m {secs:02d}s left (est.)",
                detail=f"Local MLX Whisper · model {model} · audio ~{int(duration_s or 0)}s",
                eta_s=remain,
                elapsed_s=int(elapsed),
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
    model: str = "small"
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


class CaptionsPut(BaseModel):
    """Full replace of clip-relative caption cues."""

    captions: list[dict[str, Any]] = Field(default_factory=list)


class ExportBody(BaseModel):
    clip_ids: list[str] | None = None  # None = all clips on source


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
    return lib.list_sources()


@app.get("/api/sources/{source_id}")
def get_source(source_id: str) -> dict[str, Any]:
    s = lib.get_source(source_id)
    if not s:
        raise HTTPException(404, "source not found")
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


@app.patch("/api/sources/{source_id}")
def patch_source(source_id: str, body: SourceUpdate) -> dict[str, Any]:
    if not lib.get_source(source_id):
        raise HTTPException(404, "source not found")
    patch: dict[str, Any] = {}
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
                percent=55,
                message=f"Transcribing with Whisper ({body.model})…",
                detail="Extracting audio then running local MLX Whisper",
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

        s["transcript_json"] = str(json_path)
        s["transcript_txt"] = str(txt_path) if txt_path.is_file() else None
        s["status"] = "ready"
        s["error"] = None
        s["model"] = body.model
        if not s.get("clips"):
            end = min(30.0, float(s["duration"] or 30.0))
            s["clips"] = [make_clip(title="Clip 1", t_in=0.0, t_out=end)]
        lib.upsert_source(s)
        _set_job(
            source_id,
            stage="done",
            percent=100,
            message="Ready",
            detail="Transcript ready — create clips in the editor",
            eta_s=0,
        )
    except Exception as e:
        s = lib.get_source(source_id) or s
        s["status"] = "error"
        s["error"] = str(e)
        lib.upsert_source(s)
        _set_job(source_id, stage="error", percent=0, message=str(e))


@app.post("/api/ingest")
def ingest(body: IngestBody) -> dict[str, Any]:
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
    use_model = model or s.get("model") or "small"
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
                percent=55,
                message=f"Transcribing with Whisper ({use_model})…",
                detail="Retry — using existing download",
                stages=PIPELINE_STAGES,
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
        if v is None and k != "captions":
            continue
        if k == "captions":
            patch["captions"] = normalize_cues(v)
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


def _export_clip(
    video: Path,
    clip: dict[str, Any],
    out_dir: Path,
    *,
    on_progress: Any | None = None,
) -> Path:
    """Cut a range and re-encode to clean H.264 + AAC (stream-safe for players/X)."""
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

    # -ss BEFORE -i: keyframe seek (fast on long sources). Re-encode below keeps
    # A/V usable; post-input -ss was accurate but decoded from 0→t_in first, which
    # hung multi-hour exports and never emitted progress until seek finished.
    # Explicit -map so audio is never dropped. Avoid h264_videotoolbox —
    # corrupt frames / silent AAC on some X downloads.
    # -progress pipe:1 emits out_time_ms=… for UI percent.
    # Always drain stderr on a thread: if both pipes fill, ffmpeg deadlocks.
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{t_in:.3f}",
        "-i",
        str(video),
        "-t",
        f"{duration:.3f}",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
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
            if not line.startswith("out_time_ms="):
                continue
            raw = line.split("=", 1)[1].strip()
            if raw in ("N/A", ""):
                continue
            try:
                # ffmpeg may report microseconds as int; treat as µs if huge
                val = int(raw)
                if val > 10_000_000_000:  # absurd — skip
                    continue
                # out_time_ms is milliseconds in modern ffmpeg
                secs = val / 1000.0
                if secs > duration * 50:  # wrong unit (µs) fallback
                    secs = val / 1_000_000.0
                frac = min(0.99, max(0.0, secs / max(duration, 0.001)))
                pct = int(frac * 100)
                if on_progress and pct != last_pct:
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
    if rc != 0:
        raise RuntimeError((stderr or "ffmpeg failed")[-2000:])
    if not out.is_file() or out.stat().st_size < 1000:
        raise RuntimeError("export produced empty file")

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
) -> None:
    out_dir = video.parent / "clips"
    exported: list[dict[str, Any]] = []
    errors: list[str] = []
    total = len(clips)

    try:
        for i, c in enumerate(clips):
            title = c.get("title") or c.get("id") or "clip"
            clip_base = (i / total) * 100
            clip_span = 100 / total

            def on_prog(pct: int, _secs: float, *, _i=i, _title=title) -> None:
                overall = int(clip_base + (pct / 100.0) * clip_span)
                _set_export_job(
                    job_id,
                    status="running",
                    percent=min(99, overall),
                    message=f"Encoding {_i + 1}/{total}: “{_title}”… {pct}%",
                    detail=f"H.264 + AAC · clip {_i + 1} of {total}",
                    current_clip=_i + 1,
                    total_clips=total,
                    clip_percent=pct,
                )

            _set_export_job(
                job_id,
                status="running",
                percent=int(clip_base),
                message=f"Encoding {i + 1}/{total}: “{title}”…",
                detail=f"Starting clip {i + 1} of {total}",
                current_clip=i + 1,
                total_clips=total,
                clip_percent=0,
            )
            try:
                path = _export_clip(video, c, out_dir, on_progress=on_prog)
                cues = c.get("captions") or []
                srt_path = None
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

    job_id = new_id("exp_")
    _set_export_job(
        job_id,
        id=job_id,
        source_id=source_id,
        status="queued",
        percent=0,
        message=f"Queued {len(clips)} clip(s)…",
        detail="Preparing ffmpeg",
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
        daemon=True,
    ).start()
    return {"job_id": job_id, "status": "queued", "total_clips": len(clips)}


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
