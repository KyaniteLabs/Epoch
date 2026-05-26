# Epoch cleanup rescue bundle

Created before cleanup so no untracked/stashed/branch-only work is lost.

Contents:
- stash-*.patch / stash-*.sha / stash-summary.txt: local stashes exported before any stash cleanup.
- remote-*.patch / remote-branches.json: remote branch-only diffs versus origin/main before branch cleanup.
- mac-mini-active/: working diff/status from active autonomous clone.
- mac-mini-old/: conflicted old mac-mini clone status, index/working patches, divergence, and stash export.

Restore examples:
- Apply a stash export: git apply rescue/.../stash-N.patch
- Inspect remote branch work: git log or git apply --check rescue/.../remote-*.patch
- Old mac-mini clone was intentionally not used for automation; active clone is separate.
