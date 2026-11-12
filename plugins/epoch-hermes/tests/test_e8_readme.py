"""E8: the README opens with a plain sentence."""
from __future__ import annotations

from pathlib import Path


PLUGIN_DIR = Path(__file__).resolve().parent.parent
def test_readme_opens_with_one_plain_sentence_then_the_p50_line():
    lines = [l for l in (PLUGIN_DIR / "README.md").read_text(encoding="utf-8").splitlines() if l.strip()]
    first, second = lines[1], lines[2]
    assert first.startswith("Epoch tells you how long")
    assert "worst case" in first and "past tasks" in first
    assert "P50" not in first and first.count(". ") == 0
    assert second.startswith("P50/P90 estimates")
