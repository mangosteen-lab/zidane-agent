"""Durable command journal (design decision D4).

The agent records every command it accepts and every result it produces, and only drops an
entry once the backend ACKs it. On startup, finished-but-unacked results are replayed via
RESUME. This is what makes result delivery survive an agent restart — the backend's
in-memory orphan map only survives while the *backend* process lives.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger("zidane.journal")

PHASE_ACCEPTED = "accepted"
PHASE_STARTED = "started"
PHASE_DONE = "done"


class Journal:
    def __init__(self, root: str | Path):
        self._root = Path(root)
        self._root.mkdir(parents=True, exist_ok=True)

    def _path(self, command_id: str) -> Path:
        safe = "".join(c for c in command_id if c.isalnum() or c in "-_")
        return self._root / f"{safe}.json"

    def write(self, command_id: str, phase: str, **fields: Any) -> None:
        entry = {"command_id": command_id, "phase": phase, **fields}
        path = self._path(command_id)
        temp = path.with_suffix(".tmp")
        try:
            temp.write_text(json.dumps(entry, default=str), encoding="utf-8")
            # Atomic replace: a crash mid-write must never leave a half-parsed entry that
            # would be silently skipped on replay.
            os.replace(temp, path)
        except OSError:
            logger.exception("failed to write journal entry for %s", command_id)

    def read(self, command_id: str) -> dict[str, Any] | None:
        path = self._path(command_id)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("discarding unreadable journal entry %s", command_id)
            return None

    def remove(self, command_id: str) -> None:
        try:
            self._path(command_id).unlink(missing_ok=True)
        except OSError:
            logger.debug("could not remove journal entry %s", command_id)

    def all_entries(self) -> list[dict[str, Any]]:
        entries = []
        for path in sorted(self._root.glob("*.json")):
            try:
                entries.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                logger.warning("discarding unreadable journal file %s", path.name)
                path.unlink(missing_ok=True)
        return entries

    def unacked_results(self) -> list[dict[str, Any]]:
        """Finished results waiting for an ACK, ready to replay in RESUME."""
        return [{"command_id": e["command_id"], "result": e.get("result") or {}}
                for e in self.all_entries()
                if e.get("phase") == PHASE_DONE and e.get("result")]

    def orphaned_started(self) -> list[dict[str, Any]]:
        """Commands that were running when the process died.

        Their process is gone with us, so they are reported LOST rather than left for the
        backend to time out.
        """
        return [e for e in self.all_entries() if e.get("phase") in
                {PHASE_ACCEPTED, PHASE_STARTED}]
