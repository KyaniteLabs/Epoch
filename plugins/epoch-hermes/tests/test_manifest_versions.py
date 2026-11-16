"""E7/F15: the portable bundle has its own name, and every bundle manifest reads one version."""
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
BUNDLE = REPO / "plugins" / "epoch"
VERSION = json.loads((REPO / "package.json").read_text(encoding="utf-8"))["version"]


def _json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_bundle_manifests_all_carry_the_package_version():
    manifests = [BUNDLE / "plugin.json", BUNDLE / ".claude-plugin" / "plugin.json",
                 BUNDLE / ".cursor-plugin" / "plugin.json", BUNDLE / ".minimax-plugin" / "plugin.json"]
    assert {p.name for p in manifests} == {"plugin.json"}
    seen = {str(p.relative_to(REPO)): _json(p).get("version") for p in manifests}
    assert set(seen.values()) == {VERSION}, seen
    server = _json(REPO / "server.json")
    assert server["version"] == VERSION
    assert {p["version"] for p in server["packages"] if p.get("registryType") == "npm"} == {VERSION}


def test_every_bundle_mcp_config_pins_the_package_version():
    configs = [p for p in BUNDLE.rglob("*.json") if p.name.endswith("mcp.json")]
    assert configs
    for path in configs:
        args = _json(path)["mcpServers"]["epoch"]["args"]
        assert f"@kyanitelabs/epoch@{VERSION}" in args, path


def test_the_hermes_plugin_pins_the_same_runtime_version():
    text = (REPO / "plugins" / "epoch-hermes" / "plugin.yaml").read_text(encoding="utf-8")
    assert set(re.findall(r"@kyanitelabs/epoch@(\d+\.\d+\.\d+)", text)) == {VERSION}


def test_the_portable_bundle_is_not_named_like_the_hermes_plugin():
    hermes_name = re.search(r"^name: (\S+)", (REPO / "plugins" / "epoch-hermes" / "plugin.yaml").read_text(),
                            re.M).group(1)
    for path in (BUNDLE / "plugin.json", BUNDLE / ".claude-plugin" / "plugin.json",
                 BUNDLE / ".cursor-plugin" / "plugin.json", BUNDLE / ".minimax-plugin" / "plugin.json"):
        assert _json(path)["name"] != hermes_name, path
        assert _json(path)["name"] == "epoch-agent", path
    market = _json(REPO / ".cursor-plugin" / "marketplace.json")
    assert [p["name"] for p in market["plugins"] if p["source"] == "plugins/epoch"] == ["epoch-agent"]
