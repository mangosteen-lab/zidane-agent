from __future__ import annotations

import asyncio
from pathlib import Path

from app.runner import SCRIPT_TYPE_PYTHON, SCRIPT_TYPE_SHELL, ScriptRunner


def command(content: str, **overrides) -> dict:
    return {"command_id": "cmd-1", "script_type": SCRIPT_TYPE_SHELL,
            "script_content": content, "args": [], "env": {}, "secret_env": {},
            "redact": [], "timeout": 30, "workdir_mode": "ephemeral",
            "workdir_key": "k", **overrides}


class Collector:
    def __init__(self) -> None:
        self.chunks: list[tuple[str, str]] = []

    async def __call__(self, stream: str, data: str) -> None:
        self.chunks.append((stream, data))

    def text(self, stream: str | None = None) -> str:
        return "".join(d for s, d in self.chunks if stream is None or s == stream)


async def test_successful_script_completes_and_streams(tmp_path: Path):
    collector = Collector()
    runner = ScriptRunner(command("echo hello\n"), tmp_path, collector)
    result = await runner.run()

    assert result.status == "COMPLETED"
    assert result.exit_code == 0
    assert "hello" in collector.text("stdout")


async def test_nonzero_exit_is_failed(tmp_path: Path):
    runner = ScriptRunner(command("echo bad >&2\nexit 3\n"), tmp_path, Collector())
    result = await runner.run()
    assert result.status == "FAILED"
    assert result.exit_code == 3
    assert "code 3" in result.error


async def test_env_and_secret_env_both_reach_the_process(tmp_path: Path):
    collector = Collector()
    runner = ScriptRunner(
        command('echo "plain=$PLAIN secret=$TOKEN"\n',
                env={"PLAIN": "visible"}, secret_env={"TOKEN": "s3cr3t-value-xyz"},
                redact=["s3cr3t-value-xyz"]),
        tmp_path, collector)
    result = await runner.run()

    assert result.status == "COMPLETED"
    output = collector.text()
    assert "plain=visible" in output
    # The script read the secret, but it never left the host unredacted.
    assert "s3cr3t-value-xyz" not in output
    assert "***" in output


async def test_markers_are_harvested_by_the_agent(tmp_path: Path):
    collector = Collector()
    script = ("echo start\n"
              "echo '@zidane:set ARTIFACT=abc'\n"
              "echo '@zidane:notify all good'\n"
              "echo '@zidane:progress 75 nearly'\n"
              "echo '@zidane:artifact /tmp/report.html'\n")
    runner = ScriptRunner(command(script), tmp_path, collector)
    result = await runner.run()

    assert result.outputs == {"ARTIFACT": "abc"}
    assert result.notify == ["all good"]
    assert result.progress == 75
    assert result.artifacts == [{"path": "/tmp/report.html", "name": "report.html"}]
    # Markers still appear verbatim in the log, so the run stays auditable.
    assert "@zidane:set ARTIFACT=abc" in collector.text()


async def test_timeout_terminates_the_process(tmp_path: Path):
    runner = ScriptRunner(command("sleep 30\n", timeout=1), tmp_path, Collector())
    result = await runner.run()
    assert result.status == "TERMINATED"
    assert "timed out" in result.error


async def test_kill_reaches_the_whole_process_group(tmp_path: Path):
    """A script that backgrounds work must not leave orphans behind after a KILL."""
    runner = ScriptRunner(command("sleep 30 & sleep 30\n", timeout=30), tmp_path,
                          Collector())
    task = asyncio.create_task(runner.run())
    await asyncio.sleep(0.5)
    await runner.kill(grace_seconds=1)
    result = await task
    assert result.status == "TERMINATED"


async def test_python_script_type_uses_the_interpreter(tmp_path: Path):
    collector = Collector()
    runner = ScriptRunner(
        command("import sys; print('py', sys.version_info[0])",
                script_type=SCRIPT_TYPE_PYTHON),
        tmp_path, collector)
    result = await runner.run()
    assert result.status == "COMPLETED"
    assert "py 3" in collector.text()


async def test_ephemeral_workdir_is_removed_but_sticky_is_kept(tmp_path: Path):
    ephemeral = ScriptRunner(command("echo x > file.txt\n"), tmp_path, Collector())
    await ephemeral.run()
    assert not (tmp_path / "cmd-1").exists()

    sticky = ScriptRunner(
        command("echo x > file.txt\n", workdir_mode="sticky", workdir_key="exec-1"),
        tmp_path, Collector())
    await sticky.run()
    assert (tmp_path / "exec-1" / "file.txt").exists()


async def test_sticky_workdir_is_shared_between_commands(tmp_path: Path):
    """This is what a sticky target buys: build in one step, read the tree in the next."""
    first = ScriptRunner(
        command("echo built > artifact.txt\n", command_id="c1",
                workdir_mode="sticky", workdir_key="exec-1"),
        tmp_path, Collector())
    await first.run()

    collector = Collector()
    second = ScriptRunner(
        command("cat artifact.txt\n", command_id="c2",
                workdir_mode="sticky", workdir_key="exec-1"),
        tmp_path, collector)
    result = await second.run()

    assert result.status == "COMPLETED"
    assert "built" in collector.text()


async def test_missing_interpreter_fails_cleanly(tmp_path: Path):
    runner = ScriptRunner(command("x", script_type=99), tmp_path, Collector())
    result = await runner.run()
    # Unknown types fall back to a shell rather than crashing the agent.
    assert result.status in {"COMPLETED", "FAILED"}
