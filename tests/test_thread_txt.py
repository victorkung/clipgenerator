"""Export All thread.txt includes opener, clips, closer, then reply."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app" / "backend"))

from main import _write_thread_txt  # noqa: E402


class ThreadTxtTests(unittest.TestCase):
    def test_closer_sits_after_clips_before_reply(self) -> None:
        source = {
            "summary_post_text": "1/ opener body",
            "agent_run": {
                "closer": {"post_text": "follow for more pancakes"},
                "reply": {"post_text": "great stream\n\nhttps://x.com/x/status/1"},
            },
        }
        clips = [
            {
                "title": "Fortnite tape",
                "t_in": 10.0,
                "t_out": 40.0,
                "post_text": "heading\n\nbody",
            }
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_thread_txt(Path(tmp), source, clips)
            text = path.read_text(encoding="utf-8")
        self.assertIn("## Opener", text)
        self.assertIn("1/ opener body", text)
        self.assertIn("## 1. Fortnite tape", text)
        self.assertIn("## Closer", text)
        self.assertIn("follow for more pancakes", text)
        self.assertIn("## Reply under original", text)
        self.assertLess(text.index("## Closer"), text.index("## Reply under original"))

    def test_each_section_uses_that_clip_post(self) -> None:
        source = {"summary_post_text": "opener"}
        clips = [
            {
                "title": "Onchain looks like Fortnite",
                "t_in": 377.0,
                "t_out": 496.0,
                "post_text": "onchain looks like fortnite\n\nplumber tape",
            },
            {
                "title": "Almost zero new money",
                "t_in": 2219.0,
                "t_out": 2332.0,
                "post_text": "almost zero new money. this pancakes",
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            text = _write_thread_txt(Path(tmp), source, clips).read_text(
                encoding="utf-8"
            )
        first = text.index("## 1. Onchain looks like Fortnite")
        second = text.index("## 2. Almost zero new money")
        self.assertLess(first, second)
        one = text[first:second]
        two = text[second:]
        self.assertIn("onchain looks like fortnite", one)
        self.assertIn("plumber tape", one)
        self.assertNotIn("this pancakes", one)
        self.assertIn("almost zero new money. this pancakes", two)
        self.assertNotIn("plumber tape", two)

    def test_skips_empty_closer(self) -> None:
        source = {"summary_post_text": "opener", "agent_run": {"closer": {}}}
        with tempfile.TemporaryDirectory() as tmp:
            text = _write_thread_txt(Path(tmp), source, []).read_text(encoding="utf-8")
        self.assertNotIn("## Closer", text)


if __name__ == "__main__":
    unittest.main()
