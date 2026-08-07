"""Script execution: write, launch, stream, harvest markers, enforce the timeout, kill.

Markers are parsed **here** rather than server-side (modric scrapes them back out of the
on-disk log). Parsing at the source means they work identically whatever log store the
backend uses, and the values arrive structured in COMMAND_DONE instead of being
re-extracted from text.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import signal
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from app.redaction import Redactor

logger = logging.getLogger("zidane.runner")

SCRIPT_TYPE_BAT = 1
SCRIPT_TYPE_PYTHON = 2
SCRIPT_TYPE_SHELL = 3
SCRIPT_TYPE_POWERSHELL = 4
SCRIPT_TYPE_RUBY = 5
SCRIPT_TYPE_PERL = 6

IS_WINDOWS = sys.platform.startswith("win")

_SET = re.compile(r"^\s*@zidane:set\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
_NOTIFY = re.compile(r"^\s*@zidane:notify\s+(.*)$")
_PROGRESS = re.compile(r"^\s*@zidane:progress\s+(\d{1,3})\s*(.*)$")
_ARTIFACT = re.compile(r"^\s*@zidane:artifact\s+(\S+)\s*(.*)$")

ChunkCallback = Callable[[str, str], Awaitable[None]]  # (stream, data)


@dataclass
class RunResult:
    status: str
    exit_code: int | None = None
    error: str = ""
    outputs: dict[str, str] = field(default_factory=dict)
    notify: list[str] = field(default_factory=list)
    progress: int | None = None
    artifacts: list[dict[str, str]] = field(default_factory=list)
    started_at: float = 0.0
    finished_at: float = 0.0

    def to_payload(self) -> dict[str, Any]:
        return {
            "status": self.status, "exit_code": self.exit_code, "error": self.error,
            "outputs": self.outputs, "notify": self.notify,
            "artifacts": self.artifacts,
            "started_at": self.started_at, "finished_at": self.finished_at,
        }


def _interpreter(script_type: int, path: Path) -> list[str]:
    if script_type == SCRIPT_TYPE_PYTHON:
        return [sys.executable, str(path)]
    if script_type == SCRIPT_TYPE_POWERSHELL:
        executable = shutil.which("pwsh") or shutil.which("powershell") or "pwsh"
        return [executable, "-NoProfile", "-NonInteractive", "-File", str(path)]
    if script_type == SCRIPT_TYPE_BAT:
        return ["cmd.exe", "/c", str(path)]
    if script_type == SCRIPT_TYPE_RUBY:
        return [shutil.which("ruby") or "ruby", str(path)]
    if script_type == SCRIPT_TYPE_PERL:
        return [shutil.which("perl") or "perl", str(path)]
    shell = shutil.which("bash") or shutil.which("sh") or "/bin/sh"
    return [shell, str(path)]


def _suffix(script_type: int) -> str:
    return {SCRIPT_TYPE_BAT: ".bat", SCRIPT_TYPE_PYTHON: ".py",
            SCRIPT_TYPE_SHELL: ".sh", SCRIPT_TYPE_POWERSHELL: ".ps1",
            SCRIPT_TYPE_RUBY: ".rb", SCRIPT_TYPE_PERL: ".pl"}.get(script_type, ".sh")


class ScriptRunner:
    """Runs one command. One instance per in-flight command."""

    def __init__(self, command: dict[str, Any], workdir_root: Path,
                 on_chunk: ChunkCallback):
        self._command = command
        self._workdir_root = workdir_root
        self._on_chunk = on_chunk
        # One redactor per stream: they are read independently, so a shared carry buffer
        # would interleave their tails and corrupt both.
        secrets = list(command.get("redact") or [])
        secrets += [str(v) for v in (command.get("secret_env") or {}).values() if v]
        self._redactors = {"stdout": Redactor(secrets), "stderr": Redactor(secrets)}
        self._process: asyncio.subprocess.Process | None = None
        self._result = RunResult(status="RUNNING")
        self._killed = False

    @property
    def pid(self) -> int | None:
        return self._process.pid if self._process is not None else None

    def _workdir(self) -> Path:
        if self._command.get("workdir_mode") == "sticky":
            # Sticky targets reuse one directory for the whole execution, which is the
            # entire point: build in one step, package the same tree in the next.
            path = self._workdir_root / str(self._command.get("workdir_key", "sticky"))
        else:
            path = self._workdir_root / str(self._command["command_id"])
        path.mkdir(parents=True, exist_ok=True)
        return path

    async def run(self) -> RunResult:
        workdir = self._workdir()
        script_type = int(self._command.get("script_type", SCRIPT_TYPE_SHELL))
        script_path = workdir / f"zidane_script{_suffix(script_type)}"
        script_path.write_text(self._command.get("script_content", ""), encoding="utf-8")
        if not IS_WINDOWS:
            script_path.chmod(0o700)

        env = {**os.environ}
        env.update({str(k): str(v) for k, v in (self._command.get("env") or {}).items()})
        env.update({str(k): str(v) for k, v in (self._command.get("secret_env") or {}).items()})
        env["ZIDANE_WORKDIR"] = str(workdir)

        argv = [*_interpreter(script_type, script_path),
                *[str(a) for a in self._command.get("args", [])]]
        timeout = int(self._command.get("timeout", 1800) or 1800)
        self._result.started_at = time.time()

        try:
            self._process = await asyncio.create_subprocess_exec(
                *argv, cwd=str(workdir), env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                # New session so a kill reaches the whole process tree, not just the
                # interpreter — a script that backgrounds work would otherwise survive.
                start_new_session=not IS_WINDOWS)
        except (OSError, FileNotFoundError) as exc:
            self._result.status = "FAILED"
            self._result.exit_code = -1
            self._result.error = f"could not start interpreter: {exc}"
            self._result.finished_at = time.time()
            return self._result

        readers = [
            asyncio.create_task(self._pump(self._process.stdout, "stdout")),
            asyncio.create_task(self._pump(self._process.stderr, "stderr")),
        ]
        try:
            exit_code = await asyncio.wait_for(self._process.wait(), timeout)
            self._result.exit_code = exit_code
            self._result.status = "COMPLETED" if exit_code == 0 else "FAILED"
            if exit_code != 0:
                self._result.error = f"exited with code {exit_code}"
        except asyncio.TimeoutError:
            await self.kill(grace_seconds=10)
            self._result.status = "TERMINATED"
            self._result.exit_code = -1
            self._result.error = f"timed out after {timeout}s"
        except asyncio.CancelledError:
            await self.kill(grace_seconds=5)
            self._result.status = "TERMINATED"
            self._result.error = "cancelled"
            raise
        finally:
            await asyncio.gather(*readers, return_exceptions=True)
            for stream, redactor in self._redactors.items():
                tail = redactor.flush()
                if tail:
                    await self._on_chunk(stream, tail)
            self._result.finished_at = time.time()
            if self._killed and self._result.status != "TERMINATED":
                self._result.status = "TERMINATED"
            self._cleanup(workdir)
        return self._result

    async def _pump(self, stream: asyncio.StreamReader | None, name: str) -> None:
        if stream is None:
            return
        buffer = ""
        while True:
            try:
                raw = await stream.read(8192)
            except (asyncio.CancelledError, ValueError):
                break
            if not raw:
                break
            text = raw.decode("utf-8", errors="replace")
            # Markers are line-oriented and stdout-only; keep a partial-line buffer so a
            # marker split across two reads is still recognised.
            if name == "stdout":
                buffer += text
                lines = buffer.split("\n")
                buffer = lines.pop()
                for line in lines:
                    self._harvest(line)
            await self._emit(name, text)
        if buffer:
            self._harvest(buffer)

    async def _emit(self, name: str, text: str) -> None:
        data = self._redactors[name].feed(text)
        if data:
            await self._on_chunk(name, data)

    def _harvest(self, line: str) -> None:
        if "@zidane:" not in line:
            return
        match = _SET.match(line)
        if match:
            self._result.outputs[match.group(1)] = match.group(2).strip()
            return
        match = _NOTIFY.match(line)
        if match:
            self._result.notify.append(match.group(1).strip())
            return
        match = _PROGRESS.match(line)
        if match:
            self._result.progress = min(100, int(match.group(1)))
            return
        match = _ARTIFACT.match(line)
        if match:
            path = match.group(1)
            self._result.artifacts.append(
                {"path": path, "name": match.group(2).strip() or Path(path).name})

    async def kill(self, grace_seconds: int = 10) -> None:
        """SIGTERM the process group, then SIGKILL after the grace period."""
        process = self._process
        if process is None or process.returncode is not None:
            return
        self._killed = True
        try:
            if IS_WINDOWS:
                process.terminate()
            else:
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            return
        try:
            await asyncio.wait_for(process.wait(), grace_seconds)
            return
        except asyncio.TimeoutError:
            pass
        try:
            if IS_WINDOWS:
                process.kill()
            else:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass

    def _cleanup(self, workdir: Path) -> None:
        if self._command.get("workdir_mode") == "sticky":
            return  # a later step in the same execution needs this tree
        shutil.rmtree(workdir, ignore_errors=True)


def default_workdir_root() -> Path:
    root = os.environ.get("ZIDANE_AGENT_WORKDIR")
    if root:
        return Path(root)
    return Path(tempfile.gettempdir()) / "zidane-work"
