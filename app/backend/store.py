"""JSON library store: sources and many clips per source."""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str = "") -> str:
    u = uuid.uuid4().hex[:12]
    return f"{prefix}{u}" if prefix else u


class Library:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.is_file():
            self._write({"version": 1, "sources": []})

    def _read(self) -> dict[str, Any]:
        with self.path.open(encoding="utf-8") as f:
            return json.load(f)

    def _write(self, data: dict[str, Any]) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(self.path)

    def list_sources(self) -> list[dict[str, Any]]:
        with _lock:
            return list(self._read().get("sources") or [])

    def get_source(self, source_id: str) -> dict[str, Any] | None:
        with _lock:
            for s in self._read().get("sources") or []:
                if s.get("id") == source_id:
                    return s
        return None

    def upsert_source(self, source: dict[str, Any]) -> dict[str, Any]:
        with _lock:
            data = self._read()
            sources = data.setdefault("sources", [])
            for i, s in enumerate(sources):
                if s.get("id") == source["id"]:
                    sources[i] = source
                    self._write(data)
                    return source
            sources.insert(0, source)
            self._write(data)
            return source

    def delete_source(self, source_id: str) -> bool:
        with _lock:
            data = self._read()
            before = len(data.get("sources") or [])
            data["sources"] = [s for s in (data.get("sources") or []) if s.get("id") != source_id]
            self._write(data)
            return len(data["sources"]) < before

    def update_source(self, source_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        with _lock:
            data = self._read()
            for i, s in enumerate(data.get("sources") or []):
                if s.get("id") != source_id:
                    continue
                s = {**s, **patch, "updated_at": _now()}
                data["sources"][i] = s
                self._write(data)
                return s
        return None

    def add_clip(self, source_id: str, clip: dict[str, Any]) -> dict[str, Any] | None:
        with _lock:
            data = self._read()
            for s in data.get("sources") or []:
                if s.get("id") == source_id:
                    clips = s.setdefault("clips", [])
                    clips.append(clip)
                    s["updated_at"] = _now()
                    self._write(data)
                    return clip
        return None

    def update_clip(self, source_id: str, clip_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        with _lock:
            data = self._read()
            for s in data.get("sources") or []:
                if s.get("id") != source_id:
                    continue
                for i, c in enumerate(s.get("clips") or []):
                    if c.get("id") == clip_id:
                        c = {**c, **patch, "updated_at": _now()}
                        s["clips"][i] = c
                        s["updated_at"] = _now()
                        self._write(data)
                        return c
        return None

    def delete_clip(self, source_id: str, clip_id: str) -> bool:
        with _lock:
            data = self._read()
            for s in data.get("sources") or []:
                if s.get("id") != source_id:
                    continue
                before = len(s.get("clips") or [])
                s["clips"] = [c for c in (s.get("clips") or []) if c.get("id") != clip_id]
                s["updated_at"] = _now()
                self._write(data)
                return len(s["clips"]) < before
        return False


def make_source(
    *,
    title: str,
    url: str | None = None,
    video_path: str | None = None,
    status: str = "pending",
) -> dict[str, Any]:
    now = _now()
    return {
        "id": new_id("src_"),
        "title": title,
        "url": url,
        "video_path": video_path,
        "folder": None,  # videos/YYYY-MM-DD_slug/
        "transcript_json": None,
        "transcript_txt": None,
        "duration": None,
        "status": status,  # pending | downloading | transcribing | ready | error
        "error": None,
        "model": None,
        "clips": [],
        "created_at": now,
        "updated_at": now,
    }


def make_clip(
    *,
    title: str = "Untitled clip",
    t_in: float = 0.0,
    t_out: float = 0.0,
) -> dict[str, Any]:
    now = _now()
    return {
        "id": new_id("clip_"),
        "title": title,
        "t_in": float(t_in),
        "t_out": float(t_out),
        "notes": "",
        "status": "draft",  # draft | rendered
        "export_path": None,
        "created_at": now,
        "updated_at": now,
    }
