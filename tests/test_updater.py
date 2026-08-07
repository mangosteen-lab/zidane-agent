"""Self-upgrade: versioned install, atomic flip, and rollback."""
from __future__ import annotations

import hashlib
import tarfile
from pathlib import Path

import pytest

from app.updater import Updater, UpgradeError, UpgradeSpec, _version_tuple


def make_artifact(tmp_path: Path, name: str = "agent.tar.gz",
                  content: str = "print('hi')\n") -> Path:
    payload = tmp_path / "payload"
    payload.mkdir(exist_ok=True)
    (payload / "app").mkdir(exist_ok=True)
    (payload / "app" / "main.py").write_text(content)
    archive = tmp_path / name
    with tarfile.open(archive, "w:gz") as handle:
        handle.add(payload / "app", arcname="app")
    return archive


def test_version_comparison():
    assert _version_tuple("1.2.3") > _version_tuple("1.2.2")
    assert _version_tuple("0.10.0") > _version_tuple("0.9.9")
    assert _version_tuple("garbage") == (0, 0, 0)


def test_is_newer(tmp_path: Path):
    updater = Updater(tmp_path, "0.2.0")
    assert updater.is_newer("0.3.0")
    assert not updater.is_newer("0.2.0")
    assert not updater.is_newer("0.1.9")


async def test_install_and_activate_flips_the_symlink(tmp_path: Path):
    updater = Updater(tmp_path, "0.1.0")
    archive = make_artifact(tmp_path)
    spec = UpgradeSpec(version="0.2.0", url="file:///x")

    await updater.install(spec, archive)
    updater.activate("0.2.0")

    assert updater.current_link.is_symlink()
    assert updater.current_link.resolve().name == "0.2.0"
    assert (updater.current_link / "app" / "main.py").exists()
    # The archive is consumed, not left in /tmp.
    assert not archive.exists()


async def test_rollback_restores_the_previous_version(tmp_path: Path):
    """The reason installs go into a new directory: an in-place overwrite has nothing to
    go back to."""
    updater = Updater(tmp_path, "0.1.0")
    await updater.install(UpgradeSpec(version="0.1.0", url="x"),
                          make_artifact(tmp_path, "a.tar.gz", "old\n"))
    updater.activate("0.1.0")
    await updater.install(UpgradeSpec(version="0.2.0", url="x"),
                          make_artifact(tmp_path, "b.tar.gz", "new\n"))
    updater.activate("0.2.0")
    assert (updater.current_link / "app" / "main.py").read_text() == "new\n"

    restored = updater.rollback()
    assert restored == "0.1.0"
    assert (updater.current_link / "app" / "main.py").read_text() == "old\n"


async def test_rollback_marker_is_written_and_cleared(tmp_path: Path):
    updater = Updater(tmp_path, "0.1.0")
    await updater.install(UpgradeSpec(version="0.2.0", url="x"), make_artifact(tmp_path))
    updater.activate("0.2.0")

    pending = updater.pending_rollback()
    assert pending["attempted"] == "0.2.0"

    # Cleared once the new version re-registers — that is what "the upgrade stuck" means.
    updater.clear_rollback()
    assert updater.pending_rollback() is None


def test_rollback_without_a_marker_is_an_error(tmp_path: Path):
    with pytest.raises(UpgradeError, match="nothing to roll back"):
        Updater(tmp_path, "0.1.0").rollback()


async def test_checksum_mismatch_refuses_to_install(tmp_path: Path, monkeypatch):
    """Publishing a digest and not enforcing it makes the check decorative."""
    archive = make_artifact(tmp_path, "signed.tar.gz")
    updater = Updater(tmp_path / "root", "0.1.0")

    class _Response:
        def __enter__(self):
            return archive.open("rb")

        def __exit__(self, *exc):
            return False

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: _Response())

    real = hashlib.sha256(archive.read_bytes()).hexdigest()
    with pytest.raises(UpgradeError, match="checksum mismatch"):
        await updater.download(UpgradeSpec(
            version="0.2.0", url="https://example.com/a.tar.gz", sha256="0" * 64))

    # The matching digest is accepted.
    path = await updater.download(UpgradeSpec(
        version="0.2.0", url="https://example.com/a.tar.gz", sha256=real))
    assert path.exists()
    path.unlink(missing_ok=True)


async def test_unverified_http_artifact_is_refused_before_downloading(tmp_path: Path,
                                                                      monkeypatch):
    """No digest and no TLS means no provenance — and we refuse without fetching."""
    fetched = []

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen",
                        lambda *a, **k: fetched.append(a) or (_ for _ in ()).throw(
                            AssertionError("should not have been fetched")))

    updater = Updater(tmp_path, "0.1.0")
    with pytest.raises(UpgradeError, match="unverified"):
        await updater.download(UpgradeSpec(version="0.2.0",
                                           url="http://example.com/a.tar.gz"))
    assert fetched == []


async def test_archive_escaping_the_target_is_rejected(tmp_path: Path):
    """Path traversal in an artifact would let a compromised release write anywhere."""
    evil = tmp_path / "evil.tar.gz"
    victim = tmp_path / "outside.txt"
    victim.write_text("original")
    with tarfile.open(evil, "w:gz") as handle:
        handle.add(victim, arcname="../outside.txt")

    updater = Updater(tmp_path / "root", "0.1.0")
    with pytest.raises(UpgradeError, match="escapes the target"):
        await updater.install(UpgradeSpec(version="0.2.0", url="x"), evil)


async def test_empty_artifact_is_rejected(tmp_path: Path):
    empty = tmp_path / "empty.tar.gz"
    with tarfile.open(empty, "w:gz"):
        pass
    updater = Updater(tmp_path / "root", "0.1.0")
    with pytest.raises(UpgradeError, match="empty"):
        await updater.install(UpgradeSpec(version="0.2.0", url="x"), empty)


async def test_prune_keeps_only_the_most_recent_versions(tmp_path: Path):
    updater = Updater(tmp_path, "0.1.0")
    for version in ("0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0"):
        await updater.install(UpgradeSpec(version=version, url="x"),
                              make_artifact(tmp_path, f"{version}.tar.gz"))
    removed = updater.prune(keep=3)

    assert sorted(removed) == ["0.1.0", "0.2.0"]
    remaining = sorted(p.name for p in updater.versions_dir.iterdir())
    assert remaining == ["0.3.0", "0.4.0", "0.5.0"]
