"""X-SHLEX: Windows backslash paths survive command splitting."""


def test_windows_paths_keep_their_backslashes(plugin):
    cmd = r'"C:\Program Files\nodejs\npx.cmd" -y @kyanitelabs/epoch@0.8.0'
    assert plugin._split_command(cmd, windows=True) == [
        r"C:\Program Files\nodejs\npx.cmd", "-y", "@kyanitelabs/epoch@0.8.0"]
    assert plugin._split_command(r"C:\tools\epoch.cmd serve", windows=True) == [r"C:\tools\epoch.cmd", "serve"]


def test_posix_splitting_is_unchanged(plugin):
    assert plugin._split_command(r"npx -y 'a b' c\ d", windows=False) == ["npx", "-y", "a b", "c d"]
    assert plugin._split_command("") == []
