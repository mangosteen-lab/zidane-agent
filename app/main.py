from __future__ import annotations

import argparse
import asyncio
import logging
import logging.handlers
import os
import signal
import sys
from pathlib import Path

from app.client import AGENT_VERSION, AgentClient
from app.config import load_config

logger = logging.getLogger("zidane.main")

DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "conf" / "config.ini"


def configure_logging(log_file: str, level: str, base: Path, *, max_mb: int = 50,
                      file_count: int = 5) -> None:
    """`file_count` counts the live file too, so the log costs at most
    `max_mb * file_count` on disk."""
    path = Path(log_file)
    if not path.is_absolute():
        path = base / path
    path.parent.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [
        logging.handlers.RotatingFileHandler(path, maxBytes=max(1, max_mb) * 1024 * 1024,
                                             backupCount=max(0, file_count - 1),
                                             encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ]
    formatter = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    for handler in handlers:
        handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers[:] = handlers
    root.setLevel(level.upper())


def check_privileges(allow_root: bool) -> None:
    """Refuse to run as root unless explicitly allowed.

    A deliberate speed bump: scripts arriving from a central service should not execute
    with unrestricted privileges by accident.
    """
    if os.name == "posix" and os.geteuid() == 0 and not allow_root:
        raise SystemExit(
            "zidane-agent refuses to run as root. Create a dedicated user, or pass "
            "--allow-root if that is genuinely what you want.")


async def _run(config_path: Path) -> None:
    config = load_config(config_path)
    configure_logging(config.log_file, config.log_level, config_path.parent,
                      max_mb=config.log_max_mb, file_count=config.log_file_count)
    logger.info("zidane-agent %s starting (name=%s capacity=%d labels=%s)",
                AGENT_VERSION, config.name, config.capacity, config.labels)

    client = AgentClient(config)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, client.stop)
        except NotImplementedError:  # pragma: no cover - Windows
            pass
    await client.run()
    logger.info("zidane-agent stopped")


def main() -> None:
    parser = argparse.ArgumentParser(prog="zidane-agent")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG),
                        help="path to config.ini")
    parser.add_argument("--allow-root", action="store_true",
                        help="permit running as root (not recommended)")
    parser.add_argument("--version", action="version", version=AGENT_VERSION)
    args = parser.parse_args()

    check_privileges(args.allow_root)
    try:
        asyncio.run(_run(Path(args.config)))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
