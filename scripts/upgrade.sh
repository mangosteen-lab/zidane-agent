#!/usr/bin/env bash
# Zidane agent upgrade (Linux / macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/mangosteen-lab/zidane-agent/main/scripts/upgrade.sh | sudo bash
#   sudo bash upgrade.sh --version 0.3.0     # a specific release
#   sudo bash upgrade.sh --rollback          # go back to the previous version
#
# Installs the new version *beside* the current one and flips the `current` symlink, so a
# rollback is a symlink away and never a re-download:
#
#   /opt/mangosteen/zidane-agent/versions/0.2.0/   <- previous, kept
#   /opt/mangosteen/zidane-agent/versions/0.3.0/   <- new
#   /opt/mangosteen/zidane-agent/current -> versions/0.3.0
#
# This is the manual path. An agent with auto_upgrade=true does the same thing on its own
# when the backend advertises a newer release — see app/updater.py. Use this when
# auto-upgrade is off, or to move one machine ahead of the fleet.
#
# The existing conf/config.ini is never touched.
set -euo pipefail

INSTALL_ROOT="${ZIDANE_INSTALL_ROOT:-/opt/mangosteen/zidane-agent}"
SERVICE_USER="${ZIDANE_USER:-zidane}"
REPO="${ZIDANE_AGENT_REPO:-mangosteen-lab/zidane-agent}"
VERSION="${ZIDANE_VERSION:-}"
ARTIFACT="${ZIDANE_ARTIFACT_URL:-}"
ROLLBACK=0
# The container entrypoint execs the agent itself the moment this returns, so telling it
# to "restart the agent yourself" is noise at best and misleading at worst.
NO_RESTART="${ZIDANE_UPGRADE_NO_RESTART:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --artifact) ARTIFACT="$2"; shift 2 ;;
    --install-root) INSTALL_ROOT="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --rollback) ROLLBACK=1; shift ;;
    --no-restart) NO_RESTART=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

[[ -d "$INSTALL_ROOT" ]] || die "no installation at $INSTALL_ROOT — run install.sh first"
# Writability, not uid 0: on a host /opt needs root, but in the container the agent user
# owns its own tree and upgrades itself at start-up without a root shell in the image.
[[ -w "$INSTALL_ROOT" ]] || die "cannot write $INSTALL_ROOT — run this with sudo"

CURRENT_VERSION=""
[[ -L "$INSTALL_ROOT/current" ]] && CURRENT_VERSION=$(basename "$(readlink "$INSTALL_ROOT/current")")

restart_service() {
  if [[ "$NO_RESTART" == "1" ]]; then
    return 0
  fi
  if command -v systemctl >/dev/null && \
     systemctl list-unit-files 2>/dev/null | grep -q '^zidane-agent\.service'; then
    info "restarting zidane-agent"
    systemctl restart zidane-agent.service
    sleep 2
    systemctl is-active --quiet zidane-agent.service \
      && info "running" \
      || die "the service did not come back up — check: journalctl -u zidane-agent -n 50"
  else
    info "no systemd unit; restart the agent yourself"
  fi
}

# --- rollback --------------------------------------------------------------
if [[ "$ROLLBACK" == "1" ]]; then
  mapfile -t AVAILABLE < <(ls -1 "$INSTALL_ROOT/versions" 2>/dev/null | grep -v "^${CURRENT_VERSION}$" | sort -V)
  [[ ${#AVAILABLE[@]} -gt 0 ]] || die "no other version installed under $INSTALL_ROOT/versions"
  TARGET="${AVAILABLE[-1]}"
  info "rolling back from ${CURRENT_VERSION:-unknown} to $TARGET"
  ln -sfn "$INSTALL_ROOT/versions/$TARGET" "$INSTALL_ROOT/current.new"
  mv -Tf "$INSTALL_ROOT/current.new" "$INSTALL_ROOT/current"
  restart_service
  exit 0
fi

# --- resolve the release ---------------------------------------------------
if [[ -z "$ARTIFACT" ]]; then
  if [[ -n "$VERSION" ]]; then
    API="https://api.github.com/repos/$REPO/releases/tags/v$VERSION"
  else
    API="https://api.github.com/repos/$REPO/releases/latest"
  fi
  info "resolving ${VERSION:-latest} from $REPO"
  RELEASE_JSON=$(curl -fsSL "$API") || die "no such release (or the GitHub API is unreachable)"
  ARTIFACT=$(printf '%s' "$RELEASE_JSON" \
    | grep -o '"browser_download_url": *"[^"]*\.tar\.gz"' | head -1 \
    | sed 's/.*"\(https[^"]*\)"/\1/')
  [[ -n "$ARTIFACT" ]] || die "no .tar.gz asset on that release"
  [[ -n "$VERSION" ]] || VERSION=$(printf '%s' "$RELEASE_JSON" \
    | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"v\{0,1\}\([^"]*\)"/\1/')
fi
[[ -n "$VERSION" ]] || VERSION=$(basename "$ARTIFACT" .tar.gz | sed -n 's/^zidane-agent-//p')
[[ -n "$VERSION" ]] || die "could not determine the version; pass --version"

if [[ "$VERSION" == "$CURRENT_VERSION" ]]; then
  info "already on $VERSION — nothing to do"
  exit 0
fi

# --- download + verify -----------------------------------------------------
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
NAME=$(basename "$ARTIFACT")
info "downloading $ARTIFACT"
curl -fsSL "$ARTIFACT" -o "$TMP/$NAME"
if curl -fsSL "$(dirname "$ARTIFACT")/SHA256SUMS" -o "$TMP/SHA256SUMS" 2>/dev/null; then
  ( cd "$TMP" && grep " $NAME\$" SHA256SUMS | sha256sum -c - >/dev/null 2>&1 ) \
    && info "checksum OK" \
    || die "checksum mismatch for $NAME — refusing to upgrade"
else
  echo "warning: no SHA256SUMS published for this release; skipping verification" >&2
fi

# --- install beside the current version ------------------------------------
VERSION_DIR="$INSTALL_ROOT/versions/$VERSION"
info "installing $VERSION to $VERSION_DIR"
rm -rf "$VERSION_DIR"
mkdir -p "$VERSION_DIR"
tar -xzf "$TMP/$NAME" -C "$VERSION_DIR"

info "creating the virtualenv"
python3 -m venv "$VERSION_DIR/.venv"
"$VERSION_DIR/.venv/bin/pip" install --quiet --upgrade pip
"$VERSION_DIR/.venv/bin/pip" install --quiet "$VERSION_DIR"

# Non-fatal: in the container the agent user already owns the tree and cannot
# chown, and there is nothing to fix up.
if [[ $EUID -eq 0 ]] && id -u "$SERVICE_USER" >/dev/null 2>&1; then
  chown -R "$SERVICE_USER" "$VERSION_DIR" || true
fi

# Atomic flip, so a crash mid-upgrade never leaves `current` dangling.
ln -sfn "$VERSION_DIR" "$INSTALL_ROOT/current.new"
mv -Tf "$INSTALL_ROOT/current.new" "$INSTALL_ROOT/current"
info "current -> $VERSION (was ${CURRENT_VERSION:-none})"

restart_service
[[ "$NO_RESTART" == "1" ]] || echo "Roll back with: sudo bash upgrade.sh --rollback"
