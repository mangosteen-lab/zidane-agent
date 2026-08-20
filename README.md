# Zidane Agent

`zidane-agent` is an autonomous Node.js service embedding the
[Pi coding-agent SDK](https://pi.dev/docs/latest/sdk). Zidane Server sends prompts and
desired state; the agent selects the configured model, runs each conversation in an
isolated workspace, invokes tools and skills, and streams events and final responses
back. Capacity controls how many Pi sessions may run concurrently.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZIDANE_AGENT_SERVER_URL` | required | `wss://.../ws/agent` endpoint |
| `ZIDANE_AGENT_API_KEY` | required | Registration key shown once by the server |
| `ZIDANE_AGENT_NAME` | `zidane-agent` | Initial unique name within the user account |
| `ZIDANE_AGENT_VERSION` | `1.0.0` | Reported version |
| `ZIDANE_AGENT_DESCRIPTION` | `Autonomous Pi coding agent` | Operator-facing description |
| `ZIDANE_AGENT_CAPACITY` | `1` | Maximum concurrent Pi sessions |
| `ZIDANE_AGENT_WORKING_DIRECTORY` | `/var/lib/zidane-agent` | Durable local state root |
| `ZIDANE_AGENT_ALLOW_INSECURE_WS` | unset | Permit remote plain WebSocket only on a trusted network |

The bootstrap key is exchanged for a rotating, one-use session credential. The rotated
credential is stored mode `0600`; the bootstrap key is never written to agent metadata.
Revoking its server-side registration key invalidates derived sessions.

## Working directory

```text
agent.json       server-managed name, version, description, and capacity
SOUL.md          personality and operating constraints
skills/          Pi SKILL.md files and supporting resources
memory/          bounded, searchable, TTL-aware durable memories
knowledge/       connector definitions, local chunks, and citation index
config/          agent-owned config maps, effective config, LLM profiles, and custom models
secrets/         rotating/Pi credentials plus agent-owned write-only secrets (mode 0600)
                 synced/<name>/<key> holds one file per key of a synced secret
sessions/        redacted Pi event transcripts
workspaces/      one isolated working directory per conversation
exports/         portable tar.gz archives
logs/            rotated, redacted JSON logs
```

Memory rejects recognizable credentials, supports normal/private/restricted sensitivity,
and is capped at 10,000 active records. Built-in Pi tools let the agent remember,
retrieve, forget, and search its cited knowledge index. Supported knowledge connectors
are GitHub, Notion, Confluence, and generic HTTP(S). Model profiles support Pi providers
such as OpenAI, Anthropic, and DeepSeek, plus compatible custom endpoints.

The Models page follows Pi's login sequence: choose a provider, choose one of the
authentication methods that provider advertises, complete any device-code/OAuth prompts,
and only then choose a model. Pi persists provider credentials locally in
`secrets/pi-auth.json`; OAuth tokens are never returned to Zidane Server or Web. API-key
login consumes an encrypted Zidane Secret and stores the resulting Pi credential locally.

Valid shell-style config-map keys are applied to the agent process environment; keys with
dots or dashes remain available in `config/applied.json`. General synchronized secrets
are isolated under `secrets/synced/`, whose path is exposed as
`ZIDANE_AGENT_SYNCED_SECRETS_DIR`, so they cannot overwrite registration or model
credentials. Each secret is a directory named after the secret containing one mode-0600
file per key, so a credential with several parts stays together; a secret written by an
earlier version as a single flat file is migrated to a `value` key on first read.

The agent advertises its versioned local-storage capability at registration. Zidane Web
can list and CRUD every local `SKILL.md`, named config map, and write-only secret through
synchronous WebSocket requests. Importing account config maps or encrypted account
secrets creates agent-local copies; subsequent account changes reach those copies only
when the account is synced again, which also deletes the copies whose account resource is
no longer shared with this agent. Account skills import the same way and record their
origin in the skill's `.zidane.json`, so a sync can refresh or remove exactly those
copies; a `SKILL.md` placed in `skills/` by hand is never touched. Secret values are
never returned by the agent.

## Run and test

Node.js 22 or newer is required.

```bash
npm ci
export ZIDANE_AGENT_SERVER_URL=wss://zidane.example.com/ws/agent
export ZIDANE_AGENT_API_KEY=zidane_registration_key
export ZIDANE_AGENT_NAME=research-01
export ZIDANE_AGENT_CAPACITY=4
npm start
```

```bash
npm run check
npm test
npm audit --audit-level=high
```

## Installation

The container uses Ubuntu 24.04, installs Node.js 22 and common coding tools, runs as the
unprivileged `zidane` user, and persists `/var/lib/zidane-agent`:

```bash
docker build -t zidane-agent .
docker run --restart unless-stopped \
  -e ZIDANE_AGENT_SERVER_URL=wss://zidane.example.com/ws/agent \
  -e ZIDANE_AGENT_API_KEY=zidane_registration_key \
  -v zidane-agent-data:/var/lib/zidane-agent \
  zidane-agent
```

Host installers expect the source/release bundle, Node.js 22+, a registration key, and a
server URL:

- Linux/systemd: run `scripts/install-linux.sh` as root with the environment variables
  set. Code goes to `/opt/zidane-agent`; state goes to `/var/lib/zidane-agent`.
- macOS/launchd: run `scripts/install-macos.sh` as the target user. It installs a user
  LaunchAgent under `~/Library`.
- Windows/WinSW: run `scripts/install-windows.ps1 -ServerUrl ... -ApiKey ...
  -WinSWPath ...` in an elevated PowerShell. State is ACL-protected under ProgramData.

## Portable transfer

Exports contain `agent.json`, `SOUL.md`, skills, memory, knowledge, and non-secret config.
Secrets, rotating credentials, sessions, workspaces, logs, and existing exports are never
included. Imports validate paths and SHA-256 checksums before supporting `validate`,
`merge`, or `replace` mode. See [the archive format](../docs/export-format.md).
