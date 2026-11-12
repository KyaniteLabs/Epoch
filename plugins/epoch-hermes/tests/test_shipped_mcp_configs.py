"""Shipped MCP configs expose the 6 core tools (LFM3 eval: 9.8k -> 2.4k prompt tokens), skill snippets still show all 26, and every shipped skill pins the runtime."""
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
BUNDLE = REPO / "plugins" / "epoch"


def _configs():
    found = [p for p in BUNDLE.rglob("*.json") if p.name.endswith("mcp.json")]
    assert len(found) >= 3, found  # .mcp.json, epoch.mcp.json, mcp.json
    return found


def test_every_shipped_mcp_config_sets_epoch_tools_core():
    for path in _configs():
        server = json.loads(path.read_text(encoding="utf-8"))["mcpServers"]["epoch"]
        assert (server.get("env") or {}).get("EPOCH_TOOLS") == "core", path


def test_skill_mcp_setup_snippets_keep_all_tools():
    for rel in ("skills/epoch/SKILL.md", "plugins/epoch/skills/epoch/SKILL.md"):
        text = (REPO / rel).read_text(encoding="utf-8")
        block = text[text.index("## MCP Setup"):]
        assert '"EPOCH_TOOLS": "all"' in block, rel


def test_shipped_skills_and_bundle_pin_the_runtime_version():
    unpinned = []
    roots = [REPO / "skills", BUNDLE, REPO / "plugins" / "epoch-hermes"]
    for root in roots:
        for path in root.rglob("*"):
            if path.suffix not in (".md", ".json") or "node_modules" in path.parts or "tests" in path.parts:
                continue
            for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if re.search(r"@kyanitelabs/epoch(?![@\w/.-]|\s\d)", line):
                    unpinned.append(f"{path.relative_to(REPO)}:{n}")
    assert not unpinned, f"unpinned @kyanitelabs/epoch (use @0.8.0): {unpinned}"


def test_epoch_tools_setting_is_honest_about_the_pinned_runtime():
    """The shipped configs pin a published runtime. If that release's changelog section does not
    mention EPOCH_TOOLS, the setting does nothing there (all 26 tools load), and the bundle README
    must say so instead of promising six tools."""
    import json
    import re
    from pathlib import Path
    root = Path(__file__).resolve().parents[3]
    pinned = json.loads((root / "package.json").read_text())["version"]
    changelog = (root / "CHANGELOG.md").read_text()
    section = re.search(rf"^## \[{re.escape(pinned)}\].*?(?=^## \[|\Z)", changelog, re.M | re.S).group(0)
    if "EPOCH_TOOLS" in section:
        return
    readme = (root / "plugins" / "epoch" / "README.md").read_text()
    assert "EPOCH_TOOLS" in readme and f"{pinned}" in readme, "README must say the pin ignores EPOCH_TOOLS"
    assert re.search(r"ignores? `?EPOCH_TOOLS|before `?EPOCH_TOOLS|does not (?:yet )?(?:honou?r|support) `?EPOCH_TOOLS", readme)
    assert "26 tools" in readme  # what the pinned runtime really serves
