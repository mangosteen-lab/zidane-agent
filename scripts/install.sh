#!/usr/bin/env bash
# Zidane agent installer (Linux / macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/mangosteen-lab/zidane-agent/main/scripts/install.sh \
#     | sudo bash -s -- --url wss://host:17001/ws/agent --token zdn_...
#
# With no --artifact, it downloads the latest published release from GitHub and verifies
# it against the release's SHA256SUMS. Re-running it installs a newer version alongside
# the current one and flips the symlink, so this doubles as the upgrade path.
#
# Installs into a versioned tree so an upgrade can be rolled back:
#   /opt/zidane/zidane-agent/versions/<version>/
#   /opt/zidane/zidane-agent/current -> versions/<version>
#
# Runs as a dedicated unprivileged user. The agent refuses to run as root, which is
# deliberate: scripts arriving from a central service should not execute unrestricted.
set -euo pipefail

INSTALL_ROOT="${ZIDANE_INSTALL_ROOT:-/opt/zidane/zidane-agent}"
SERVICE_USER="${ZIDANE_USER:-zidane}"
WSS_URL="${ZIDANE_BACKEND_WSS_URL:-}"
API_KEY="${ZIDANE_BACKEND_API_KEY:-}"
AGENT_NAME="${ZIDANE_AGENT_NAME:-$(hostname)}"
CAPACITY="${ZIDANE_AGENT_CAPACITY:-4}"
LABELS="${ZIDANE_AGENT_LABELS:-os=linux}"
ARTIFACT="${ZIDANE_ARTIFACT_URL:-}"
VERSION="${ZIDANE_VERSION:-}"
REPO="${ZIDANE_AGENT_REPO:-mangosteen-lab/zidane-agent}"
NO_SERVICE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) WSS_URL="$2"; shift 2 ;;
    --token) API_KEY="$2"; shift 2 ;;
    --name) AGENT_NAME="$2"; shift 2 ;;
    --capacity) CAPACITY="$2"; shift 2 ;;
    --labels) LABELS="$2"; shift 2 ;;
    --artifact) ARTIFACT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --install-root) INSTALL_ROOT="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

[[ $EUID -eq 0 ]] || die "run this installer with sudo"

# Prompt only when we have a terminal; piping into bash must stay non-interactive.
if [[ -z "$WSS_URL" && -t 0 ]]; then read -rp "Backend WebSocket URL: " WSS_URL; fi
if [[ -z "$API_KEY" && -t 0 ]]; then read -rsp "Registration token: " API_KEY; echo; fi
[[ -n "$WSS_URL" ]] || die "--url is required (e.g. wss://zidane.example.com:17001/ws/agent)"
[[ -n "$API_KEY" ]] || die "--token is required; create one under User tokens"

command -v python3 >/dev/null || die "python3 is required"
PY_MINOR=$(python3 -c 'import sys; print(sys.version_info[1])')
[[ "$PY_MINOR" -ge 11 ]] || die "python 3.11+ is required (found 3.$PY_MINOR)"

# Resolve what to install: an explicit artifact, the latest GitHub release, or — when
# this script is run from inside a checkout — that checkout.
LOCAL_SOURCE=""
if [[ -z "$ARTIFACT" ]]; then
  # :- matters: piped through `curl | bash` there is no BASH_SOURCE, and `set -u` turns
  # the lookup into an error message in the middle of an otherwise clean install.
  SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || true)"
  if [[ -n "$SOURCE_DIR" && -f "$SOURCE_DIR/pyproject.toml" && -d "$SOURCE_DIR/app" ]]; then
    LOCAL_SOURCE="$SOURCE_DIR"
  else
    info "finding the latest release of $REPO"
    RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest") \
      || die "could not reach the GitHub API; pass --artifact to install from a mirror"
    ARTIFACT=$(printf '%s' "$RELEASE_JSON" \
      | grep -o '"browser_download_url": *"[^"]*\.tar\.gz"' | head -1 \
      | sed 's/.*"\(https[^"]*\)"/\1/')
    [[ -n "$ARTIFACT" ]] || die "no .tar.gz asset in the latest release of $REPO"
    [[ -n "$VERSION" ]] || VERSION=$(printf '%s' "$RELEASE_JSON" \
      | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"v\{0,1\}\([^"]*\)"/\1/')
  fi
fi

# Fall back to the version in the artifact name, then to a timestamp, so the versioned
# install tree never collides with a previous install.
if [[ -z "$VERSION" ]]; then
  VERSION=$(basename "${ARTIFACT:-}" .tar.gz | sed -n 's/^zidane-agent-//p')
  [[ -n "$VERSION" ]] || VERSION="0.0.0+$(date +%Y%m%d%H%M%S)"
fi

info "installing to $INSTALL_ROOT (version $VERSION)"
VERSION_DIR="$INSTALL_ROOT/versions/$VERSION"
mkdir -p "$VERSION_DIR" "$INSTALL_ROOT/state" "$INSTALL_ROOT/work" \
         "$INSTALL_ROOT/logs" "$INSTALL_ROOT/conf"

if [[ -n "$LOCAL_SOURCE" ]]; then
  info "installing from $LOCAL_SOURCE"
  cp -r "$LOCAL_SOURCE/app" "$LOCAL_SOURCE/pyproject.toml" "$VERSION_DIR/"
else
  info "downloading $ARTIFACT"
  TMPDIR_DL=$(mktemp -d); trap 'rm -rf "$TMPDIR_DL"' EXIT
  NAME=$(basename "$ARTIFACT")
  curl -fsSL "$ARTIFACT" -o "$TMPDIR_DL/$NAME"
  # Verify against the release's SHA256SUMS. A tampered artifact is the one failure this
  # installer can actually detect, so a mismatch aborts rather than warns.
  if curl -fsSL "$(dirname "$ARTIFACT")/SHA256SUMS" -o "$TMPDIR_DL/SHA256SUMS" 2>/dev/null; then
    if ( cd "$TMPDIR_DL" && grep " $NAME\$" SHA256SUMS | sha256sum -c - >/dev/null 2>&1 ); then
      info "checksum OK"
    else
      die "checksum mismatch for $NAME — refusing to install"
    fi
  else
    echo "warning: no SHA256SUMS published for this release; skipping verification" >&2
  fi
  # Flat archive: app/ and pyproject.toml sit at the top level, matching what
  # app/updater.py expects when it unpacks an upgrade.
  tar -xzf "$TMPDIR_DL/$NAME" -C "$VERSION_DIR"
fi

info "creating the virtualenv"
python3 -m venv "$VERSION_DIR/.venv"
"$VERSION_DIR/.venv/bin/pip" install --quiet --upgrade pip
"$VERSION_DIR/.venv/bin/pip" install --quiet "$VERSION_DIR"

# Atomic flip so a crash mid-install never leaves `current` missing.
ln -sfn "$VERSION_DIR" "$INSTALL_ROOT/current.new"
mv -Tf "$INSTALL_ROOT/current.new" "$INSTALL_ROOT/current"

CONFIG="$INSTALL_ROOT/conf/config.ini"
if [[ -f "$CONFIG" ]]; then
  info "keeping the existing $CONFIG"
else
  info "writing $CONFIG"
  cat > "$CONFIG" <<EOF
[agent]
name = $AGENT_NAME
capacity = $CAPACITY
labels = $LABELS
auto_upgrade = true
upgrade_channel = stable
state_dir = $INSTALL_ROOT/state
workdir_root = $INSTALL_ROOT/work
install_root = $INSTALL_ROOT

[backend]
wss_url = $WSS_URL
api_key = $API_KEY

[logging]
file = $INSTALL_ROOT/logs/agent.log
level = INFO
EOF
  chmod 600 "$CONFIG"
fi

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  info "creating system user $SERVICE_USER"
  useradd --system --home-dir "$INSTALL_ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
chown -R "$SERVICE_USER" "$INSTALL_ROOT"

if [[ "$NO_SERVICE" -eq 1 ]]; then
  info "done (no service installed)"
  echo "run: sudo -u $SERVICE_USER $INSTALL_ROOT/current/.venv/bin/python -m app.main --config $CONFIG"
  exit 0
fi

if command -v systemctl >/dev/null; then
  info "installing the systemd unit"
  cat > /etc/systemd/system/zidane-agent.service <<EOF
[Unit]
Description=Zidane agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_ROOT/current
Environment=ZIDANE_MANAGED_BY_SERVICE=1
ExecStart=$INSTALL_ROOT/current/.venv/bin/python -m app.main --config $CONFIG
Restart=always
RestartSec=5
# The agent runs other people's scripts; keep the blast radius small.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$INSTALL_ROOT

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now zidane-agent.service
  info "installed and started; follow with: journalctl -u zidane-agent -f"
else
  info "systemd not found; start the agent yourself:"
  echo "  sudo -u $SERVICE_USER $INSTALL_ROOT/current/.venv/bin/python -m app.main --config $CONFIG"
fi
