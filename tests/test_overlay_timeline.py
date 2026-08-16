"""Overlay timeline: interval sweep, concat text, ffmpeg two-input smoke."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app" / "backend"))

from captions import (  # noqa: E402
    build_overlay_timeline,
    drawable_burn_cues,
    format_overlay_concat,
    overlay_intervals,
)


def _cue(start: float, end: float, text: str = "hi") -> dict:
    return {"start": start, "end": end, "text": text}


class OverlayIntervalsTests(unittest.TestCase):
    def test_gap_then_cue_then_gap(self) -> None:
        cues = drawable_burn_cues([_cue(1.0, 2.0)], duration=3.0)
        iv = overlay_intervals(cues, duration=3.0)
        self.assertEqual(
            iv,
            [
                (0.0, 1.0, ()),
                (1.0, 2.0, (0,)),
                (2.0, 3.0, ()),
            ],
        )

    def test_abutting_cues_do_not_overlap(self) -> None:
        cues = drawable_burn_cues([_cue(0.0, 1.0, "a"), _cue(1.0, 2.0, "b")], duration=2.0)
        iv = overlay_intervals(cues, duration=2.0)
        self.assertEqual(
            iv,
            [
                (0.0, 1.0, (0,)),
                (1.0, 2.0, (1,)),
            ],
        )

    def test_overlap_paints_later_on_top(self) -> None:
        cues = drawable_burn_cues(
            [_cue(0.0, 2.0, "a"), _cue(1.0, 3.0, "b")], duration=3.0
        )
        iv = overlay_intervals(cues, duration=3.0)
        self.assertEqual(
            iv,
            [
                (0.0, 1.0, (0,)),
                (1.0, 2.0, (0, 1)),
                (2.0, 3.0, (1,)),
            ],
        )

    def test_clips_to_duration_and_skips_empty_text(self) -> None:
        cues = drawable_burn_cues(
            [_cue(-1.0, 0.5, "a"), _cue(0.4, 9.0, ""), _cue(8.0, 12.0, "b")],
            duration=10.0,
        )
        self.assertEqual(len(cues), 2)
        self.assertAlmostEqual(cues[0]["start"], 0.0)
        self.assertAlmostEqual(cues[0]["end"], 0.5)
        self.assertAlmostEqual(cues[1]["start"], 8.0)
        self.assertAlmostEqual(cues[1]["end"], 10.0)

    def test_many_cues_cover_full_span(self) -> None:
        raw = [_cue(i * 0.05, i * 0.05 + 0.04, f"c{i}") for i in range(400)]
        cues = drawable_burn_cues(raw, duration=20.0)
        iv = overlay_intervals(cues, duration=20.0)
        self.assertGreater(len(iv), 400)
        self.assertAlmostEqual(iv[0][0], 0.0)
        self.assertAlmostEqual(iv[-1][1], 20.0)
        total = sum(e - s for s, e, _ in iv)
        self.assertAlmostEqual(total, 20.0, places=2)
        painted = [ids for _s, _e, ids in iv if ids]
        self.assertEqual(len(painted), 400)


class OverlayConcatTextTests(unittest.TestCase):
    def test_repeats_last_file_and_sums_durations(self) -> None:
        text = format_overlay_concat([("empty.png", 0.5), ("frame_0001.png", 1.25)])
        lines = [ln for ln in text.splitlines() if ln]
        self.assertEqual(lines[0], "ffconcat version 1.0")
        self.assertIn("file 'empty.png'", lines)
        self.assertIn("duration 0.500", lines)
        self.assertIn("file 'frame_0001.png'", lines)
        self.assertIn("duration 1.250", lines)
        self.assertEqual(lines[-1], "file 'frame_0001.png'")
        durs = [float(ln.split()[1]) for ln in lines if ln.startswith("duration ")]
        self.assertAlmostEqual(sum(durs), 1.75)

    def test_single_entry(self) -> None:
        text = format_overlay_concat([("empty.png", 3.0)])
        self.assertTrue(text.endswith("file 'empty.png'\n"))
        self.assertIn("duration 3.000", text)


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not on PATH")
class OverlayFfmpegSmokeTests(unittest.TestCase):
    def test_two_input_overlay_survives_400_cues(self) -> None:
        """Repro the old vist#373 failure: hundreds of plates, two ffmpeg inputs."""
        duration = 2.0
        cues = [
            {"start": i * (duration / 400), "end": (i + 0.8) * (duration / 400), "text": f"c{i}"}
            for i in range(400)
        ]
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            concat = build_overlay_timeline(
                cues,
                {"font": "sans", "plate": "cream", "anchor": "bottom", "align": "center"},
                video_w=160,
                video_h=90,
                duration=duration,
                work_dir=work / "burn",
            )
            self.assertIsNotNone(concat)
            assert concat is not None
            src = work / "src.mp4"
            out = work / "out.mp4"
            subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    f"color=c=black:s=160x90:d={duration}:r=30",
                    "-f",
                    "lavfi",
                    "-i",
                    f"sine=frequency=440:duration={duration}",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-shortest",
                    str(src),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            proc = subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(src),
                    "-f",
                    "concat",
                    "-safe",
                    "0",
                    "-i",
                    str(concat),
                    "-t",
                    f"{duration:.3f}",
                    "-filter_complex",
                    "[1:v]format=rgba,setsar=1,setpts=PTS-STARTPTS[ov];"
                    "[0:v][ov]overlay=0:0:format=auto:alpha=straight:eof_action=repeat[v]",
                    "-map",
                    "[v]",
                    "-map",
                    "0:a:0?",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-crf",
                    "30",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    str(out),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(
                proc.returncode,
                0,
                msg=f"ffmpeg failed:\n{proc.stderr[-2000:]}",
            )
            self.assertTrue(out.is_file())
            self.assertGreater(out.stat().st_size, 1000)


if __name__ == "__main__":
    unittest.main()
