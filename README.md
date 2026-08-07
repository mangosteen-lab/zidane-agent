# zidane-agent

The Zidane worker. Connects **outbound** to the backend over a WebSocket, registers this
host with its labels and capacity, runs the scripts it is sent, and streams logs back.
Because the connection is outbound only, hosts behind NAT or a firewall need no inbound
rules.

Protocol contract: `../zidane-backend/docs/design/02-agent-protocol.md`. Any change lands
here and in `zidane-backend/app/ws/agent_ws.py` in the same commit.

## Install on a machine

The repo is public, so these run unauthenticated anywhere:

```bash
# install (or upgrade in place) — downloads the latest release and verifies its sha256
curl -fsSL https://raw.githubusercontent.com/mangosteen-lab/zidane-agent/main/scripts/install.sh \
  | sudo bash -s -- --url wss://<backend>:17001/ws/agent --token <YOUR_TOKEN>

# upgrade to the latest release, or to a specific one
curl -fsSL https://raw.githubusercontent.com/mangosteen-lab/zidane-agent/main/scripts/upgrade.sh | sudo bash
sudo bash upgrade.sh --version 0.3.0
sudo bash upgrade.sh --rollback

# uninstall — keeps conf/ and logs/ unless you pass --purge
curl -fsSL https://raw.githubusercontent.com/mangosteen-lab/zidane-agent/main/scripts/uninstall.sh | sudo bash
```

Get the token from the console: **Settings → Agent registration tokens → Create**. It is
shown once. Windows has `install.ps1` (`irm ... | iex`).

Use `wss://` only when something terminates TLS in front of the backend; a backend started
with `make run` serves plain HTTP and needs `ws://`. The mismatch shows up as
`[SSL: WRONG_VERSION_NUMBER]`, which the agent now annotates with the fix.

### Container

```bash
docker run -d --name zidane-agent --restart unless-stopped \
  -e ZIDANE_BACKEND_WSS_URL=wss://zidane.example.com:17001/ws/agent \
  -e ZIDANE_BACKEND_API_KEY=zdn_... \
  -e ZIDANE_AGENT_LABELS="os=linux,template=UBUNTU_2404" \
  ghcr.io/mangosteen-lab/zidane-agent:latest
```

`ubuntu:24.04` with a general build toolchain — Python 3.12, Node 22, JDK 21, Maven,
Gradle 8.10, git, build-essential (~1.3GB). One image on purpose: the workflows this fleet
runs are mixed-language, and a step that lands on an agent missing its toolchain fails at
run time rather than at placement. Splitting per language means labelling the images
accurately and keeping selectors in step with reality — worth doing when the size hurts,
not before.

Configuration is entirely by environment; the image ships **no** config.ini, so a token
can never be baked into a layer. `ZIDANE_BACKEND_WSS_URL` and `ZIDANE_BACKEND_API_KEY` are
required, everything else has a default. The entrypoint renders the config on every start,
which means the environment always wins — a backend `SET_CONFIG` push (capacity, labels)
applies at run time but is overwritten at the next restart, so set only what you mean to
pin.

**It upgrades on restart.** The entrypoint pulls the latest published release, verifies its
sha256, installs it beside the baked one and flips `current` — the same versioned layout as
a machine install, under the same `/opt/mangosteen/zidane-agent`. So `docker restart` moves
the agent; `docker pull` moves the toolchain. Failure to reach GitHub is **not** fatal: an
air-gapped or rate-limited container starts on the version baked into the image rather than
crash-looping. `ZIDANE_UPGRADE_ON_START=0` pins it.

The container runs as `zidane` (uid 1001), not root — the agent refuses to run as root, and
that applies here too. Tasks run in per-task directories under
`/opt/mangosteen/zidane-workspace`, which is also the container's working directory.

Installs land in a versioned tree, which is what makes an upgrade reversible:

```
/opt/mangosteen/zidane-agent/versions/0.1.0/    previous, kept
/opt/mangosteen/zidane-agent/versions/0.2.0/    new
/opt/mangosteen/zidane-agent/current -> versions/0.2.0
/opt/mangosteen/zidane-agent/conf/config.ini    never touched by an upgrade
```

The symlink flip is atomic (`os.replace`), so a crash mid-upgrade cannot leave `current`
dangling. `--rollback` re-points it at the previous version without downloading anything.

An agent with `auto_upgrade = true` does the same thing on its own when the backend
advertises a newer release (`app/updater.py`); `upgrade.sh` is for when auto-upgrade is
off, or to move one machine ahead of the fleet.

## Releasing

```bash
make release VERSION=0.2.0     # bump, commit, tag, build, publish, print the backend config
```

`scripts/release.sh` bumps the version in **both** places it lives — `pyproject.toml` and
`AGENT_VERSION` in `app/client.py` — then tags, builds the tarball, and publishes it to
GitHub Releases with a `SHA256SUMS` asset. Pushing the tag also triggers
`.github/workflows/release.yml`, which does the same build and pushes the container image
to GHCR.

Two things it guards, both of which produce a release that looks fine and breaks on the
machine that installs it:

- **The two version sites must agree.** The agent reports `app/client.py`'s value, and the
  backend compares it against `ZIDANE_AGENT_RELEASE_VERSION` to decide whether to offer an
  upgrade. If they drift, the fleet upgrades in a loop, forever chasing a version it never
  claims to reach. `tests/test_version.py` checks this in `make check` too.
- **The tarball is built from `HEAD`.** An uncommitted bump would ship the old code under
  the new filename, so the script verifies the built archive really carries the version.

The tarball is deliberately **flat** — `app/`, `pyproject.toml` at the top level, no
directory prefix — because both `app/updater.py` and `install.sh` unpack it without
stripping components.

After publishing, set the three values it prints on the backend and restart it; that is
what turns on one-click self-upgrade for the fleet.

## Quick start (from a checkout)

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
