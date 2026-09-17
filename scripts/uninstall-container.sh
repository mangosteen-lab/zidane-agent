#!/usr/bin/env bash
#
# Remove a Zidane agent container installed by install-container.sh.
#
#   curl -fsSL https://raw.githubusercontent.com/mangosteen-lab/zidane-agent/main/scripts/uninstall-container.sh | sudo bash
#   curl -fsSL .../uninstall-container.sh | sudo bash -s -- qa --purge --yes
#
# The container always goes. Its state directory — skills, memory, knowledge, Pi
# credentials, workspaces — and its settings file are kept unless asked for: an agent's
# memory exists nowhere else, and a later install under the same name picks both up again.
# Only containers carrying the installer's label are touched.
set -euo pipefail

INSTALL_ROOT=${ZIDANE_INSTALL_ROOT:-/opt/mangosteen}
LABEL=io.mangosteen.zidane-agent

usage() {
  cat <<EOF
Remove a Zidane agent container installed by install-container.sh.

Usage: uninstall-container.sh [CONTAINER] [options]

  --purge          Also delete the state directory and settings file (cannot be undone)
  --keep-data      Keep the state directory and settings file without asking
  --remove-image   Also remove the image, if no other container uses it
  -y, --yes        Do not ask; with no --purge the data is kept
  -h, --help       Show this help

Installed agents:
EOF
  installed | sed 's/^/  /'
}

say() { printf '%s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
interactive() { [[ ${ASSUME_YES} != true ]] && { : </dev/tty; } 2>/dev/null; }

confirm() {
  local question=$1 default=$2 answer=""
  if ! interactive; then
    [[ ${default} == y ]]
    return
  fi
  local hint="[y/N]"
  [[ ${default} == y ]] && hint="[Y/n]"
  read -r -p "${question} ${hint} " answer </dev/tty
  answer=${answer:-${default}}
  [[ ${answer} == [yY]* ]]
}

installed() {
  docker ps -a --filter "label=${LABEL}" --format '{{ .Names }}\t{{ .Status }}\t{{ .Image }}' 2>/dev/null || true
}

main() {
  CONTAINER=${ZIDANE_AGENT_CONTAINER:-}
  DATA=ask
  REMOVE_IMAGE=false
  ASSUME_YES=false
  while (($#)); do
    case $1 in
      --purge) DATA=delete ;;
      --keep-data) DATA=keep ;;
      --remove-image) REMOVE_IMAGE=true ;;
      -y | --yes) ASSUME_YES=true ;;
      -h | --help) usage; exit 0 ;;
      -*) fail "unknown option: $1" ;;
      *) [[ -z ${CONTAINER} ]] || fail "only one container at a time"; CONTAINER=$1 ;;
    esac
    shift
  done

  [[ ${EUID} -eq 0 ]] || fail "run as root, e.g. curl -fsSL <url> | sudo bash"
  command -v docker >/dev/null || fail "docker is not installed"
  docker info >/dev/null 2>&1 || fail "cannot reach the Docker daemon; is it running?"

  local agents
  agents=$(installed)
  if [[ -z ${CONTAINER} ]]; then
    [[ -n ${agents} ]] || fail "no agent containers installed by install-container.sh were found"
    say "Installed agents:"
    printf '%s\n' "${agents}" | sed 's/^/  /' >&2
    local only=""
    [[ $(printf '%s\n' "${agents}" | wc -l) -eq 1 ]] && only=$(cut -f1 <<<"${agents}")
    if interactive; then
      local hint=""
      [[ -n ${only} ]] && hint=" [${only}]"
      read -r -p "Container to remove${hint}: " CONTAINER </dev/tty
      CONTAINER=${CONTAINER:-${only}}
    else
      CONTAINER=${only}
    fi
    [[ -n ${CONTAINER} ]] || fail "name the container to remove"
  fi

  docker container inspect "${CONTAINER}" >/dev/null 2>&1 || fail "no container named ${CONTAINER}"
  local data_dir image
  data_dir=$(docker container inspect --format "{{ index .Config.Labels \"${LABEL}\" }}" "${CONTAINER}")
  [[ -n ${data_dir} ]] || fail "${CONTAINER} was not installed by install-container.sh; not touching it"
  image=$(docker container inspect --format '{{ .Config.Image }}' "${CONTAINER}")
  local env_file=${data_dir}.env

  # The label is only trusted as far as the naming the installer uses: nothing outside
  # ${INSTALL_ROOT}/zidane-agent-* is ever deleted, whatever a label claims.
  local deletable=false suffix=${data_dir#"${INSTALL_ROOT}/zidane-agent-"}
  if [[ ${suffix} != "${data_dir}" && ${suffix} =~ ^[a-zA-Z0-9_.-]+$ && ${suffix} != *..* ]]; then
    deletable=true
  fi

  say ""
  say "  Container   ${CONTAINER} ($(docker container inspect --format '{{ .State.Status }}' "${CONTAINER}"))"
  say "  Image       ${image}"
  say "  State       ${data_dir}"
  say "  Settings    ${env_file}"
  say ""
  confirm "Stop and remove ${CONTAINER}?" y || fail "cancelled"

  docker rm -f "${CONTAINER}" >/dev/null
  say "Removed container ${CONTAINER}."

  if [[ ${DATA} == ask ]]; then
    DATA=keep
    if interactive && [[ -e ${data_dir} || -e ${env_file} ]]; then
      if confirm "Also delete its state (skills, memory, knowledge, credentials, workspaces) and settings? This cannot be undone." n; then
        local typed=""
        read -r -p "Type the container name (${CONTAINER}) to confirm: " typed </dev/tty
        [[ ${typed} == "${CONTAINER}" ]] && DATA=delete || say "Name did not match; keeping the data."
      fi
    fi
  fi

  if [[ ${DATA} == delete ]]; then
    [[ ${deletable} == true ]] || fail "refusing to delete ${data_dir}: not under ${INSTALL_ROOT}/zidane-agent-*"
    rm -rf -- "${data_dir}"
    rm -f -- "${env_file}"
    say "Deleted ${data_dir} and ${env_file}."
  elif [[ -e ${data_dir} || -e ${env_file} ]]; then
    say "Kept ${data_dir} and ${env_file}; installing ${CONTAINER} again reuses them."
  fi

  if [[ ${REMOVE_IMAGE} == true ]]; then
    if [[ -n $(docker ps -a --filter "ancestor=${image}" --format '{{ .Names }}') ]]; then
      say "Kept image ${image}: other containers use it."
    elif docker image rm "${image}" >/dev/null 2>&1; then
      say "Removed image ${image}."
    else
      say "Could not remove image ${image}."
    fi
  fi
}

if [[ ${ZIDANE_INSTALL_SOURCE_ONLY:-} != 1 ]]; then
  main "$@"
fi
