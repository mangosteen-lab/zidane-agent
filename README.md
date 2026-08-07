# zidane-agent

The Zidane worker. Connects **outbound** to the backend over a WebSocket, registers this
host with its labels and capacity, runs the scripts it is sent, and streams logs back.
Because the connection is outbound only, hosts behind NAT or a firewall need no inbound
rules.

Protocol contract: `../zidane-backend/docs/design/02-agent-protocol.md`. Any change lands
here and in `zidane-backend/app/ws/agent_ws.py` in the same commit.

## Quick start

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e ".[dev]"
cp conf/config.example.ini conf/config.ini    # then set backend.wss_url + api_key
./.venv/bin/python -m app.main --config conf/config.ini
```

Get an `api_key` from the backend: **Settings → User tokens → Create**, or
`POST /api/v1/user-tokens`. It is shown once.

## Configuration

See `conf/config.example.ini`. The essentials:

| Key | Meaning |
|---|---|
| `agent.name` | Display name in the UI (defaults to the hostname) |
| `agent.capacity` | Max concurrent tasks. Zidane schedules by **slots**, so 4 means four independent steps run here at once |
| `agent.labels` | `key=value` pairs. A step lands here only if its selector is satisfied |
| `backend.wss_url` | e.g. `wss://zidane.example.com:17001/ws/agent` (the backend's default port) |
| `backend.api_key` | Registration token; swapped for a rotating session token after first connect |
| `logging.file` | Agent log, relative to the config file (default `logs/agent.log`) |
| `logging.level` | Default `INFO` |
| `logging.max_mb` | Rotate past this size (default 50) |
| `logging.file_count` | Files kept, live one included (default 5) → a 250MB ceiling |

The agent logs to stdout **and** to that rotating file. Task output is separate: it
streams to the backend and is not mixed into the agent log.

`[backend]` is **not** remotely writable. A `SET_CONFIG` push from the backend can change
capacity, labels and logging, but cannot repoint the agent at a different server.

## Behaviour worth knowing

**It refuses to run as root.** Scripts arriving from a central service should not execute
with unrestricted privileges by accident. Create a dedicated user, or pass `--allow-root`
if that is genuinely what you want.

**Secrets are redacted before anything leaves the host.** The backend sends sensitive
config-map values in a separate `secret_env` field; the agent merges them into the child
process environment and registers every value in a redaction table applied to both stdout
and stderr. This is the layer that catches `set -x`, `env`, and a stack trace that happens
to include a token — by then the value is already in the process's output, and the host is
the only place left to scrub it. The redactor holds back a tail between reads so a secret
split across a chunk boundary is still caught.

**Results survive a restart.** Every command is journalled under `state/journal/`. A
finished result is only dropped once the backend ACKs it, so a result produced while the
connection was down is replayed via `RESUME` on reconnect. A command that was *running*
when the process died is reported `LOST` rather than left for the backend to time out.

**Markers are parsed here, not server-side.** `@zidane:set`, `@zidane:notify`,
`@zidane:progress` and `@zidane:artifact` are harvested from stdout as it streams and sent
structured in `COMMAND_DONE`. The marker line is still written to the log verbatim, so the
run stays auditable.

**Kills reach the whole process tree.** Tasks run in a new session; a KILL or timeout
sends SIGTERM to the process group, then SIGKILL after the grace period, so a script that
backgrounds work does not leave orphans.

## Layout

```
app/
  main.py        CLI entry point, logging, signal handling, root check
  config.py      config.ini loading + validated remote updates
  client.py      the WebSocket client: register, resume, heartbeat, dispatch
  runner.py      script execution, streaming, markers, timeout, kill
  journal.py     durable command journal
  redaction.py   boundary-safe secret scrubbing
```

## Ports

The agent **listens on nothing** — it dials out to the backend on **17001**, which is why a
host behind NAT or a firewall needs no inbound rules. **17002** is reserved for the loopback
REST API a local script will call to read or update its `machine_version`; that API is not
implemented yet, and the port is recorded in `conf/config.example.ini` so nothing else in the
project claims it.

## Not yet implemented

- **Self-upgrade.** The download / verify / versioned-install / symlink-flip / rollback
  sequence is specified in the backend's `docs/design/07-scaling-ops.md` §8. Until it
  lands the agent replies `UPGRADE_SKIPPED` to an upgrade push rather than silently doing
  nothing.
- **Installers** (`install.sh`, `install.ps1`, container image) and OS service units.
- **Container isolation** for tasks (per-org opt-in cgroup/container limits).
