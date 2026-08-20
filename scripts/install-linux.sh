#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi
if [[ -z ${ZIDANE_AGENT_SERVER_URL:-} || -z ${ZIDANE_AGENT_API_KEY:-} ]]; then
  echo "Set ZIDANE_AGENT_SERVER_URL and ZIDANE_AGENT_API_KEY in the environment." >&2
  exit 1
fi
node_major=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)
if [[ -z ${node_major} || ${node_major} -lt 22 ]]; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi

source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
install_dir=/opt/zidane-agent
data_dir=/var/lib/zidane-agent

getent group zidane >/dev/null || groupadd --system zidane
id zidane >/dev/null 2>&1 || useradd --system --gid zidane --home-dir "${data_dir}" --create-home --shell /usr/sbin/nologin zidane
install -d -o root -g root -m 0755 "${install_dir}"
install -d -o zidane -g zidane -m 0700 "${data_dir}"
cp -a "${source_dir}/package.json" "${source_dir}/package-lock.json" "${source_dir}/src" "${install_dir}/"
(cd "${install_dir}" && npm ci --omit=dev)
chown -R root:root "${install_dir}"

install -d -o root -g root -m 0755 /etc/zidane-agent
environment=/etc/zidane-agent/environment
umask 077
{
  printf 'ZIDANE_AGENT_SERVER_URL=%q\n' "${ZIDANE_AGENT_SERVER_URL}"
  printf 'ZIDANE_AGENT_API_KEY=%q\n' "${ZIDANE_AGENT_API_KEY}"
  printf 'ZIDANE_AGENT_NAME=%q\n' "${ZIDANE_AGENT_NAME:-$(hostname)}"
  printf 'ZIDANE_AGENT_DESCRIPTION=%q\n' "${ZIDANE_AGENT_DESCRIPTION:-Autonomous Pi coding agent}"
  printf 'ZIDANE_AGENT_CAPACITY=%q\n' "${ZIDANE_AGENT_CAPACITY:-1}"
  printf 'ZIDANE_AGENT_WORKING_DIRECTORY=%q\n' "${data_dir}"
} >"${environment}"
chmod 0600 "${environment}"
install -o root -g root -m 0644 "${source_dir}/services/zidane-agent.service" /etc/systemd/system/zidane-agent.service
systemctl daemon-reload
systemctl enable --now zidane-agent.service
echo "Zidane Agent installed and started as the zidane service account."
