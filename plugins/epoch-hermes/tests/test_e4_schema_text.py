"""E4: every estimate-tool property is described."""
from __future__ import annotations

from pathlib import Path


PLUGIN_DIR = Path(__file__).resolve().parent.parent
def test_every_estimate_schema_property_has_a_description(plugin):
    props = plugin.ESTIMATE_SCHEMA["parameters"]["properties"]
    missing = [k for k, v in props.items() if not str(v.get("description") or "").strip()]
    assert not missing, f"properties without a description: {missing}"

