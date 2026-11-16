"""Run the pinned Hermes validator against the shipped Epoch plugin manifest."""
import os
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parent.parent
HERMES_SOURCE = os.environ.get("HERMES_AGENT_SRC")

pytestmark = pytest.mark.skipif(
    not HERMES_SOURCE,
    reason="real Hermes source is not available",
)


def test_real_hermes_plugin_validator_accepts_epoch_manifest():
    source = Path(HERMES_SOURCE)
    sys.path.insert(0, str(source))
    from hermes_cli import plugin_validate

    report = plugin_validate.validate_plugin_dir(PLUGIN_DIR).to_dict()
    assert report["ok"], report
