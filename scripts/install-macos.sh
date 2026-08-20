#!/usr/bin/env bash
set -euo pipefail

if [[ -z ${ZIDANE_AGENT_SERVER_URL:-} || -z ${ZIDANE_AGENT_API_KEY:-} ]]; then
  echo "Set ZIDANE_AGENT_SERVER_URL and ZIDANE_AGENT_API_KEY in the environment." >&2
  exit 1
fi
node_major=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)
if [[ -z ${node_major} || ${node_major} -lt 22 ]]; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi
node_bin=$(command -v node)

source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
install_dir="${HOME}/Library/Application Support/Zidane Agent/app"
data_dir="${HOME}/Library/Application Support/Zidane Agent/data"
environment="${HOME}/Library/Application Support/Zidane Agent/environment"
plist="${HOME}/Library/LaunchAgents/com.zidane.agent.plist"
mkdir -p "${install_dir}" "${data_dir}" "$(dirname "${plist}")"
chmod 0700 "${HOME}/Library/Application Support/Zidane Agent" "${data_dir}"
cp -a "${source_dir}/package.json" "${source_dir}/package-lock.json" "${source_dir}/src" "${source_dir}/scripts/run-with-env.sh" "${install_dir}/"
(cd "${install_dir}" && npm ci --omit=dev)
umask 077
{
  printf 'ZIDANE_AGENT_SERVER_URL=%q\n' "${ZIDANE_AGENT_SERVER_URL}"
  printf 'ZIDANE_AGENT_API_KEY=%q\n' "${ZIDANE_AGENT_API_KEY}"
  printf 'ZIDANE_AGENT_NAME=%q\n' "${ZIDANE_AGENT_NAME:-$(hostname)}"
  printf 'ZIDANE_AGENT_DESCRIPTION=%q\n' "${ZIDANE_AGENT_DESCRIPTION:-Autonomous Pi coding agent}"
  printf 'ZIDANE_AGENT_CAPACITY=%q\n' "${ZIDANE_AGENT_CAPACITY:-1}"
  printf 'ZIDANE_AGENT_WORKING_DIRECTORY=%q\n' "${data_dir}"
  printf 'ZIDANE_AGENT_NODE_BIN=%q\n' "${node_bin}"
} >"${environment}"
chmod 0600 "${environment}"
sed -e "s|__INSTALL_DIR__|${install_dir}|g" -e "s|__DATA_DIR__|${data_dir}|g" -e "s|__ENV_FILE__|${environment}|g" "${source_dir}/services/com.zidane.agent.plist" >"${plist}"
chmod 0600 "${plist}"
launchctl bootout "gui/${UID}" "${plist}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID}" "${plist}"
echo "Zidane Agent installed as a per-user LaunchAgent."
