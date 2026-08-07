#!/usr/bin/env bash
# Run the Zidane agent as a container.
#
#   curl -fsSL https://<backend>/install-container.sh | sudo bash -s -- \
#       --url wss://host:17001/ws/agent --token zdn_... --name build-01
#
# The container installs the agent under /opt/mangosteen/zidane-agent — the same layout as
# a machine install — and upgrades to the latest published release on every start. The
# backend's in-app upgrade button stays disabled for containers: flipping a symlink inside
# one is undone by the next deploy, so `docker restart` is the upgrade.
#
# State and logs are bind-mounted so they survive both an image roll and a restart.
set -euo pipefail

NAME="${ZIDANE_CONTAINER_NAME:-zidane-agent}"
IMAGE="${ZIDANE_IMAGE:-ghcr.io/mangosteen-lab/zidane-agent:latest}"
WSS_URL="${ZIDANE_BACKEND_WSS_URL:-}"
API_KEY="${ZIDANE_BACKEND_API_KEY:-}"
CAPACITY="${ZIDANE_AGENT_CAPACITY:-4}"
LABELS="${ZIDANE_AGENT_LABELS:-os=linux}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) WSS_URL="$2"; shift 2 ;;
    --token) API_KEY="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --capacity) CAPACITY="$2"; shift 2 ;;
    --labels) LABELS="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$WSS_URL" ]] || { echo "error: --url is required" >&2; exit 1; }
[[ -n "$API_KEY" ]] || { echo "error: --token is required" >&2; exit 1; }
command -v docker >/dev/null || { echo "error: docker is required" >&2; exit 1; }

HOST_DIR="/opt/mangosteen/${NAME}"
mkdir -p "$HOST_DIR"/{state,logs,workspace}

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker pull "$IMAGE"
docker run -d --name "$NAME" --restart unless-stopped \
  -e ZIDANE_BACKEND_WSS_URL="$WSS_URL" \
  -e ZIDANE_BACKEND_API_KEY="$API_KEY" \
  -e ZIDANE_AGENT_NAME="$NAME" \
  -e ZIDANE_AGENT_CAPACITY="$CAPACITY" \
  -e ZIDANE_AGENT_LABELS="$LABELS" \
  -v "$HOST_DIR/state:/opt/mangosteen/zidane-agent/state" \
  -v "$HOST_DIR/logs:/opt/mangosteen/zidane-agent/logs" \
  -v "$HOST_DIR/workspace:/opt/mangosteen/zidane-workspace" \
  "$IMAGE"

echo "==> started $NAME; follow with: docker logs -f $NAME"
echo "==> the agent upgrades itself on restart: docker restart $NAME"
echo "==> to move the toolchain too: docker pull $IMAGE && $0 --name $NAME --url $WSS_URL --token <token>"
