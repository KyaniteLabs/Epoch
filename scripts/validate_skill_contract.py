#!/usr/bin/env python3
"""GC-DIST SPEC §1 skill description contract validator.

Plain python3, no pytest. Mirrors the kinocut contract:
  - skills/<name>/SKILL.md flat layout (no nested skill dirs)
  - YAML frontmatter with exactly name + description
  - description <= 250 chars total (ZCode truncates at 250)
  - first sentence <= 80 chars, self-contained, starts with a trigger
    pattern ("Use <x> for/on/when ...") and contains an action verb
Exits nonzero on any violation.
"""
import re
import sys
from pathlib import Path

TRIGGER_RE = re.compile(r"^Use [A-Za-z0-9][A-Za-z0-9 ._/-]* (for|on|when|while|to) ")
MAX_DESC = 250
MAX_FIRST = 80


def split_first_sentence(text: str) -> str:
    for sep in (". ", "! ", "? "):
        idx = text.find(sep)
        if idx != -1:
            return text[: idx + 1].rstrip()
    return text.rstrip()


def validate(skill_md: Path, repo_root: Path) -> list[str]:
    errors: list[str] = []
    rel = skill_md.relative_to(repo_root)
    raw = skill_md.read_text(encoding="utf-8")

    m = re.match(r"^---\n(.*?)\n---\n", raw, re.S)
    if not m:
        return [f"{rel}: missing YAML frontmatter"]
    fm = m.group(1)
    keys = [line.split(":", 1)[0].strip() for line in fm.splitlines() if line.strip()]
    if keys != ["name", "description"]:
        errors.append(f"{rel}: frontmatter keys must be exactly [name, description], got {keys}")

    name = skill_md.parent.name
    nm = re.search(r"^name:\s*(\S+)\s*$", fm, re.M)
    if not nm:
        errors.append(f"{rel}: missing name")
    elif nm.group(1) != name:
        errors.append(f"{rel}: name {nm.group(1)!r} != directory name {name!r}")

    dm = re.search(r"^description:\s*(.+)$", fm, re.M)
    if not dm:
        errors.append(f"{rel}: missing description")
        return errors
    desc = dm.group(1).strip()

    # Length contract
    if len(desc) > MAX_DESC:
        errors.append(f"{rel}: description length {len(desc)} > {MAX_DESC}")

    first = split_first_sentence(desc)
    if len(first) > MAX_FIRST:
        errors.append(f"{rel}: first sentence length {len(first)} > {MAX_FIRST} ({first[:60]!r}...)")
    if not TRIGGER_RE.match(desc):
        errors.append(f"{rel}: description does not start with trigger pattern 'Use <x> for/on/when ...' ({desc[:50]!r})")
    if not first.endswith((".", "!", "?")):
        errors.append(f"{rel}: first sentence is not terminated (desc is one run-on sentence)")
    # Action-verb sanity: at least one of these verbs anywhere in the description
    if not re.search(r"\b(estimate|translate|validate|check|forecast|compare|record|plan|render|inspect|edit|search|list|detect|enforce|certify|map|count|add|apply|turn|produce|generate)\w*\b", desc, re.I):
        errors.append(f"{rel}: description contains no action verb")

    return errors


def find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for cand in (here, *here.parents):
        if (cand / "skills").is_dir():
            return cand
    raise SystemExit("FAIL: could not locate a 'skills/' directory above this script")


def main() -> int:
    repo_root = find_repo_root()
    skill_dirs = sorted((repo_root / "skills").iterdir())
    all_errors: list[str] = []
    found = 0
    for d in skill_dirs:
        if not d.is_dir():
            continue
        skill_md = d / "SKILL.md"
        if not skill_md.exists():
            all_errors.append(f"skills/{d.name}/: missing SKILL.md")
            continue
        found += 1
        # flat layout: no nested SKILL.md
        nested = [p for p in d.rglob("SKILL.md") if p != skill_md]
        for p in nested:
            all_errors.append(f"{p.relative_to(repo_root)}: nested SKILL.md violates flat layout")
        all_errors.extend(validate(skill_md, repo_root))

    if found == 0:
        print("FAIL: no skills found")
        return 1
    if all_errors:
        for e in all_errors:
            print(f"FAIL {e}")
        return 1
    print(f"OK: {found} skill(s) pass the description contract")
    return 0


if __name__ == "__main__":
    sys.exit(main())
