"""Ingest download bar: video / audio / glue slices, not one 0–100%."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app" / "backend"))

from main import (  # noqa: E402
    _DOWNLOAD_PHASE_AUDIO,
    _DOWNLOAD_PHASE_GLUE,
    _DOWNLOAD_PHASE_VIDEO,
    _download_phase_banner_job,
    _download_phase_from_line,
    _map_download_file_pct,
)


class DownloadPhaseTests(unittest.TestCase):
    def test_banners_advance_video_audio_glue(self) -> None:
        phase = _DOWNLOAD_PHASE_VIDEO
        phase = _download_phase_from_line("--- Picture ---", phase)
        self.assertEqual(phase, _DOWNLOAD_PHASE_VIDEO)
        phase = _download_phase_from_line(
            "--- Sound (ffmpeg HLS as MPEG-TS, serial fragments) ---", phase
        )
        self.assertEqual(phase, _DOWNLOAD_PHASE_AUDIO)
        phase = _download_phase_from_line("=== Mux ===", phase)
        self.assertEqual(phase, _DOWNLOAD_PHASE_GLUE)
        phase = _download_phase_from_line("Normalizing to H.264 + AAC…", phase)
        self.assertEqual(phase, _DOWNLOAD_PHASE_GLUE)

    def test_reuse_banners(self) -> None:
        self.assertEqual(
            _download_phase_from_line("Reusing picture already on disk: x", "video"),
            _DOWNLOAD_PHASE_VIDEO,
        )
        self.assertEqual(
            _download_phase_from_line(
                "Reusing complete sound already on disk: x", "video"
            ),
            _DOWNLOAD_PHASE_AUDIO,
        )
        self.assertEqual(
            _download_phase_banner_job("Reusing picture already on disk: x", "video"),
            (40, "Video already on disk"),
        )
        self.assertEqual(
            _download_phase_banner_job(
                "Reusing complete sound already on disk: x", "audio"
            ),
            (50, "Audio already on disk"),
        )

    def test_picture_100_is_not_pipeline_55(self) -> None:
        overall, msg = _map_download_file_pct(_DOWNLOAD_PHASE_VIDEO, 100.0)
        self.assertEqual(overall, 40)
        self.assertIn("video", msg.lower())
        self.assertNotIn("55", msg)

    def test_audio_and_glue_slices(self) -> None:
        overall, msg = _map_download_file_pct(_DOWNLOAD_PHASE_AUDIO, 0.0)
        self.assertEqual(overall, 40)
        self.assertIn("audio", msg.lower())
        overall, msg = _map_download_file_pct(_DOWNLOAD_PHASE_AUDIO, 100.0)
        self.assertEqual(overall, 52)
        overall, msg = _map_download_file_pct(_DOWNLOAD_PHASE_GLUE, 100.0)
        self.assertEqual(overall, 55)
        self.assertIn("Glu", msg)

    def test_sound_banner_changes_words_without_percent(self) -> None:
        job = _download_phase_banner_job(
            "--- Sound (ffmpeg HLS as MPEG-TS, serial fragments) ---",
            _DOWNLOAD_PHASE_AUDIO,
        )
        self.assertIsNotNone(job)
        assert job is not None
        self.assertEqual(job[0], 40)
        self.assertEqual(job[1], "Downloading audio…")


if __name__ == "__main__":
    unittest.main()
