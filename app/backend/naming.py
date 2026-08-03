"""Human-friendly titles and per-source video folder layout."""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path


def clean_title(raw: str, *, max_len: int = 80) -> str:
    """Turn yt-dlp / X garbage titles into something readable."""
    if not raw:
        return "Untitled"
    s = raw.replace("\n", " ").strip()
    # Underscores → spaces (restrict-filenames style)
    s = s.replace("_", " ")
    # Collapse repeated separators
    # Preserve hyphenated brands (All-In) before turning separators into em dashes
    s = re.sub(r"\s*[|–—/]+\s*", " — ", s)
    s = re.sub(r"\s+", " ", s).strip(" -—.")

    # Drop trailing truncated ellipsis junk from long templates
    s = re.sub(r"\s*\.\.\.\s*$", "", s)
    # Remove bracketed ids at end: [2083…]
    s = re.sub(r"\s*\[[^\]]{6,}\]\s*$", "", s)
    # If "Uploader - Uploader - Title" style, drop duplicated left side
    parts = re.split(r"\s+—\s+|\s+-\s+", s, maxsplit=2)
    if len(parts) >= 2 and parts[0].lower() == parts[1].lower():
        s = " — ".join(parts[1:])
    if len(s) > max_len:
        s = s[: max_len - 1].rstrip() + "…"
    return s or "Untitled"


def slugify(raw: str, *, max_len: int = 48) -> str:
    s = clean_title(raw, max_len=200).lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    if not s:
        s = "video"
    return s[:max_len].strip("-")


def ingest_day(*, day: str | None = None) -> str:
    """Folder date prefix: ingest/posting day (today), not the content's original publish date."""
    if day and re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        return day
    return date.today().isoformat()


def safe_folder_name(name: str, *, max_len: int = 60) -> str:
    """Allow spaces; strip characters illegal on macOS/Windows paths."""
    s = clean_title(name, max_len=max_len + 20)
    s = re.sub(r'[/\\:*?"<>|]', "-", s)
    s = re.sub(r"\s+", " ", s).strip(" .")
    if len(s) > max_len:
        s = s[:max_len].rstrip(" .")
    return s or "Podcast"


def make_project_dir(
    videos_root: Path,
    *,
    title: str,
    media_id: str | None,
    podcast_name: str | None = None,
    day: str | None = None,
) -> Path:
    """
    videos/YYYY-MM-DD Podcast Name/

    YYYY-MM-DD is the **ingest / posting day** (default: today), so the library
    groups by when you work on a clip — not when the source was originally published.
    Prefer show/uploader as the podcast name; fall back to cleaned title.
    """
    folder_day = ingest_day(day=day)
    show = safe_folder_name(podcast_name or title, max_len=55)
    base = videos_root / f"{folder_day} {show}"
    if not base.exists():
        base.mkdir(parents=True, exist_ok=True)
        (base / "clips").mkdir(exist_ok=True)
        return base
    # Collision — append short media id
    tail = (media_id or "x")[-8:]
    base = videos_root / f"{folder_day} {show} ({tail})"
    base.mkdir(parents=True, exist_ok=True)
    (base / "clips").mkdir(exist_ok=True)
    return base


def project_source_path(project_dir: Path, ext: str = "mp4") -> Path:
    return project_dir / f"source.{ext.lstrip('.')}"


def project_clips_dir(project_dir: Path) -> Path:
    d = project_dir / "clips"
    d.mkdir(exist_ok=True)
    return d
