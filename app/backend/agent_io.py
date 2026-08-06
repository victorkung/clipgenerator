"""Agent export + clip-plan import (Grok web ↔ clipgenerator handoff)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def format_ts_label(seconds: float) -> str:
    s = max(0.0, float(seconds))
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = int(s % 60)
    if h > 0:
        return f"{h}:{m:02d}:{sec:02d}"
    return f"{m}:{sec:02d}"


def parse_ts_label(label: str | None) -> float | None:
    """Parse M:SS / H:MM:SS / plain seconds into float seconds."""
    if label is None:
        return None
    raw = str(label).strip()
    if not raw:
        return None
    if re.fullmatch(r"\d+(\.\d+)?", raw):
        return float(raw)
    parts = raw.split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        return None
    if len(nums) == 3:
        return nums[0] * 3600 + nums[1] * 60 + nums[2]
    if len(nums) == 2:
        return nums[0] * 60 + nums[1]
    return None


def segments_to_transcript_md(segments: list[dict[str, Any]] | None) -> str:
    lines: list[str] = [
        "# Full transcript",
        "",
        "Timestamps are source-relative (0 = start of video).",
        "",
    ]
    for seg in segments or []:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        start = float(seg.get("start") or 0.0)
        end = seg.get("end")
        end_f = float(end) if end is not None else start
        label = f"{format_ts_label(start)}–{format_ts_label(end_f)}"
        lines.append(f"**[{label}]** ({start:.2f}s–{end_f:.2f}s)")
        lines.append(text)
        lines.append("")
    if len(lines) <= 4:
        lines.append("_(no segments)_")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _meta_lines(source: dict[str, Any]) -> list[str]:
    url = (source.get("url") or "").strip() or "_(no URL on source)_"
    title = (source.get("title") or "").strip() or "Untitled"
    duration = source.get("duration")
    dur_line = (
        f"{format_ts_label(float(duration))} ({float(duration):.1f}s)"
        if duration is not None
        else "_(unknown)_"
    )
    return [
        f"**Title:** {title}",
        f"**Source URL:** {url}",
        f"**Duration:** {dur_line}",
        f"**Source id:** `{source.get('id') or ''}`",
    ]


def build_clip_reference_md(source: dict[str, Any]) -> str:
    """Clip agent: source URL + summary post URL for quote targeting."""
    summary_url = (source.get("summary_post_url") or "").strip()
    summary_line = summary_url or "_(missing — required for clip export)_"
    return "\n".join(
        [
            "# Reference (clip agent)",
            "",
            *_meta_lines(source),
            "",
            f"**Summary post URL (quote target):** {summary_line}",
            "",
            "Open the **Source URL** for episode context and handles.",
            "Clips are posted as **quotes of the summary post** (primary).",
            "The URL is enough for the original episode — do not request a full post-body dump.",
            "",
        ]
    )


def build_clip_prompt_md(source: dict[str, Any]) -> str:
    duration = source.get("duration")
    length_note = "_(unknown — infer from transcript)_"
    volume = "present **top 3–4** (episode ≤ ~2 hours rule)"
    if duration is not None:
        d = float(duration)
        length_note = f"{format_ts_label(d)} ({d / 3600:.2f} h)"
        if d > 2 * 3600:
            volume = "present **at least 5–6** (episode > ~2 hours rule)"
        else:
            volume = "present **top 3–4** (episode ≤ ~2 hours rule)"

    summary_url = (source.get("summary_post_url") or "").strip()
    summary_block = summary_url or "_(paste summary post URL into clipgenerator before export)_"

    return "\n".join(
        [
            "# Episode task (clip agent)",
            "",
            "Follow the Clipping project **custom instructions**.",
            "",
            f"**Episode length:** {length_note}",
            f"**Shortlist rule for this episode:** {volume}",
            "",
            "## Distribution",
            "",
            f"**Primary quote target (summary post):** {summary_block}",
            "",
            "Draft clip posts to be published as **quotes of that summary post**.",
            "Secondary options only if the user asks (standalone / quote original episode).",
            "",
            "## Process (mandatory)",
            "",
            "1. **Shortlist only first** — timestamps + one-line why. No full post drafts yet.",
            "2. After I select clips: work **one clip at a time** until I approve each.",
            "3. I will verify ranges in clipgenerator and give trim feedback.",
            "4. When I say **export for clipgenerator**, output a **minimal** import JSON for **approved clips only** (X only).",
            "   Required per clip: title, t_in/t_out (seconds or labels), post_text. Optional: tags, why.",
            "   Do **not** include TikTok/Shorts/Reels captions, scores, hooks, or other unused packaging fields.",
            "",
            "## Files in this package",
            "",
            "- `01-reference.md` — source URL + summary post URL",
            "- `03-transcript.md` — full timestamped transcript",
            "",
        ]
    )


def build_summary_reference_md(source: dict[str, Any]) -> str:
    url = (source.get("url") or "").strip() or "_(no URL on source)_"
    return "\n".join(
        [
            "# Original X / source post (summary agent)",
            "",
            *_meta_lines(source),
            "",
            "## Original post",
            "",
            url,
            "",
            "Open this URL for the live post, handles, and framing. Extract relevant handles from the page.",
            "",
        ]
    )


def build_summary_prompt_md(source: dict[str, Any]) -> str:
    url = (source.get("url") or "").strip() or "_(see 01-reference.md)_"
    return "\n".join(
        [
            "# New summary request",
            "",
            "Follow the Summary project **custom instructions**.",
            "",
            "## Original X post",
            "",
            url,
            "",
            "## Instructions",
            "",
            "Please draft the recap following the exact current project format:",
            "",
            "1. **Summary post** — to be posted as a **quote** of the original",
            "2. **Reply post** — short teaser reply **under the original** for distribution",
            "",
            "Use the high-level brief (if provided) for themes and the full transcript as the",
            "source of truth for accuracy and timestamps.",
            "",
            "## Files in this package",
            "",
            "- `01-reference.md` — source URL / meta",
            "- `03-transcript.md` — full timestamped transcript",
            "- `04-brief.md` — optional high-level brief (themes) for the summary agent",
            "",
            "We will edit together until both posts are ready for approval.",
            "",
        ]
    )


def build_summary_brief_md(source: dict[str, Any]) -> str:
    body = (source.get("podbrief_text") or "").strip()
    if body:
        content = body
    else:
        content = (
            "_(Paste a high-level brief in clipgenerator Agent flow before exporting "
            "the Summary package. clipgenerator does not generate this brief.)_"
        )
    return "\n".join(
        [
            "# High-level brief",
            "",
            "Themes for the Summary agent (not used by the Clip agent).",
            "",
            content,
            "",
        ]
    )


def _write_dir(out_dir: Path, files: dict[str, str]) -> dict[str, str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, str] = {}
    for name, body in files.items():
        p = out_dir / name
        p.write_text(body, encoding="utf-8")
        paths[name] = str(p)
    return paths


def write_summary_export(
    source: dict[str, Any],
    *,
    segments: list[dict[str, Any]] | None,
    project_dir: Path,
) -> dict[str, Any]:
    """Write agent-export/summary/ package only."""
    root = project_dir / "agent-export"
    out_dir = root / "summary"
    transcript = segments_to_transcript_md(segments)
    files = _write_dir(
        out_dir,
        {
            "01-reference.md": build_summary_reference_md(source),
            "02-prompt.md": build_summary_prompt_md(source),
            "03-transcript.md": transcript,
            "04-brief.md": build_summary_brief_md(source),
        },
    )
    return {"dir": str(out_dir), "root": str(root), "files": files, "kind": "summary"}


def write_clip_export(
    source: dict[str, Any],
    *,
    segments: list[dict[str, Any]] | None,
    project_dir: Path,
) -> dict[str, Any]:
    """Write agent-export/clip/ package only. Requires summary_post_url on source."""
    summary_url = (source.get("summary_post_url") or "").strip()
    if not summary_url:
        raise ValueError(
            "summary_post_url is required for clip export — paste the summary X post URL first"
        )
    root = project_dir / "agent-export"
    out_dir = root / "clip"
    transcript = segments_to_transcript_md(segments)
    files = _write_dir(
        out_dir,
        {
            "01-reference.md": build_clip_reference_md(source),
            "02-prompt.md": build_clip_prompt_md(source),
            "03-transcript.md": transcript,
        },
    )
    return {"dir": str(out_dir), "root": str(root), "files": files, "kind": "clip"}


def write_agent_export(
    source: dict[str, Any],
    *,
    segments: list[dict[str, Any]] | None,
    project_dir: Path,
) -> dict[str, Any]:
    """Write both packages (legacy / bulk). Clip package skipped if no summary URL."""
    summary = write_summary_export(source, segments=segments, project_dir=project_dir)
    clip = None
    clip_error = None
    try:
        clip = write_clip_export(source, segments=segments, project_dir=project_dir)
    except ValueError as e:
        clip_error = str(e)
    return {
        "dir": str(project_dir / "agent-export"),
        "summary_dir": summary["dir"],
        "clip_dir": clip["dir"] if clip else None,
        "files": {
            "summary": summary["files"],
            "clip": clip["files"] if clip else {},
        },
        "clip_error": clip_error,
    }


def _as_seconds(val: Any) -> float | None:
    """Accept float seconds, numeric strings, or M:SS / H:MM:SS labels."""
    if val is None:
        return None
    if isinstance(val, bool):
        return None
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, str):
        s = val.strip()
        if not s:
            return None
        # Range like "43:48-46:25" or "43:48–46:25" → take first side only
        if re.search(r"[–—-]", s) and s.count(":") >= 2:
            # ambiguous; try full parse first, else left half
            parsed = parse_ts_label(s)
            if parsed is not None:
                return parsed
        return parse_ts_label(s)
    return None


def _clip_bounds(item: dict[str, Any]) -> tuple[float, float]:
    t_in = _as_seconds(item.get("t_in"))
    t_out = _as_seconds(item.get("t_out"))
    if t_in is None:
        t_in = _as_seconds(item.get("t_in_label"))
    if t_out is None:
        t_out = _as_seconds(item.get("t_out_label"))
    # Optional single "range" / "timestamp" field: "12:30–13:45"
    if t_in is None or t_out is None:
        for key in ("range", "timestamp", "timestamps", "time_range"):
            raw = item.get(key)
            if not raw or not isinstance(raw, str):
                continue
            parts = re.split(r"\s*[–—-]\s*", raw.strip(), maxsplit=1)
            if len(parts) == 2:
                if t_in is None:
                    t_in = _as_seconds(parts[0])
                if t_out is None:
                    t_out = _as_seconds(parts[1])
            break
    if t_in is None or t_out is None:
        raise ValueError(
            "each clip needs t_in/t_out (seconds or M:SS) or t_in_label/t_out_label"
        )
    t_in_f = float(t_in)
    t_out_f = float(t_out)
    if t_out_f <= t_in_f:
        raise ValueError(f"t_out must be > t_in (got {t_in_f} → {t_out_f})")
    return t_in_f, t_out_f


def normalize_clip_plan(plan: dict[str, Any] | list[Any]) -> dict[str, Any]:
    """Accept {version, clips:[...]} or bare list of clips."""
    if isinstance(plan, list):
        return {"version": 1, "clips": plan, "source_url": None, "notes": None}
    if not isinstance(plan, dict):
        raise ValueError("clip plan must be a JSON object or array")
    clips = plan.get("clips")
    # Common alternate keys from chatty agents
    if not isinstance(clips, list):
        for alt in ("approved_clips", "selected_clips", "items", "moments"):
            if isinstance(plan.get(alt), list):
                clips = plan[alt]
                break
    if not isinstance(clips, list) or not clips:
        raise ValueError("clip plan must include a non-empty clips array")
    return {
        "version": int(plan.get("version") or 1),
        "source_url": plan.get("source_url"),
        "notes": plan.get("notes"),
        "clips": clips,
    }


def _coerce_score(val: Any) -> int | float | None:
    if val is None:
        return None
    try:
        if isinstance(val, str) and not val.strip():
            return None
        n = float(val)
        if n == int(n):
            return int(n)
        return n
    except (TypeError, ValueError):
        return None


def plan_item_to_clip_fields(item: dict[str, Any]) -> dict[str, Any]:
    """Map one plan clip → fields for make_clip / update_clip."""
    if not isinstance(item, dict):
        raise ValueError("each clip must be an object")
    t_in, t_out = _clip_bounds(item)
    title = (item.get("title") or item.get("name") or "Untitled clip").strip()
    title = title or "Untitled clip"
    captions = item.get("captions") if isinstance(item.get("captions"), dict) else {}
    # Sometimes platform captions are top-level
    if not any(captions.get(k) for k in ("tiktok", "shorts", "reels")):
        captions = {
            "tiktok": item.get("tiktok") or captions.get("tiktok") or "",
            "shorts": item.get("shorts") or captions.get("shorts") or "",
            "reels": item.get("reels") or captions.get("reels") or "",
        }
    tags = item.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in re.split(r"[,;\s]+", tags) if t.strip()]
    core_quotes = item.get("core_quotes") or item.get("quotes") or []
    if isinstance(core_quotes, str):
        core_quotes = [core_quotes]
    post_text = (
        item.get("post_text") or item.get("post") or item.get("x_post") or ""
    ).strip()

    return {
        "title": title[:200],
        "t_in": t_in,
        "t_out": t_out,
        "notes": (item.get("why") or item.get("notes") or "")[:2000],
        "post_text": post_text,
        "hook": (item.get("hook") or "").strip(),
        "why": (item.get("why") or "").strip(),
        "meaning": (item.get("meaning") or item.get("what_they_mean") or "").strip(),
        "score": _coerce_score(item.get("score")),
        "core_quotes": [str(q).strip() for q in core_quotes if str(q).strip()],
        "tags": [str(t).strip() for t in tags if str(t).strip()],
        "vk_angle": item.get("vk_angle"),
        "platform_captions": {
            "tiktok": str(captions.get("tiktok") or "").strip(),
            "shorts": str(captions.get("shorts") or "").strip(),
            "reels": str(captions.get("reels") or "").strip(),
        },
        "from_plan": True,
    }


def _strip_trailing_commas(s: str) -> str:
    # Remove trailing commas before } or ] (common LLM JSON slip)
    return re.sub(r",(\s*[}\]])", r"\1", s)


def extract_json_object(text: str) -> dict[str, Any] | list[Any]:
    """Parse pure JSON or a fenced ```json block from agent chat paste."""
    raw = (text or "").strip()
    if not raw:
        raise ValueError("empty clip plan")

    candidates: list[str] = []
    for m in re.finditer(r"```(?:json)?\s*([\s\S]*?)```", raw, re.IGNORECASE):
        candidates.append(m.group(1).strip())
    candidates.append(raw)

    # Also try largest {...} / [...] spans
    for open_c, close_c in (("{", "}"), ("[", "]")):
        start = raw.find(open_c)
        end = raw.rfind(close_c)
        if start >= 0 and end > start:
            candidates.append(raw[start : end + 1])

    errors: list[str] = []
    for cand in candidates:
        for variant in (cand, _strip_trailing_commas(cand)):
            try:
                data = json.loads(variant)
                if isinstance(data, (dict, list)):
                    return data
            except json.JSONDecodeError as e:
                errors.append(str(e))
                continue
    raise ValueError(
        "could not parse JSON from clip plan text"
        + (f" ({errors[-1]})" if errors else "")
    )


def save_clip_plan_copy(
    project_dir: Path,
    plan: dict[str, Any],
    *,
    raw_text: str | None = None,
) -> str:
    """Persist last imported plan under agent-export/clip/ for audit."""
    out_dir = project_dir / "agent-export" / "clip"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "clip-plan.imported.json"
    path.write_text(
        json.dumps(plan, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    if raw_text and raw_text.strip():
        (out_dir / "clip-plan.imported.raw.txt").write_text(
            raw_text, encoding="utf-8"
        )
    return str(path)
