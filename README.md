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
follow-ups/      conversations that asked to be woken later
home/            $HOME for every session: tool installs and tool configuration
workspaces/      one isolated working directory per conversation
exports/         portable tar.gz archives
logs/            rotated, redacted JSON logs
```

### What the image provides

A session runs unprivileged, so `apt` is out of reach: the tools it can rely on are the
ones in the image.

```text
git  git-lfs  gh  glab        version control, GitHub, GitLab
curl  jq  ripgrep (rg)        fetching and reading
fd-find (fdfind)  unzip  xz   finding and unpacking
python3  python3-venv         a venv inside the workspace; there is no pip on the system
node  npm                     Node 22
openssh-client  ca-certificates  bash  tini
```

`gh` and `glab` read `GH_TOKEN`/`GITHUB_TOKEN` and `GITLAB_TOKEN` from the environment,
which is where a config map's secret values already are — so no `auth login` is needed to
use them. Git ships with a system identity (`Zidane Agent <zidane-agent@localhost>`) so
`git commit` works out of the box, and with the LFS filters registered so an LFS
repository checks out its content rather than pointer files. Give an agent its own
identity from a session with `git config --global`: the shared home persists, and global
beats system.

Anything else a session installs belongs in `~/.local` — see below.

### What a session keeps, and what it throws away

A session runs with two lifetimes, and a skill should use both deliberately:

| | Environment variable | Lives until |
| --- | --- | --- |
| Clones, builds, scratch | `AI_AGENT_SESSION_WORKSPACE_DIR`, and `$TMPDIR` inside it | the conversation ends |
| Tool installs and configuration | `$HOME` (and the `XDG_*` directories) | removed by hand |

Sessions run unprivileged, so `apt` is out of reach and anything a session needs beyond
the image has to be installed without root — but the workspace is deleted with the
conversation, so installing there means reinstalling on every prompt. `$HOME` is therefore
the agent's own durable `home/`, shared by every session: `gh auth login` writes
`~/.config/gh` once, a `~/.gitconfig` survives, and `~/.local/bin` leads `PATH` so an
unprivileged install (`npm i -g --prefix ~/.local`, a binary dropped in by hand) is on the
path by name in the next conversation. The flip side is that it is shared: one session can
shadow a system tool for every session after it.

`home/` sits beside the agent's state rather than around it, so `auth/`, `config-maps/`,
and `memory/` are siblings of `$HOME` and nothing a tool writes under `~` can reach them.
It is not part of a portable export either, so tool state — and any token `gh auth login`
left behind — stays on the machine it was created on.

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

## Checking back on something slow

A session that starts something long — a build, a deployment, an import, a test run —
can ask to be woken:

```text
check_back(minutes: 30, note: "Release build 11.6.1000.0007 at https://ci.example.test/42.
                               Done when the page shows SUCCESS or FAILURE; report which.")
stop_checking()
```

When it comes due the agent prompts **that same conversation** again, so the wake lands in
the same thread and the same Pi session: the model reads its own note, looks, and either
reports the outcome or calls `check_back` again to look later. What the person sees is the
agent coming back to them in the conversation they were already in. It works just as well
when they ask for it — "watch that job and tell me how it goes" — because that is simply
the model deciding to call the tool.

One pending wake per conversation, re-armed by hand rather than repeating on its own: a
schedule has no natural end and this always has one. Re-arming is also what lets the model
back off from five minutes to fifteen when nothing is happening.

The whole watch is bounded from when it *started* — 24 hours, or 120 wakes — so re-arming
extends nothing, and the last wake says it is the last, so a watch that runs out of time
ends with the agent saying where things stand rather than going quiet. A wake that arrives
while that conversation is busy is put back and tried again on the next tick; it does not
count as an attempt.

The note is the whole instruction to the model's future self. Put the link and the success
condition in it: the conversation may have been compacted by then, and the note may be all
that is left of it.

`ZIDANE_AGENT_FOLLOW_UPS=false` turns the timer off; `ZIDANE_AGENT_FOLLOW_UP_INTERVAL_SECONDS`
(default 30) is how often it looks for something due. Pending wakes live in
`follow-ups/pending.json` and survive a restart — an agent that was down comes back to one
overdue wake per conversation, not one for every interval it missed.

## `$skill` commands

A prompt may open with `$name args…`, which means "do this with that skill":

```text
$pr-fill https://github.com/owner/repo/pull/13764
```

`commands.mjs` resolves the name against the skills this agent has installed and rewrites
the prompt before Pi sees it — naming the skill, pointing at its `SKILL.md`, and passing
the rest as input. Every other installed skill stays loadable, so a skill that depends on
another one still works.

Resolution belongs here because skills do: the control plane relays the text untouched
and has no idea what is installed. A command is only the *first* token of a message, and
a `$word` naming no installed skill is left exactly as typed — `$HOME` and `$5` are
ordinary text, not typos to be guessed at.

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
