"""`config.ini` loading and writing.

The agent owns its config file. A `SET_CONFIG` / `SET_CAPACITY` / `SET_LABELS` push from
the backend is a *request*: the agent validates it, rewrites the file, replies
CONFIG_UPDATED or CONFIG_REJECTED, and restarts to re-register. Nothing under `[backend]`
is remotely writable — otherwise a backend compromise could repoint the fleet.
"""
from __future__ import annotations

import configparser
import json
import logging
import os
import socket
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger("zidane.config")

PROTECTED_SECTIONS = {"backend"}


@dataclass
class AgentConfig:
    path: Path
    name: str = ""
    capacity: int = 1
    labels: dict[str, str] = field(default_factory=dict)
    auto_upgrade: bool = True
    upgrade_channel: str = "stable"
    state_dir: Path = Path("state")
    workdir_root: Path = Path("work")

    wss_url: str = ""
    api_key: str = ""

    log_file: str = "logs/agent.log"
    log_level: str = "INFO"
    log_max_mb: int = 50
    # Total files kept, the live one included: 5 x 50MB caps the log at 250MB.
    log_file_count: int = 5

    # Root of the versioned install tree (see app/updater.py). Defaults to the parent
    # of the package so a checkout still works without an installer.
    install_root: Path = Path(".")

    reconnect_min: float = 1.0
    reconnect_max: float = 60.0

    @property
    def machine_version_file(self) -> Path:
        return self.state_dir / "machine_version.json"

    @property
    def session_token_file(self) -> Path:
        return self.state_dir / "session.json"

    @property
    def journal_dir(self) -> Path:
        return self.state_dir / "journal"

    def read_machine_version(self) -> int:
        try:
            data = json.loads(self.machine_version_file.read_text(encoding="utf-8"))
            return int(data.get("machine_version", 0))
        except (OSError, ValueError):
            return 0  # absent on a fresh machine; 0 means "unset"

    def write_machine_version(self, value: int) -> None:
        self.machine_version_file.parent.mkdir(parents=True, exist_ok=True)
        self.machine_version_file.write_text(
            json.dumps({"machine_version": int(value)}), encoding="utf-8")

    def read_session_token(self) -> str:
        try:
            return json.loads(
                self.session_token_file.read_text(encoding="utf-8")).get("token", "")
        except (OSError, ValueError):
            return ""

    def write_session_token(self, token: str) -> None:
        self.session_token_file.parent.mkdir(parents=True, exist_ok=True)
        self.session_token_file.write_text(json.dumps({"token": token}), encoding="utf-8")
        try:
            os.chmod(self.session_token_file, 0o600)
        except OSError:
            pass


def parse_labels(raw: str) -> dict[str, str]:
    """`template=LINUX_ABA, os=linux` -> dict. Malformed pairs are dropped with a warning
    rather than failing startup — a typo should not take an agent offline."""
    labels: dict[str, str] = {}
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            logger.warning("ignoring malformed label %r (expected key=value)", part)
            continue
        key, value = part.split("=", 1)
        if key.strip():
            labels[key.strip()] = value.strip()
    return labels


def format_labels(labels: dict[str, str]) -> str:
    return ", ".join(f"{k}={v}" for k, v in sorted(labels.items()))


def load_config(path: str | Path) -> AgentConfig:
    path = Path(path)
    parser = configparser.ConfigParser()
    if path.exists():
        parser.read(path, encoding="utf-8")

    base = path.parent if path.parent.as_posix() else Path(".")

    def get(section: str, option: str, default: str = "") -> str:
        # Environment always wins, so a container can be configured with no file at all.
        env_name = f"ZIDANE_{section.upper()}_{option.upper()}"
        return os.environ.get(env_name) or parser.get(section, option, fallback=default)

    def resolve(value: str, default: str) -> Path:
        candidate = Path(value or default)
        return candidate if candidate.is_absolute() else base / candidate

    def get_int(section: str, option: str, default: int) -> int:
        # A typo in a logging size must not stop the agent from starting.
        try:
            return int(get(section, option, str(default)) or default)
        except ValueError:
            return default

    config = AgentConfig(
        path=path,
        name=get("agent", "name") or socket.gethostname(),
        capacity=max(1, int(get("agent", "capacity", "1") or 1)),
        labels=parse_labels(get("agent", "labels")),
        auto_upgrade=(get("agent", "auto_upgrade", "true").lower() in {"1", "true", "yes"}),
        upgrade_channel=get("agent", "upgrade_channel", "stable"),
        state_dir=resolve(get("agent", "state_dir"), "state"),
        workdir_root=resolve(get("agent", "workdir_root"), "work"),
        install_root=resolve(get("agent", "install_root"), "."),
        wss_url=get("backend", "wss_url"),
        api_key=get("backend", "api_key"),
        log_file=get("logging", "file", "logs/agent.log"),
        log_level=get("logging", "level", "INFO"),
        log_max_mb=get_int("logging", "max_mb", 50),
        log_file_count=get_int("logging", "file_count", 5),
    )
    config.state_dir.mkdir(parents=True, exist_ok=True)
    config.workdir_root.mkdir(parents=True, exist_ok=True)
    return config


def apply_remote_config(config: AgentConfig, updates: dict[str, str]) -> list[str]:
    """Apply a backend `SET_CONFIG` push. Returns the keys applied.

    Raises ValueError on anything under a protected section or an invalid value — the
    caller turns that into CONFIG_REJECTED rather than writing a broken file.
    """
    applied: list[str] = []
    parser = configparser.ConfigParser()
    if config.path.exists():
        parser.read(config.path, encoding="utf-8")

    for dotted, value in updates.items():
        section, _, option = dotted.partition(".")
        if not option:
            section, option = "agent", dotted
        if section in PROTECTED_SECTIONS:
            raise ValueError(f"section [{section}] is not remotely writable")
        if section == "agent" and option == "capacity" and int(value) < 1:
            raise ValueError("capacity must be at least 1")
        if not parser.has_section(section):
            parser.add_section(section)
        parser.set(section, option, str(value))
        applied.append(dotted)

    config.path.parent.mkdir(parents=True, exist_ok=True)
    with config.path.open("w", encoding="utf-8") as handle:
        parser.write(handle)
    return applied
