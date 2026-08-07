"""Self-upgrade: download, verify, install beside the current version, flip, restart.

The layout is what makes rollback real:

    <install_root>/versions/0.1.0/     previous
    <install_root>/versions/0.2.0/     newly installed
    <install_root>/current -> versions/0.2.0

Installing into a *new directory* and moving a symlink means a failed upgrade is undone by
pointing the link back — an in-place overwrite has nothing to go back to. The launcher
checks whether the new version re-registered and rolls back if it did not.

Nothing here runs while a command is in flight; the client replies `UPGRADE_DEFERRED` and
retries once the agent is idle.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
import sys
import tarfile
import tempfile
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("zidane.updater")

ROLLBACK_MARKER = "rollback.json"
DOWNLOAD_TIMEOUT = 300


class UpgradeError(RuntimeError):
    pass


@dataclass
class UpgradeSpec:
    version: str
    url: str
    sha256: str = ""

    @property
    def valid(self) -> bool:
        return bool(self.version and self.url)


class Updater:
    def __init__(self, install_root: str | Path, current_version: str):
        self._root = Path(install_root)
        self._current_version = current_version

    @property
    def versions_dir(self) -> Path:
        return self._root / "versions"

    @property
    def current_link(self) -> Path:
        return self._root / "current"

    def is_newer(self, version: str) -> bool:
        return _version_tuple(version) > _version_tuple(self._current_version)

    # ------------------------------------------------------------- download
    async def download(self, spec: UpgradeSpec) -> Path:
        import urllib.request

        # Refuse *before* fetching: downloading an artifact we have already decided not
        # to trust wastes bandwidth and briefly puts it on disk for nothing.
        if not spec.sha256 and not spec.url.startswith("https://"):
            raise UpgradeError(
                "refusing to install an unverified artifact over a non-HTTPS URL; "
                "publish a sha256 in the release manifest")

        def fetch() -> Path:
            handle = tempfile.NamedTemporaryFile(delete=False, suffix=_suffix(spec.url))
            with urllib.request.urlopen(spec.url, timeout=DOWNLOAD_TIMEOUT) as response:
                shutil.copyfileobj(response, handle)
            handle.close()
            return Path(handle.name)

        path = await asyncio.to_thread(fetch)
        if spec.sha256:
            actual = await asyncio.to_thread(_sha256, path)
            if actual.lower() != spec.sha256.lower():
                path.unlink(missing_ok=True)
                # Refusing a mismatched artifact is the whole point of publishing the
                # digest; installing it anyway would make the check decorative.
                raise UpgradeError(
                    f"artifact checksum mismatch: expected {spec.sha256}, got {actual}")
        return path

    # -------------------------------------------------------------- install
    async def install(self, spec: UpgradeSpec, archive: Path) -> Path:
        target = self.versions_dir / spec.version
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        target.mkdir(parents=True, exist_ok=True)
        try:
            await asyncio.to_thread(_extract, archive, target)
        finally:
            archive.unlink(missing_ok=True)
        if not any(target.iterdir()):
            shutil.rmtree(target, ignore_errors=True)
            raise UpgradeError("the downloaded artifact was empty")
        return target

    def activate(self, version: str) -> None:
        """Point `current` at a version, recording what to go back to."""
        target = self.versions_dir / version
        if not target.exists():
            raise UpgradeError(f"version {version} is not installed")
        previous = ""
        if self.current_link.is_symlink():
            previous = Path(os.readlink(self.current_link)).name
        (self._root / ROLLBACK_MARKER).write_text(json.dumps({
            "previous": previous or self._current_version,
            "attempted": version, "at": time.time()}), encoding="utf-8")

        temporary = self._root / "current.new"
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(target, target_is_directory=True)
        # os.replace on a symlink is atomic, so a crash mid-flip cannot leave the agent
        # with no `current` at all.
        os.replace(temporary, self.current_link)
        logger.info("activated version %s (previous %s)", version, previous)

    def rollback(self) -> str:
        marker = self._root / ROLLBACK_MARKER
        if not marker.exists():
            raise UpgradeError("no rollback marker; nothing to roll back to")
        data = json.loads(marker.read_text(encoding="utf-8"))
        previous = data.get("previous", "")
        if not previous:
            raise UpgradeError("rollback marker has no previous version")
        self.activate(previous)
        marker.unlink(missing_ok=True)
        logger.warning("rolled back to version %s", previous)
        return previous

    def clear_rollback(self) -> None:
        """Called once the new version has re-registered — the upgrade stuck."""
        (self._root / ROLLBACK_MARKER).unlink(missing_ok=True)

    def pending_rollback(self) -> dict | None:
        marker = self._root / ROLLBACK_MARKER
        if not marker.exists():
            return None
        try:
            return json.loads(marker.read_text(encoding="utf-8"))
        except ValueError:
            return None

    def prune(self, keep: int = 3) -> list[str]:
        if not self.versions_dir.exists():
            return []
        versions = sorted((p for p in self.versions_dir.iterdir() if p.is_dir()),
                          key=lambda p: _version_tuple(p.name), reverse=True)
        removed = []
        for path in versions[keep:]:
            shutil.rmtree(path, ignore_errors=True)
            removed.append(path.name)
        return removed

    # -------------------------------------------------------------- restart
    def restart(self) -> None:
        """Hand off to the freshly activated version.

        Under a service manager, exiting is enough — systemd/SCM restarts us and the
        symlink now points at the new tree. Standalone, re-exec in place.
        """
        if os.environ.get("ZIDANE_MANAGED_BY_SERVICE") == "1":
            logger.info("exiting for the service manager to restart the new version")
            raise SystemExit(0)
        logger.info("re-executing into the new version")
        os.execv(sys.executable, [sys.executable, "-m", "app.main", *sys.argv[1:]])


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _extract(archive: Path, target: Path) -> None:
    name = archive.name.lower()
    if name.endswith((".tar.gz", ".tgz", ".tar")):
        with tarfile.open(archive) as handle:
            _safe_extract_tar(handle, target)
    elif name.endswith((".zip", ".whl")):
        with zipfile.ZipFile(archive) as handle:
            _safe_extract_zip(handle, target)
    else:
        raise UpgradeError(f"unsupported artifact type: {archive.name}")


def _safe_extract_tar(handle: tarfile.TarFile, target: Path) -> None:
    """Reject entries that escape the target directory (path traversal)."""
    resolved = target.resolve()
    for member in handle.getmembers():
        destination = (resolved / member.name).resolve()
        if not str(destination).startswith(str(resolved)):
            raise UpgradeError(f"archive entry escapes the target: {member.name}")
    handle.extractall(target, filter="data")  # entries validated above


def _safe_extract_zip(handle: zipfile.ZipFile, target: Path) -> None:
    resolved = target.resolve()
    for name in handle.namelist():
        destination = (resolved / name).resolve()
        if not str(destination).startswith(str(resolved)):
            raise UpgradeError(f"archive entry escapes the target: {name}")
    handle.extractall(target)  # noqa: S202 - entries validated above


def _suffix(url: str) -> str:
    for candidate in (".tar.gz", ".tgz", ".tar", ".zip", ".whl"):
        if url.lower().endswith(candidate):
            return candidate
    return ".tar.gz"


def _version_tuple(version: str) -> tuple[int, ...]:
    parts: list[int] = []
    for chunk in (version or "0").split("."):
        digits = "".join(c for c in chunk if c.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts + [0, 0, 0])[:3]
