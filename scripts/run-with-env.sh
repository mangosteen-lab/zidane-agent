#!/usr/bin/env bash
set -euo pipefail
if [[ -z ${ZIDANE_AGENT_ENV_FILE:-} || ! -r ${ZIDANE_AGENT_ENV_FILE} ]]; then
  echo "ZIDANE_AGENT_ENV_FILE is missing or unreadable" >&2
  exit 1
fi
set -a
source "${ZIDANE_AGENT_ENV_FILE}"
set +a
exec "${ZIDANE_AGENT_NODE_BIN:-node}" "${ZIDANE_AGENT_INSTALL_DIR}/src/index.mjs"
