#!/usr/bin/env bash
# Zidane agent uninstaller (Linux / macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/mangosteen-lab/zidane-agent/main/scripts/uninstall.sh | sudo bash
#   sudo bash uninstall.sh --purge          # also delete the install tree
#
# Stops and removes the service. The install tree is *kept* by default: it holds
# conf/config.ini (with the registration token) and the logs, and a machine being
# reinstalled shortly wants both. --purge removes it, --keep-user keeps the account.
#
# Env overrides mirror the flags: ZIDANE_INSTALL_ROOT, ZIDANE_USER, PURGE=1.
set -euo pipefail

INSTALL_ROOT="${ZIDANE_INSTALL_ROOT:-/opt/mangosteen/zidane-agent}"
SERVICE_USER="${ZIDANE_USER:-zidane}"
PURGE="${PURGE:-0}"
KEEP_USER=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --keep-user) KEEP_USER=1; shift ;;
    --install-root) INSTALL_ROOT="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

[[ $EUID -eq 0 ]] || die "run this uninstaller with sudo"

# --- 1. stop and remove the service ---------------------------------------
if command -v systemctl >/dev/null; then
  if systemctl list-unit-files 2>/dev/null | grep -q '^zidane-agent\.service'; then
    info "stopping and removing the systemd unit"
    # A task in flight is worth a few seconds: the agent reports the result on the way
    # down, and a hard kill would leave the backend waiting for a lease to expire.
    systemctl stop zidane-agent.service >/dev/null 2>&1 || true
    systemctl disable zidane-agent.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/zidane-agent.service
    systemctl daemon-reload >/dev/null 2>&1 || true
  else
    info "no zidane-agent systemd unit found"
  fi
elif command -v launchctl >/dev/null; then
  PLIST="/Library/LaunchDaemons/com.mangosteen.zidane-agent.plist"
  if [[ -f "$PLIST" ]]; then
    info "removing the launchd job"
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    rm -f "$PLIST"
  else
    info "no launchd job found"
  fi
else
  echo "warning: no systemctl/launchctl; stop the agent process yourself" >&2
fi

# --- 2. the install tree ---------------------------------------------------
if [[ -d "$INSTALL_ROOT" ]]; then
  if [[ "$PURGE" == "1" ]]; then
    info "deleting $INSTALL_ROOT (config, state, logs, versions)"
    rm -rf "$INSTALL_ROOT"
  else
    info "keeping $INSTALL_ROOT — pass --purge to delete it"
    echo "    config: $INSTALL_ROOT/conf/config.ini"
    echo "    logs:   $INSTALL_ROOT/logs/"
  fi
else
  info "no install tree at $INSTALL_ROOT"
fi

# --- 3. the service account ------------------------------------------------
# Only when the tree is gone too; an account with no files is harmless, but deleting one
# that still owns files leaves them orphaned to a numeric uid.
if [[ "$PURGE" == "1" && "$KEEP_USER" == "0" ]] && id -u "$SERVICE_USER" >/dev/null 2>&1; then
  # Never delete a real account. --user defaults to the dedicated `zidane` account, but
  # someone who installed under an existing login (or root) would otherwise lose it here.
  SERVICE_UID=$(id -u "$SERVICE_USER")
  if [[ "$SERVICE_UID" -eq 0 ]]; then
    echo "refusing to delete the root account; keeping user $SERVICE_USER" >&2
  elif [[ "$SERVICE_UID" -ge 1000 ]]; then
    echo "user $SERVICE_USER (uid $SERVICE_UID) looks like a real login, not a service" >&2
    echo "account — keeping it. Remove it yourself if that is wrong." >&2
  else
    info "removing the service user $SERVICE_USER"
    userdel "$SERVICE_USER" >/dev/null 2>&1 || \
      echo "warning: could not remove the user $SERVICE_USER" >&2
  fi
fi

info "zidane-agent uninstalled"
echo "The agent record stays in the Zidane console until you remove it there."
