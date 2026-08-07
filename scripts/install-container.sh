#!/usr/bin/env bash
# Run the Zidane agent as a container.
#
#   curl -fsSL https://<backend>/install-container.sh | sudo bash -s -- \
#       --url wss://host:17001/ws/agent --token zdn_... --name build-01
#
# State and logs are bind-mounted so they survive an image roll — which is how a
# containerised agent upgrades. The in-app upgrade button is disabled for it.
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

HOST_DIR="/opt/zidane/${NAME}"
mkdir -p "$HOST_DIR"/{state,work,logs,conf}

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker pull "$IMAGE"
docker run -d --name "$NAME" --restart unless-stopped \
  -e ZIDANE_BACKEND_WSS_URL="$WSS_URL" \
  -e ZIDANE_BACKEND_API_KEY="$API_KEY" \
  -e ZIDANE_AGENT_NAME="$NAME" \
  -e ZIDANE_AGENT_CAPACITY="$CAPACITY" \
  -e ZIDANE_AGENT_LABELS="$LABELS" \
  -v "$HOST_DIR/state:/opt/zidane/zidane-agent/state" \
  -v "$HOST_DIR/work:/opt/zidane/zidane-agent/work" \
  -v "$HOST_DIR/logs:/opt/zidane/zidane-agent/logs" \
  "$IMAGE"

echo "==> started $NAME; follow with: docker logs -f $NAME"
echo "==> upgrade with: docker pull $IMAGE && $0 --name $NAME --url $WSS_URL --token <token>"
