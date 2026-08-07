"""The version lives in two files and they have to agree.

`pyproject.toml` names the wheel and the release tarball; `app/client.py` holds what the
agent actually reports in its REGISTER frame, which is what the backend compares against
`ZIDANE_AGENT_RELEASE_VERSION` to decide whether to offer an upgrade.

If they drift, the release looks fine and the fleet upgrades in a loop: the backend keeps
offering a version the agent never claims to have reached. `scripts/release.sh` and the
release workflow both check this, but only after someone has already tried to cut a
release — this catches it in `make check`.
"""
from __future__ import annotations

import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_pyproject_and_client_agree_on_the_version():
    packaged = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["version"]
    reported = re.search(r'AGENT_VERSION = "([^"]+)"',
                         (ROOT / "app" / "client.py").read_text()).group(1)
    assert packaged == reported, (
        f"pyproject.toml says {packaged} but app/client.py reports {reported}; "
        "bump both (scripts/release.sh does)")


def test_the_release_scripts_bump_both_files():
    """A guard on the guard: if the bump in release.sh ever stops touching one of the two
    files, this test is the only thing standing between that and a looping fleet."""
    release = (ROOT / "scripts" / "release.sh").read_text()
    assert "pyproject.toml" in release
    assert "app/client.py" in release
