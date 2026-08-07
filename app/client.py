"""The agent's WebSocket client — agent side of docs/design/02-agent-protocol.md.

Outbound-only: the agent dials the backend, so hosts behind NAT need no inbound rules.
Any protocol change lands here and in `zidane-backend/app/ws/agent_ws.py` together.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import platform
import random
import socket
import time
from typing import Any

import websockets

from app.config import AgentConfig, apply_remote_config, format_labels, parse_labels
from app.journal import PHASE_ACCEPTED, PHASE_DONE, PHASE_STARTED, Journal
from app.runner import RunResult, ScriptRunner
from app.updater import Updater, UpgradeError, UpgradeSpec

logger = logging.getLogger("zidane.client")

PROTOCOL_VERSION = 1
AGENT_VERSION = "0.0.2"

# Log flow control: batch small writes, and stop sending once too many chunks are
# unacked so one chatty task cannot starve the socket.
FLUSH_BYTES = 8192
FLUSH_INTERVAL = 0.25
MAX_UNACKED_CHUNKS = 256

try:  # pragma: no cover - optional
    import psutil
except ImportError:  # pragma: no cover
    psutil = None


class _LogStreamer:
    """Batches a command's output into LOG_CHUNK frames."""

    def __init__(self, client: "AgentClient", command_id: str):
        self._client = client
        self._command_id = command_id
        self._seq = 0
        self._acked = 0
        self._pending: dict[str, list[str]] = {"stdout": [], "stderr": []}
        self._size = 0
        self._lock = asyncio.Lock()
        self._flusher: asyncio.Task | None = None

    def start(self) -> None:
        self._flusher = asyncio.create_task(self._flush_loop())

    async def _flush_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(FLUSH_INTERVAL)
                await self.flush()
        except asyncio.CancelledError:
            return

    async def add(self, stream: str, data: str) -> None:
        async with self._lock:
            self._pending[stream].append(data)
            self._size += len(data)
        if self._size >= FLUSH_BYTES:
            await self.flush()

    async def flush(self) -> None:
        async with self._lock:
            batches = {s: "".join(parts) for s, parts in self._pending.items() if parts}
            self._pending = {"stdout": [], "stderr": []}
            self._size = 0
        for stream, data in batches.items():
            while self._seq - self._acked > MAX_UNACKED_CHUNKS:
                await asyncio.sleep(0.05)
            self._seq += 1
            await self._client.send({
                "type": "LOG_CHUNK", "agent_id": self._client.agent_id,
                "command_id": self._command_id, "seq": self._seq,
                "stream": stream, "data": data})

    def ack(self, seq: int) -> None:
        self._acked = max(self._acked, seq)

    async def close(self) -> None:
        if self._flusher is not None:
            self._flusher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._flusher
        await self.flush()

    @property
    def last_seq(self) -> int:
        return self._seq


class AgentClient:
    def __init__(self, config: AgentConfig):
        self.config = config
        self.agent_id: str = ""
        self._ws: Any = None
        self._journal = Journal(config.journal_dir)
        self._running: dict[str, ScriptRunner] = {}
        self._streamers: dict[str, _LogStreamer] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._draining = False
        self._stop = asyncio.Event()
        self._send_lock = asyncio.Lock()

    # ------------------------------------------------------------- lifecycle
    async def run(self) -> None:
        delay = self.config.reconnect_min
        while not self._stop.is_set():
            try:
                await self._connect_once()
                delay = self.config.reconnect_min
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - reconnect is the normal path
                logger.warning("connection failed (%s); retrying in %.1fs",
                               exc, delay)
            if self._stop.is_set():
                break
            # Jittered backoff so a fleet reconnecting after a backend deploy does not
            # arrive as a thundering herd.
            await asyncio.sleep(delay * (0.5 + random.random()))
            delay = min(self.config.reconnect_max, delay * 2)

    def stop(self) -> None:
        self._stop.set()

    async def _connect_once(self) -> None:
        url = self.config.wss_url
        if not url:
            raise RuntimeError("no backend wss_url configured")
        logger.info("connecting to %s", url)
        async with websockets.connect(url, ping_interval=None,
                                      max_size=16 * 1024 * 1024) as ws:
            self._ws = ws
            try:
                if not await self._register():
                    return
                await self._resume()
                async for raw in ws:
                    await self._handle(json.loads(raw))
            finally:
                self._ws = None

    # -------------------------------------------------------------- register
    async def _register(self) -> bool:
        payload = {
            "type": "REGISTER",
            "protocol_version": PROTOCOL_VERSION,
            "agent_version": AGENT_VERSION,
            "version_code": _version_code(AGENT_VERSION),
            "name": self.config.name,
            "hostname": socket.gethostname(),
            "ip": _local_ip(),
            "os": platform.system().lower(),
            "arch": platform.machine(),
            "container": _in_container(),
            "capacity": self.config.capacity,
            "labels": self.config.labels,
            "machine_version": self.config.read_machine_version(),
            "auto_upgrade": self.config.auto_upgrade,
            "upgrade_channel": self.config.upgrade_channel,
            "in_flight": list(self._running),
            **_resource_stats(),
        }
        token = self.config.read_session_token()
        if token:
            payload["session_token"] = token
        payload["api_key"] = self.config.api_key

        await self.send(payload)
        reply = json.loads(await self._ws.recv())
        if reply.get("type") == "UPGRADE_REQUIRED":
            logger.error("backend requires agent protocol >= %s; upgrade this agent",
                         reply.get("min_protocol_version"))
            return False
        if reply.get("type") != "REGISTERED":
            logger.error("registration rejected: %s", reply.get("message", reply))
            self.config.write_session_token("")  # a stale token must not loop forever
            return False

        self.agent_id = reply["agent_id"]
        self.config.write_session_token(reply.get("session_token", ""))
        effective = reply.get("effective_labels")
        if effective and effective != self.config.labels:
            logger.warning("backend applied different labels: %s (local: %s)",
                           effective, self.config.labels)
        capacity = reply.get("effective_capacity")
        if capacity and int(capacity) != self.config.capacity:
            logger.info("backend set capacity to %s", capacity)
            self.config.capacity = int(capacity)
        logger.info("registered as %s", self.agent_id)
        return True

    async def _resume(self) -> None:
        """Replay results the backend never acked, and report anything that was running
        when this process died."""
        unacked = self._journal.unacked_results()
        for entry in self._journal.orphaned_started():
            command_id = entry["command_id"]
            if command_id in self._running:
                continue
            result = {"type": "COMMAND_DONE", "agent_id": self.agent_id,
                      "command_id": command_id, "status": "LOST", "exit_code": -1,
                      "error": "agent restarted while this command was running"}
            self._journal.write(command_id, PHASE_DONE, result=result)
            unacked.append({"command_id": command_id, "result": result})
        if unacked:
            logger.info("replaying %d journalled result(s)", len(unacked))
            await self.send({"type": "RESUME", "agent_id": self.agent_id,
                             "unacked": unacked})

    # -------------------------------------------------------------- messages
    async def _handle(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "PING":
            await self.send({"type": "PONG", "agent_id": self.agent_id,
                             "ts": msg.get("ts", time.time()),
                             "machine_version": self.config.read_machine_version(),
                             "in_flight": len(self._running),
                             "capacity": self.config.capacity,
                             **_resource_stats()})
        elif kind == "EXECUTE":
            await self._on_execute(msg)
        elif kind == "KILL":
            await self._on_kill(msg)
        elif kind == "ACK":
            self._on_ack(msg)
        elif kind == "DRAIN":
            self._draining = bool(msg.get("drain", True))
            logger.info("drain mode %s", "on" if self._draining else "off")
        elif kind in {"SET_CAPACITY", "SET_LABELS", "SET_CONFIG"}:
            await self._on_config(kind, msg)
        elif kind == "SET_MACHINE_VERSION":
            await self._on_machine_version(msg)
        elif kind == "UPGRADE_AVAILABLE":
            await self._on_upgrade(msg)
        elif kind == "ERROR":
            logger.error("backend error: %s", msg.get("message"))
        else:
            logger.debug("ignoring message type %s", kind)

    async def _on_execute(self, msg: dict[str, Any]) -> None:
        command_id = msg.get("command_id", "")
        if self._draining:
            await self.send({"type": "COMMAND_REJECTED", "agent_id": self.agent_id,
                             "command_id": command_id, "reason": "agent is draining"})
            return
        if len(self._running) >= self.config.capacity:
            # The backend's slot accounting should prevent this, but rejecting rather
            # than queueing lets it re-place the task immediately instead of burning the
            # step's timeout.
            await self.send({"type": "COMMAND_REJECTED", "agent_id": self.agent_id,
                             "command_id": command_id, "reason": "at capacity"})
            return
        if command_id in self._running:
            return  # duplicate dispatch; already have it

        self._journal.write(command_id, PHASE_ACCEPTED)
        await self.send({"type": "COMMAND_ACCEPTED", "agent_id": self.agent_id,
                         "command_id": command_id})
        self._tasks[command_id] = asyncio.create_task(self._execute(msg))

    async def _execute(self, msg: dict[str, Any]) -> None:
        command_id = msg["command_id"]
        streamer = _LogStreamer(self, command_id)
        self._streamers[command_id] = streamer
        streamer.start()

        runner = ScriptRunner(msg, self.config.workdir_root, streamer.add)
        self._running[command_id] = runner
        result = RunResult(status="FAILED", exit_code=-1)
        try:
            self._journal.write(command_id, PHASE_STARTED)
            started = asyncio.create_task(self._announce_started(command_id, runner))
            result = await runner.run()
            started.cancel()
        except asyncio.CancelledError:
            result = RunResult(status="TERMINATED", exit_code=-1, error="cancelled")
        except Exception as exc:  # noqa: BLE001 - must always report something
            logger.exception("command %s crashed", command_id)
            result = RunResult(status="FAILED", exit_code=-1, error=str(exc))
        finally:
            await streamer.close()
            self._running.pop(command_id, None)
            self._streamers.pop(command_id, None)
            self._tasks.pop(command_id, None)

        payload = {"type": "COMMAND_DONE", "agent_id": self.agent_id,
                   "command_id": command_id, "last_seq": streamer.last_seq,
                   **result.to_payload()}
        # Journal before sending: if the socket is down, RESUME replays this on reconnect.
        self._journal.write(command_id, PHASE_DONE, result=payload)
        await self.send(payload)

    async def _announce_started(self, command_id: str, runner: ScriptRunner) -> None:
        for _ in range(50):
            if runner.pid is not None:
                await self.send({"type": "COMMAND_STARTED", "agent_id": self.agent_id,
                                 "command_id": command_id, "pid": runner.pid,
                                 "started_at": time.time()})
                return
            await asyncio.sleep(0.05)

    async def _on_kill(self, msg: dict[str, Any]) -> None:
        runner = self._running.get(msg.get("command_id", ""))
        if runner is not None:
            await runner.kill(int(msg.get("grace_seconds", 10)))

    def _on_ack(self, msg: dict[str, Any]) -> None:
        for command_id in msg.get("command_ids") or []:
            self._journal.remove(command_id)
        for command_id, seq in (msg.get("log_seq") or {}).items():
            streamer = self._streamers.get(command_id)
            if streamer is not None:
                streamer.ack(int(seq))

    async def _on_config(self, kind: str, msg: dict[str, Any]) -> None:
        try:
            if kind == "SET_CAPACITY":
                capacity = int(msg["capacity"])
                applied = apply_remote_config(self.config, {"agent.capacity": str(capacity)})
                self.config.capacity = capacity
            elif kind == "SET_LABELS":
                labels = {str(k): str(v) for k, v in (msg.get("labels") or {}).items()}
                applied = apply_remote_config(
                    self.config, {"agent.labels": format_labels(labels)})
                self.config.labels = labels
            else:
                updates = {str(k): str(v) for k, v in (msg.get("keys") or {}).items()}
                applied = apply_remote_config(self.config, updates)
                if "agent.labels" in updates:
                    self.config.labels = parse_labels(updates["agent.labels"])
        except (ValueError, KeyError, OSError) as exc:
            await self.send({"type": "CONFIG_REJECTED", "agent_id": self.agent_id,
                             "reason": str(exc)})
            return
        await self.send({"type": "CONFIG_UPDATED", "agent_id": self.agent_id,
                         "applied": applied})

    async def _on_machine_version(self, msg: dict[str, Any]) -> None:
        try:
            value = int(msg.get("machine_version", 0))
            if value < 0:
                raise ValueError("machine_version must be non-negative")
            self.config.write_machine_version(value)
        except (ValueError, TypeError, OSError) as exc:
            await self.send({"type": "MACHINE_VERSION_REJECTED",
                             "agent_id": self.agent_id, "reason": str(exc)})
            return
        await self.send({"type": "MACHINE_VERSION_UPDATED", "agent_id": self.agent_id,
                         "machine_version": value})

    async def _on_upgrade(self, msg: dict[str, Any]) -> None:
        if _in_container():
            # Containers upgrade by rolling the image; flipping a symlink inside one
            # would be undone by the next deploy.
            await self.send({"type": "UPGRADE_SKIPPED", "agent_id": self.agent_id,
                             "reason": "containers upgrade by rolling the image"})
            return
        if self._running:
            await self.send({"type": "UPGRADE_DEFERRED", "agent_id": self.agent_id,
                             "reason": f"{len(self._running)} command(s) in flight"})
            return

        spec = UpgradeSpec(version=str(msg.get("version", "")),
                           url=str(msg.get("artifact_url") or msg.get("url", "")),
                           sha256=str(msg.get("sha256", "")))
        if not spec.valid:
            spec = await self._fetch_release(msg.get("channel", "stable"))
        if spec is None or not spec.valid:
            await self.send({"type": "UPGRADE_SKIPPED", "agent_id": self.agent_id,
                             "reason": "no release artifact is configured on the backend"})
            return

        updater = Updater(self.config.install_root, AGENT_VERSION)
        if not msg.get("forced") and not updater.is_newer(spec.version):
            await self.send({"type": "UPGRADE_SKIPPED", "agent_id": self.agent_id,
                             "reason": f"already running {AGENT_VERSION}"})
            return

        self._draining = True   # take no new work while swapping the tree underneath us
        await self.send({"type": "UPGRADE_STARTED", "agent_id": self.agent_id,
                         "version": spec.version})
        try:
            archive = await updater.download(spec)
            await updater.install(spec, archive)
            updater.activate(spec.version)
            updater.prune()
        except (UpgradeError, OSError) as exc:
            self._draining = False
            logger.warning("upgrade failed: %s", exc)
            await self.send({"type": "UPGRADE_FAILED", "agent_id": self.agent_id,
                             "reason": str(exc)})
            return

        await self.send({"type": "UPGRADE_RESTARTING", "agent_id": self.agent_id,
                         "version": spec.version})
        self.stop()
        # The launcher (or service manager) brings the new version up; if it never
        # re-registers, `--rollback-if-stale` puts the old one back.
        updater.restart()

    async def _fetch_release(self, channel: str) -> UpgradeSpec | None:
        """Ask the backend what the current artifact is."""
        import urllib.request

        base = self.config.wss_url.replace("wss://", "https://").replace("ws://", "http://")
        base = base.split("/ws/agent")[0]
        url = f"{base}/agent-releases/latest?channel={channel}"

        def fetch() -> dict[str, Any]:
            with urllib.request.urlopen(url, timeout=20) as response:
                return json.loads(response.read().decode())

        try:
            data = await asyncio.to_thread(fetch)
        except Exception as exc:  # noqa: BLE001
            logger.warning("could not read the release manifest: %s", exc)
            return None
        return UpgradeSpec(version=data.get("version", ""), url=data.get("url", ""),
                           sha256=data.get("sha256", ""))

    # ------------------------------------------------------------------ io
    async def send(self, payload: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None:
            return
        async with self._send_lock:
            try:
                await ws.send(json.dumps(payload, default=str))
            except Exception:  # noqa: BLE001 - the reconnect loop handles it
                logger.debug("send failed for %s", payload.get("type"))


def _version_code(version: str) -> int:
    parts = (version.split(".") + ["0", "0"])[:3]
    try:
        major, minor, patch = (int(p) for p in parts)
    except ValueError:
        return 0
    return major * 10000 + minor * 100 + patch


def _local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.settimeout(0.2)
            probe.connect(("8.8.8.8", 80))
            return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def _in_container() -> bool:
    try:
        with open("/proc/1/cgroup", encoding="utf-8") as handle:
            content = handle.read()
        return "docker" in content or "kubepods" in content
    except OSError:
        import os

        return os.path.exists("/.dockerenv")


def _resource_stats() -> dict[str, float]:
    if psutil is None:
        return {}
    try:
        return {"cpu_percent": psutil.cpu_percent(interval=None),
                "memory_percent": psutil.virtual_memory().percent,
                "disk_percent": psutil.disk_usage("/").percent}
    except Exception:  # noqa: BLE001
        return {}
