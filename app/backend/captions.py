"""Clip-scoped captions: slice source transcript into clip-relative cues."""

from __future__ import annotations

import re
from typing import Any

from store import new_id


def _seg_bounds(seg: dict[str, Any]) -> tuple[float, float]:
    start = float(seg.get("start") or 0.0)
    end = seg.get("end")
    if end is None:
        end = start + 0.01
    else:
        end = float(end)
    if end < start:
        end = start
    return start, end


def slice_transcript_to_clip(
    segments: list[dict[str, Any]] | None,
    *,
    t_in: float,
    t_out: float,
    min_dur: float = 0.12,
) -> list[dict[str, Any]]:
    """
    Build caption cues for a clip range.

    Times are **clip-relative** (0.0 = clip start on the exported file).
    Overlapping source segments are clipped to [t_in, t_out].
    """
    if t_out <= t_in:
        return []
    cues: list[dict[str, Any]] = []
    for seg in segments or []:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        s0, s1 = _seg_bounds(seg)
        if s1 <= t_in or s0 >= t_out:
            continue
        rel_start = max(0.0, s0 - t_in)
        rel_end = min(t_out - t_in, s1 - t_in)
        if rel_end - rel_start < min_dur:
            continue
        cues.append(
            {
                "id": new_id("cap_"),
                "start": round(rel_start, 3),
                "end": round(rel_end, 3),
                "text": text,
            }
        )
    return cues


def srt_timestamp(seconds: float) -> str:
    s = max(0.0, float(seconds))
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = int(s % 60)
    ms = int(round((s - int(s)) * 1000))
    if ms >= 1000:
        ms = 0
        sec += 1
    return f"{h:02d}:{m:02d}:{sec:02d},{ms:03d}"


def cues_to_srt(cues: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    n = 0
    for c in cues:
        text = (c.get("text") or "").strip()
        if not text:
            continue
        n += 1
        start = float(c.get("start") or 0.0)
        end = float(c.get("end") or start + 0.5)
        if end <= start:
            end = start + 0.5
        lines.append(str(n))
        lines.append(f"{srt_timestamp(start)} --> {srt_timestamp(end)}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines).rstrip() + ("\n" if lines else "")


def normalize_cues(raw: list[Any] | None) -> list[dict[str, Any]]:
    """Validate / clean cues from a client PATCH."""
    out: list[dict[str, Any]] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        text = re.sub(r"\s+", " ", str(item.get("text") or "")).strip()
        try:
            start = float(item.get("start") or 0.0)
            end = float(item.get("end") if item.get("end") is not None else start + 0.5)
        except (TypeError, ValueError):
            continue
        if end <= start:
            end = start + 0.5
        cid = item.get("id")
        if not cid or not isinstance(cid, str):
            cid = new_id("cap_")
        out.append(
            {
                "id": cid,
                "start": round(max(0.0, start), 3),
                "end": round(max(0.0, end), 3),
                "text": text,
            }
        )
    out.sort(key=lambda c: (c["start"], c["end"]))
    return out
