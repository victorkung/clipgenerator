"""Clip-scoped captions: slice transcript, SRT, styled ASS burn-in."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from store import new_id

# ——— Caption plate style (app-wide; viral/social, not Desk chrome) ———

DEFAULT_CAPTION_STYLE: dict[str, Any] = {
    "font": "serif",  # serif | sans
    "plate": "cream",  # cream | night
    "anchor": "bottom",  # top | middle | lower_third | bottom
    "align": "center",  # left | center | right
    "offset_y": 0.0,  # −0.2 … +0.2 (fraction of frame height; + = down)
    "font_size": 0.052,  # fraction of frame height
    "max_width": 0.86,  # fraction of frame width
}

# macOS system fonts (reliable for ffmpeg/libass). Linux fallbacks listed after.
_FONT_CANDIDATES: dict[str, list[str]] = {
    "serif": [
        "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
        "/Library/Fonts/Georgia Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
        "Georgia",
    ],
    "sans": [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "Arial",
    ],
}


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
        # Keep the human's typing (newlines, extra spaces). Only trim the edges.
        text = str(item.get("text") or "").replace("\r\n", "\n").replace("\r", "\n")
        text = text.strip()
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


def normalize_caption_style(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Clamp / default an app-wide burn-in style dict."""
    base = dict(DEFAULT_CAPTION_STYLE)
    if not isinstance(raw, dict):
        return base
    font = str(raw.get("font") or base["font"]).strip().lower()
    base["font"] = font if font in ("serif", "sans") else "serif"
    plate = str(raw.get("plate") or base["plate"]).strip().lower()
    base["plate"] = plate if plate in ("cream", "night") else "cream"
    anchor = str(raw.get("anchor") or base["anchor"]).strip().lower()
    if anchor in ("top", "middle", "lower_third", "bottom"):
        base["anchor"] = anchor
    align = str(raw.get("align") or base["align"]).strip().lower()
    if align in ("left", "center", "right"):
        base["align"] = align
    try:
        oy = float(raw.get("offset_y", base["offset_y"]))
    except (TypeError, ValueError):
        oy = 0.0
    base["offset_y"] = max(-0.2, min(0.2, oy))
    try:
        fs = float(raw.get("font_size", base["font_size"]))
    except (TypeError, ValueError):
        fs = float(base["font_size"])
    base["font_size"] = max(0.03, min(0.09, fs))
    try:
        mw = float(raw.get("max_width", base["max_width"]))
    except (TypeError, ValueError):
        mw = float(base["max_width"])
    base["max_width"] = max(0.5, min(0.95, mw))
    return base


def resolve_caption_font(style: dict[str, Any]) -> tuple[str, str | None]:
    """
    Return (Fontname for ASS, optional font file path for fontsdir).

    Prefer real .ttf paths so libass embeds reliably.
    """
    key = "sans" if style.get("font") == "sans" else "serif"
    for cand in _FONT_CANDIDATES[key]:
        if cand.endswith((".ttf", ".otf", ".ttc")) and Path(cand).is_file():
            # ASS Fontname is the family name; file is loaded via fontsdir
            name = "Arial" if key == "sans" else "Georgia"
            return name, cand
        if not cand.startswith("/") and not cand.endswith((".ttf", ".otf", ".ttc")):
            return cand, None
    return ("Arial" if key == "sans" else "Georgia"), None


def _ass_time(seconds: float) -> str:
    s = max(0.0, float(seconds))
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = int(s % 60)
    cs = int(round((s - int(s)) * 100))  # centiseconds
    if cs >= 100:
        cs = 0
        sec += 1
    return f"{h}:{m:02d}:{sec:02d}.{cs:02d}"


def _ass_escape(text: str) -> str:
    t = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    t = t.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}")
    # Soft line breaks for ASS
    t = re.sub(r"\n+", r"\\N", t.strip())
    return t


def _plate_colours(plate: str) -> tuple[str, str]:
    """
    ASS &HAABBGGRR for (primary text, back/box).
    BorderStyle=3 uses OutlineColour as the box fill.
    Alpha 00 = fully opaque (ASS convention).
    """
    if plate == "night":
        # cream text on solid near-black plate
        primary = "&H00E4EFF4"  # paper cream-ish
        box = "&H000A0A0A"  # opaque black
    else:
        # ink text on solid cream plate (#f4efe4 → BGR e4,ef,f4)
        primary = "&H0014181A"
        box = "&H00E4EFF4"  # opaque cream
    return primary, box


def _anchor_layout(
    style: dict[str, Any], *, play_w: int, play_h: int
) -> tuple[int, int, int, int, int]:
    """
    Returns (alignment, pos_x, pos_y, margin_l, margin_r).

    Alignment is ASS numpad (1–9). pos is the anchor point in PlayRes coords.
    """
    align = style.get("align") or "center"
    anchor = style.get("anchor") or "bottom"
    oy = float(style.get("offset_y") or 0.0)

    x_frac = {"left": 0.12, "center": 0.50, "right": 0.88}[align]
    y_base = {
        "top": 0.10,
        "middle": 0.50,
        "lower_third": 0.72,
        "bottom": 0.88,
    }[anchor]
    y_frac = max(0.06, min(0.94, y_base + oy))

    col = {"left": 0, "center": 1, "right": 2}[align]
    row_base = {
        "top": 7,
        "middle": 4,
        "lower_third": 1,
        "bottom": 1,
    }[anchor]
    alignment = row_base + col

    pos_x = int(round(x_frac * play_w))
    pos_y = int(round(y_frac * play_h))
    side = int(round((1.0 - float(style.get("max_width") or 0.86)) / 2 * play_w))
    side = max(24, side)
    return alignment, pos_x, pos_y, side, side


def cues_to_ass(
    cues: list[dict[str, Any]],
    style: dict[str, Any] | None = None,
    *,
    play_w: int = 1920,
    play_h: int = 1080,
) -> str:
    """
    Build a styled ASS subtitle file for burn-in.

    Preview CSS in the UI mirrors these anchors, plates, and bold weight.
    """
    st = normalize_caption_style(style)
    font_name, _font_path = resolve_caption_font(st)
    primary, box = _plate_colours(st["plate"])
    alignment, pos_x, pos_y, margin_l, margin_r = _anchor_layout(
        st, play_w=play_w, play_h=play_h
    )
    font_size = max(18, int(round(float(st["font_size"]) * play_h)))
    # Outline for BorderStyle=3 is box padding-ish; 8–12 works at 1080p
    outline = max(6, int(round(play_h * 0.011)))
    shadow = 0

    header = f"""[Script Info]
Title: clipgenerator burn-in
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: {play_w}
PlayResY: {play_h}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{font_name},{font_size},{primary},&H000000FF,{box},&H00000000,-1,0,0,0,100,100,0,0,3,{outline},{shadow},{alignment},{margin_l},{margin_r},0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events: list[str] = []
    for c in cues or []:
        text = _ass_escape(str(c.get("text") or ""))
        if not text:
            continue
        start = float(c.get("start") or 0.0)
        end = float(c.get("end") or start + 0.5)
        if end <= start:
            end = start + 0.5
        # \pos locks the plate to the same anchor the preview uses
        body = rf"{{\an{alignment}\pos({pos_x},{pos_y})}}{text}"
        events.append(
            f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Caption,,0,0,0,,{body}"
        )
    return header + "\n".join(events) + ("\n" if events else "")


def write_ass_file(
    path: Path,
    cues: list[dict[str, Any]],
    style: dict[str, Any] | None = None,
    *,
    play_w: int = 1920,
    play_h: int = 1080,
) -> Path:
    path = Path(path)
    path.write_text(
        cues_to_ass(cues, style, play_w=play_w, play_h=play_h),
        encoding="utf-8",
    )
    return path


def fontsdir_for_style(style: dict[str, Any] | None) -> str | None:
    """Directory to pass to ffmpeg subtitles filter fontsdir=…"""
    st = normalize_caption_style(style)
    _name, font_path = resolve_caption_font(st)
    if font_path and Path(font_path).is_file():
        return str(Path(font_path).parent)
    return None


def _wrap_lines(text: str, font: Any, max_width: int, draw: Any) -> list[str]:
    words = (text or "").split()
    if not words:
        return []
    lines: list[str] = []
    cur = words[0]
    for w in words[1:]:
        trial = f"{cur} {w}"
        bbox = draw.textbbox((0, 0), trial, font=font)
        if bbox[2] - bbox[0] <= max_width:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def caption_layout_metrics(
    style: dict[str, Any] | None, *, video_w: int, video_h: int
) -> dict[str, Any]:
    """
    Shared layout numbers for burn-in PNG and the UI monitor preview.

    Keep in sync with app/frontend captionPlateLayout().
    """
    st = normalize_caption_style(style)
    font_size = max(14, int(round(float(st["font_size"]) * video_h)))
    pad_x = max(8, int(font_size * 0.45))
    pad_y = max(6, int(font_size * 0.28))
    max_plate_w = max(1, int(float(st["max_width"]) * video_w))
    wrap_w = max(1, max_plate_w - pad_x * 2)
    line_h = font_size + max(2, int(font_size * 0.12))
    return {
        "style": st,
        "font_size": font_size,
        "pad_x": pad_x,
        "pad_y": pad_y,
        "max_plate_w": max_plate_w,
        "wrap_w": wrap_w,
        "line_h": line_h,
        # line-height as multiple of font size (CSS)
        "line_height": line_h / max(font_size, 1),
        "pad_x_em": pad_x / max(font_size, 1),
        "pad_y_em": pad_y / max(font_size, 1),
    }


def render_caption_plate_image(
    text: str,
    style: dict[str, Any] | None,
    *,
    video_w: int,
    video_h: int,
) -> tuple[Any, int, int, list[str]]:
    """
    Render one caption plate as a PIL RGBA image.

    Returns (image, overlay_x, overlay_y, wrapped_lines) in full video pixels.
    Same raster path for export burn-in and the monitor preview API.
    """
    from PIL import Image, ImageDraw, ImageFont

    video_w = max(16, int(video_w))
    video_h = max(16, int(video_h))
    m = caption_layout_metrics(style, video_w=video_w, video_h=video_h)
    st = m["style"]
    font_size = m["font_size"]
    pad_x = m["pad_x"]
    pad_y = m["pad_y"]
    wrap_w = m["wrap_w"]
    line_h = m["line_h"]

    _name, font_path = resolve_caption_font(st)
    try:
        if font_path and Path(font_path).is_file():
            font = ImageFont.truetype(font_path, font_size)
        else:
            font = ImageFont.load_default()
    except OSError:
        font = ImageFont.load_default()

    # Measure on a throwaway image
    probe = Image.new("RGBA", (wrap_w + pad_x * 2, font_size * 8), (0, 0, 0, 0))
    draw = ImageDraw.Draw(probe)
    lines = _wrap_lines(text.strip(), font, wrap_w, draw)
    if not lines:
        lines = [" "]

    text_h = line_h * len(lines)
    text_w = 0
    for ln in lines:
        bbox = draw.textbbox((0, 0), ln, font=font)
        text_w = max(text_w, bbox[2] - bbox[0])

    plate_w = min(video_w, max(1, text_w + pad_x * 2))
    plate_h = max(1, text_h + pad_y * 2)

    if st["plate"] == "night":
        bg = (10, 10, 10, 255)
        fg = (244, 239, 228, 255)
    else:
        bg = (244, 239, 228, 255)
        fg = (26, 24, 20, 255)

    # Fully opaque RGB plate (no soft alpha) so ffmpeg overlay cannot look translucent.
    img = Image.new("RGBA", (plate_w, plate_h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Square plate (Desk radius-sm) — solid fill, no anti-aliased rounded corners
    d.rectangle([0, 0, plate_w - 1, plate_h - 1], fill=bg)

    y = pad_y
    for ln in lines:
        bbox = d.textbbox((0, 0), ln, font=font)
        lw = bbox[2] - bbox[0]
        if st["align"] == "left":
            x = pad_x
        elif st["align"] == "right":
            x = plate_w - pad_x - lw
        else:
            x = (plate_w - lw) // 2
        d.text((x, y), ln, font=font, fill=fg)
        y += line_h

    # Snap every non-zero alpha to 255 so burn-in is never semi-transparent
    alpha = img.getchannel("A")
    alpha = alpha.point(lambda a: 255 if a > 0 else 0)
    img.putalpha(alpha)

    # Anchor point → top-left for overlay
    ax = caption_anchor_x_frac(st) * video_w
    ay = caption_anchor_y_frac(st) * video_h
    anchor = st["anchor"]
    align = st["align"]
    if align == "left":
        ox = int(round(ax))
    elif align == "right":
        ox = int(round(ax - plate_w))
    else:
        ox = int(round(ax - plate_w / 2))

    if anchor in ("bottom", "lower_third"):
        oy = int(round(ay - plate_h))
    elif anchor == "top":
        oy = int(round(ay))
    else:
        oy = int(round(ay - plate_h / 2))

    ox = max(0, min(video_w - plate_w, ox))
    oy = max(0, min(video_h - plate_h, oy))
    return img, ox, oy, lines


def render_caption_plate_png(
    text: str,
    style: dict[str, Any] | None,
    *,
    video_w: int,
    video_h: int,
    out_path: Path,
) -> tuple[Path, int, int]:
    """
    Render one caption plate PNG to disk.

    Returns (path, overlay_x, overlay_y) in full video pixels.
    """
    img, ox, oy, _lines = render_caption_plate_image(
        text, style, video_w=video_w, video_h=video_h
    )
    out_path = Path(out_path)
    img.save(out_path, "PNG")
    return out_path, ox, oy


def caption_anchor_x_frac(style: dict[str, Any]) -> float:
    st = normalize_caption_style(style)
    return {"left": 0.12, "center": 0.50, "right": 0.88}[st["align"]]


def caption_anchor_y_frac(style: dict[str, Any]) -> float:
    st = normalize_caption_style(style)
    base = {
        "top": 0.10,
        "middle": 0.50,
        "lower_third": 0.72,
        "bottom": 0.88,
    }[st["anchor"]]
    return max(0.06, min(0.94, base + float(st["offset_y"])))


def prepare_burn_overlays(
    cues: list[dict[str, Any]],
    style: dict[str, Any] | None,
    *,
    video_w: int,
    video_h: int,
    work_dir: Path,
) -> list[dict[str, Any]]:
    """
    Render one cropped plate PNG per cue.

    Returns list of {path, x, y, start, end, text}. Used by the timeline
    builder; export no longer feeds these to ffmpeg as separate inputs.
    """
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    out: list[dict[str, Any]] = []
    for i, c in enumerate(cues or []):
        text = (c.get("text") or "").strip()
        if not text:
            continue
        start = float(c.get("start") or 0.0)
        end = float(c.get("end") or start + 0.5)
        if end <= start:
            end = start + 0.5
        path = work_dir / f"plate_{i:03d}.png"
        p, x, y = render_caption_plate_png(
            text, style, video_w=video_w, video_h=video_h, out_path=path
        )
        out.append(
            {
                "path": p,
                "x": x,
                "y": y,
                "start": start,
                "end": end,
                "text": text,
            }
        )
    return out


def drawable_burn_cues(
    cues: list[dict[str, Any]] | None,
    *,
    duration: float,
) -> list[dict[str, Any]]:
    """Cues with text, clipped to [0, duration], end > start."""
    dur = max(0.0, float(duration))
    out: list[dict[str, Any]] = []
    for c in cues or []:
        text = (c.get("text") or "").strip()
        if not text:
            continue
        try:
            start = float(c.get("start") or 0.0)
            end = float(c.get("end") if c.get("end") is not None else start + 0.5)
        except (TypeError, ValueError):
            continue
        if end <= start:
            end = start + 0.5
        start = max(0.0, min(dur, start))
        end = max(0.0, min(dur, end))
        if end - start < 0.001:
            continue
        out.append({"start": start, "end": end, "text": text})
    return out


def overlay_intervals(
    cues: list[dict[str, Any]],
    *,
    duration: float,
) -> list[tuple[float, float, tuple[int, ...]]]:
    """
    Sweep [0, duration] into intervals where the active cue set is constant.

    Each item is (start, end, active_indices). An empty tuple is a gap
    (transparent). Later indices paint on top — same order as the old
    N-input overlay chain.
    """
    dur = max(0.0, float(duration))
    if dur <= 0:
        return []

    events: list[tuple[float, int, int]] = []
    for i, c in enumerate(cues):
        start = float(c["start"])
        end = float(c["end"])
        if end <= start:
            continue
        events.append((start, 1, i))
        events.append((end, -1, i))
    # Ends before starts at the same timestamp so abutting cues don't overlap.
    events.sort(key=lambda ev: (ev[0], ev[1], ev[2]))

    intervals: list[tuple[float, float, tuple[int, ...]]] = []
    active: set[int] = set()
    prev = 0.0
    for t, kind, idx in events:
        if t > dur:
            t = dur
        if t > prev + 1e-9:
            ordered = tuple(i for i in range(len(cues)) if i in active)
            intervals.append((prev, t, ordered))
            prev = t
        if kind == 1:
            active.add(idx)
        else:
            active.discard(idx)
        if prev >= dur:
            break

    if prev < dur - 1e-9:
        ordered = tuple(i for i in range(len(cues)) if i in active)
        intervals.append((prev, dur, ordered))
    if not intervals:
        intervals.append((0.0, dur, ()))
    return [(s, e, ids) for s, e, ids in intervals if e - s >= 0.001]


def concat_quote(name: str) -> str:
    """Quote a concat filename (relative, no slashes)."""
    return "'" + str(name).replace("'", r"'\''") + "'"


def format_overlay_concat(entries: list[tuple[str, float]]) -> str:
    """
    ffconcat text for timed stills.

    The last file is repeated: concat ignores duration on the final entry.
    """
    lines = ["ffconcat version 1.0"]
    if not entries:
        return "\n".join(lines) + "\n"
    for name, dur in entries:
        lines.append(f"file {concat_quote(name)}")
        lines.append(f"duration {max(0.001, float(dur)):.3f}")
    lines.append(f"file {concat_quote(entries[-1][0])}")
    return "\n".join(lines) + "\n"


def _composite_full_frame(
    plates: list[tuple[Any, int, int]],
    *,
    video_w: int,
    video_h: int,
) -> Any:
    from PIL import Image

    canvas = Image.new("RGBA", (video_w, video_h), (0, 0, 0, 0))
    for img, x, y in plates:
        canvas.alpha_composite(img, (int(x), int(y)))
    return canvas


def build_overlay_timeline(
    cues: list[dict[str, Any]],
    style: dict[str, Any] | None,
    *,
    video_w: int,
    video_h: int,
    duration: float,
    work_dir: Path,
) -> Path | None:
    """
    Build one timed overlay (full-frame PNG stills + ffconcat).

    Export feeds this as a single ffmpeg input instead of one input per cue.
    Returns the concat path, or None when there is nothing to burn.
    """
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    video_w = max(16, int(video_w))
    video_h = max(16, int(video_h))
    duration = max(0.0, float(duration))

    drawn = drawable_burn_cues(cues, duration=duration)
    if not drawn or duration <= 0:
        return None

    from PIL import Image

    plates: list[tuple[Any, int, int]] = []
    for i, c in enumerate(drawn):
        img, x, y, _lines = render_caption_plate_image(
            c["text"], style, video_w=video_w, video_h=video_h
        )
        plates.append((img, x, y))

    empty_name = "empty.png"
    empty_path = work_dir / empty_name
    if not empty_path.is_file():
        Image.new("RGBA", (video_w, video_h), (0, 0, 0, 0)).save(empty_path, "PNG")

    frame_cache: dict[tuple[int, ...], str] = {(): empty_name}
    entries: list[tuple[str, float]] = []
    for start, end, ids in overlay_intervals(drawn, duration=duration):
        if ids not in frame_cache:
            name = f"frame_{len(frame_cache):04d}.png"
            canvas = _composite_full_frame(
                [plates[i] for i in ids],
                video_w=video_w,
                video_h=video_h,
            )
            canvas.save(work_dir / name, "PNG")
            frame_cache[ids] = name
        entries.append((frame_cache[ids], end - start))

    if not entries:
        return None

    concat_path = work_dir / "overlay.concat"
    concat_path.write_text(format_overlay_concat(entries), encoding="utf-8")
    return concat_path
