#!/usr/bin/env bash
#
# Install a Zidane agent as a Docker container.
#
#   curl -fsSL https://raw.githubusercontent.com/mangosteen-lab/zidane-agent/main/scripts/install-container.sh | sudo bash
#
# It asks for what the agent needs — a container name, the agent's name, the server URL,
# and the registration key the console showed once — pulls the image, and starts the
# container with its state bind-mounted from the host:
#
#   /opt/mangosteen/zidane-agent-<container>        the agent's working directory
#   /opt/mangosteen/zidane-agent-<container>.env    its settings, root-only (0600)
#
# Every answer can be given up front instead, as a flag or an environment variable, which
# is how it runs without a terminal:
#
#   curl -fsSL .../install-container.sh | sudo bash -s -- --yes \
#     --container qa --server-url wss://zidane.example.com --api-key zidane_...
#
# Running it again for a container that already exists is the upgrade: the saved settings
# become the defaults, the key is kept unless a new one is given, the container is
# replaced, and the state directory is left exactly as it was.
set -euo pipefail

ZIDANE_AGENT_RELEASE=1.2.0
IMAGE_REPOSITORY=ghcr.io/mangosteen-lab/zidane-agent
INSTALL_ROOT=${ZIDANE_INSTALL_ROOT:-/opt/mangosteen}
CONTAINER_WORKDIR=/var/lib/zidane-agent
LABEL=io.mangosteen.zidane-agent
UNINSTALL_URL=https://raw.githubusercontent.com/mangosteen-lab/zidane-agent/main/scripts/uninstall-container.sh
UPGRADE_URL=https://raw.githubusercontent.com/mangosteen-lab/zidane-agent/main/scripts/upgrade-container.sh

usage() {
  cat <<EOF
Install a Zidane agent as a Docker container (release ${ZIDANE_AGENT_RELEASE}).

Usage: install-container.sh [options]

  --container NAME       Docker container name; state goes to ${INSTALL_ROOT}/zidane-agent-NAME
  --name NAME            Agent name shown in the console (default: the container name)
  --server-url URL       Zidane server, e.g. wss://zidane.example.com (https:// also accepted)
  --api-key KEY          Registration key shown once by the console
  --description TEXT     Operator-facing description
  --capacity N           Maximum concurrent sessions (default: 5)
  --image IMAGE          Image to run (default: ${IMAGE_REPOSITORY}:${ZIDANE_AGENT_RELEASE})
  --network MODE         Docker network (default: bridge, or host when the server is on localhost)
  --allow-insecure-ws    Permit plain ws:// to a remote server (trusted networks only)
  -y, --yes              Do not ask; take defaults and the values given
  -h, --help             Show this help

Each option can also be set in the environment: ZIDANE_AGENT_CONTAINER, ZIDANE_AGENT_NAME,
ZIDANE_AGENT_SERVER_URL, ZIDANE_AGENT_API_KEY, ZIDANE_AGENT_DESCRIPTION,
ZIDANE_AGENT_CAPACITY, ZIDANE_AGENT_IMAGE, ZIDANE_AGENT_NETWORK,
ZIDANE_AGENT_ALLOW_INSECURE_WS=true. ZIDANE_INSTALL_ROOT moves ${INSTALL_ROOT}.
EOF
}

say() { printf '%s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# A piped script has the script itself on stdin, so questions go to the terminal.
interactive() { [[ ${ASSUME_YES} != true ]] && { : </dev/tty; } 2>/dev/null; }

# ask VARIABLE "Question" DEFAULT [secret]
ask() {
  local variable=$1 question=$2 default=${3:-} secret=${4:-} answer=""
  if ! interactive; then
    printf -v "${variable}" '%s' "${default}"
    return
  fi
  if [[ -n ${secret} ]]; then
    local hint=""
    [[ -n ${default} ]] && hint=" [keep current]"
    read -r -s -p "${question}${hint}: " answer </dev/tty
    printf '\n' >&2
  else
    local hint=""
    [[ -n ${default} ]] && hint=" [${default}]"
    read -r -p "${question}${hint}: " answer </dev/tty
  fi
  printf -v "${variable}" '%s' "${answer:-${default}}"
}

# confirm "Question" y|n — the default is what an empty answer, or no terminal, means.
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

# The server as the agent needs it: a ws/wss URL ending in the agent endpoint. A console
# address pasted as https://host is what people have to hand, so it is accepted.
normalize_url() {
  local url=$1
  url=${url#"${url%%[![:space:]]*}"}
  url=${url%"${url##*[![:space:]]}"}
  [[ ${url} =~ ^(wss?|https?)://([^/?#]+)(/[^?#]*)?$ ]] || return 1
  local scheme=${BASH_REMATCH[1]} authority=${BASH_REMATCH[2]} path=${BASH_REMATCH[3]}
  case ${scheme} in
    http) scheme=ws ;;
    https) scheme=wss ;;
  esac
  path=${path%/}
  [[ -z ${path} ]] && path=/ws/agent
  printf '%s://%s%s\n' "${scheme}" "${authority}" "${path}"
}

url_host() {
  local authority
  authority=$(sed -E 's#^[a-z]+://([^/]+).*#\1#' <<<"$1")
  if [[ ${authority} == \[* ]]; then
    authority=${authority#[}
    printf '%s\n' "${authority%%]*}"
  else
    printf '%s\n' "${authority%%:*}"
  fi
}

is_local_host() {
  case $1 in
    localhost | 127.0.0.1 | ::1) return 0 ;;
    *) return 1 ;;
  esac
}

valid_container() { [[ $1 =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$ ]]; }

# State directory for a container. A container already called zidane-agent-qa gets
# zidane-agent-qa, not zidane-agent-zidane-agent-qa.
data_dir_for() { printf '%s/zidane-agent-%s\n' "${INSTALL_ROOT}" "${1#zidane-agent-}"; }

# Values saved by an earlier install. Read line by line, never sourced: the file is plain
# KEY=value for `docker --env-file`, which does not unquote.
read_saved() {
  local file=$1 key value
  [[ -r ${file} ]] || return 0
  while IFS='=' read -r key value; do
    case ${key} in
      ZIDANE_AGENT_NAME) SAVED_NAME=${value} ;;
      ZIDANE_AGENT_SERVER_URL) SAVED_SERVER_URL=${value} ;;
      ZIDANE_AGENT_API_KEY) SAVED_API_KEY=${value} ;;
      ZIDANE_AGENT_DESCRIPTION) SAVED_DESCRIPTION=${value} ;;
      ZIDANE_AGENT_CAPACITY) SAVED_CAPACITY=${value} ;;
      ZIDANE_AGENT_ALLOW_INSECURE_WS) SAVED_ALLOW_INSECURE_WS=${value} ;;
      ZIDANE_INSTALL_IMAGE) SAVED_IMAGE=${value} ;;
      ZIDANE_INSTALL_NETWORK) SAVED_NETWORK=${value} ;;
    esac
  done <"${file}"
}

one_line() { [[ $1 != *$'\n'* && $1 != *$'\r'* ]]; }

main() {
  CONTAINER=${ZIDANE_AGENT_CONTAINER:-}
  NAME=${ZIDANE_AGENT_NAME:-}
  SERVER_URL=${ZIDANE_AGENT_SERVER_URL:-}
  API_KEY=${ZIDANE_AGENT_API_KEY:-}
  DESCRIPTION=${ZIDANE_AGENT_DESCRIPTION:-}
  CAPACITY=${ZIDANE_AGENT_CAPACITY:-}
  IMAGE=${ZIDANE_AGENT_IMAGE:-}
  NETWORK=${ZIDANE_AGENT_NETWORK:-}
  ALLOW_INSECURE_WS=${ZIDANE_AGENT_ALLOW_INSECURE_WS:-}
  ASSUME_YES=false

  while (($#)); do
    case $1 in
      --container) CONTAINER=${2:?--container needs a value}; shift ;;
      --name) NAME=${2:?--name needs a value}; shift ;;
      --server-url) SERVER_URL=${2:?--server-url needs a value}; shift ;;
      --api-key) API_KEY=${2:?--api-key needs a value}; shift ;;
      --description) DESCRIPTION=${2:?--description needs a value}; shift ;;
      --capacity) CAPACITY=${2:?--capacity needs a value}; shift ;;
      --image) IMAGE=${2:?--image needs a value}; shift ;;
      --network) NETWORK=${2:?--network needs a value}; shift ;;
      --allow-insecure-ws) ALLOW_INSECURE_WS=true ;;
      -y | --yes) ASSUME_YES=true ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; fail "unknown option: $1" ;;
    esac
    shift
  done

  [[ ${EUID} -eq 0 ]] || fail "run as root, e.g. curl -fsSL <url> | sudo bash — it writes to ${INSTALL_ROOT} and hands the state directory to the container's user"
  command -v docker >/dev/null || fail "docker is not installed; see https://docs.docker.com/engine/install/"
  docker info >/dev/null 2>&1 || fail "cannot reach the Docker daemon; is it running?"
  if [[ ${ASSUME_YES} != true ]] && ! interactive; then
    say "No terminal to ask on; using the values given (as with --yes)."
    ASSUME_YES=true
  fi

  say "Zidane agent container installer (release ${ZIDANE_AGENT_RELEASE})"
  say ""

  # 1. Which container. Everything else defaults from what that container had before.
  local default_container
  default_container=$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_.\n-' '-')
  valid_container "${default_container}" || default_container=zidane-agent
  while :; do
    ask CONTAINER "Container name" "${CONTAINER:-${default_container}}"
    valid_container "${CONTAINER}" && break
    interactive || fail "invalid container name: ${CONTAINER} (letters, digits, _ . -)"
    say "  Use letters, digits, '_', '.' or '-', starting with a letter or digit."
    CONTAINER=""
  done
  DATA_DIR=$(data_dir_for "${CONTAINER}")
  ENV_FILE=${DATA_DIR}.env

  SAVED_NAME="" SAVED_SERVER_URL="" SAVED_API_KEY="" SAVED_DESCRIPTION="" SAVED_CAPACITY=""
  SAVED_ALLOW_INSECURE_WS="" SAVED_IMAGE="" SAVED_NETWORK=""
  read_saved "${ENV_FILE}"
  [[ -f ${ENV_FILE} ]] && say "  Found an existing install; its settings are the defaults."

  local existing_label=""
  if docker container inspect "${CONTAINER}" >/dev/null 2>&1; then
    existing_label=$(docker container inspect --format "{{ index .Config.Labels \"${LABEL}\" }}" "${CONTAINER}")
    [[ -n ${existing_label} ]] || fail "a container named ${CONTAINER} already exists and was not installed by this script; pick another name"
  fi

  # 2. The agent itself.
  ask NAME "Agent name (shown in the console)" "${NAME:-${SAVED_NAME:-${CONTAINER}}}"
  [[ -n ${NAME} ]] && one_line "${NAME}" || fail "the agent name must be one non-empty line"

  local normalized=""
  while :; do
    ask SERVER_URL "Zidane server URL (wss://host or https://host)" "${SERVER_URL:-${SAVED_SERVER_URL}}"
    if [[ -n ${SERVER_URL} ]] && normalized=$(normalize_url "${SERVER_URL}"); then
      break
    fi
    interactive || fail "a server URL like wss://zidane.example.com is required"
    say "  Enter a ws://, wss://, http:// or https:// address."
    SERVER_URL=""
  done
  [[ ${SERVER_URL} == "${normalized}" ]] || say "  Agent endpoint: ${normalized}"
  SERVER_URL=${normalized}

  while :; do
    ask API_KEY "Registration API key" "${API_KEY:-${SAVED_API_KEY}}" secret
    [[ -n ${API_KEY} && ${API_KEY} != *[[:space:]]* ]] && break
    interactive || fail "the registration key is required (--api-key or ZIDANE_AGENT_API_KEY)"
    say "  The key is required, and has no spaces. Create one in the console under Agents."
    API_KEY=""
  done

  ask DESCRIPTION "Description" "${DESCRIPTION:-${SAVED_DESCRIPTION:-Autonomous Pi coding agent}}"
  one_line "${DESCRIPTION}" || fail "the description must be one line"

  while :; do
    ask CAPACITY "Maximum concurrent sessions" "${CAPACITY:-${SAVED_CAPACITY:-5}}"
    [[ ${CAPACITY} =~ ^[1-9][0-9]*$ ]] && break
    interactive || fail "capacity must be a whole number of at least 1"
    say "  Enter a whole number of at least 1."
    CAPACITY=""
  done

  # 3. What the URL implies. Inside a container localhost is the container, so a server
  # on the host's localhost is only reachable over the host network.
  # Only a network somebody chose is kept across installs; otherwise it follows the URL.
  local host
  host=$(url_host "${SERVER_URL}")
  NETWORK=${NETWORK:-${SAVED_NETWORK}}
  CHOSEN_NETWORK=${NETWORK}
  if [[ -z ${NETWORK} ]]; then
    if is_local_host "${host}"; then
      NETWORK=host
      say "  The server is on this machine's ${host}; the container will use the host network."
    else
      NETWORK=bridge
    fi
  fi
  ALLOW_INSECURE_WS=${ALLOW_INSECURE_WS:-${SAVED_ALLOW_INSECURE_WS:-false}}
  if [[ ${SERVER_URL} == ws://* ]] && ! is_local_host "${host}" && [[ ${ALLOW_INSECURE_WS} != true ]]; then
    if confirm "The server uses unencrypted ws://, which the agent refuses for a remote host. Allow it (trusted networks only)?" n; then
      ALLOW_INSECURE_WS=true
    else
      fail "use wss://, or pass --allow-insecure-ws on a trusted network"
    fi
  fi

  if [[ -z ${IMAGE} ]]; then
    IMAGE=${SAVED_IMAGE:-${IMAGE_REPOSITORY}:${ZIDANE_AGENT_RELEASE}}
    # An earlier install of a release image upgrades to this script's release; an image
    # somebody chose by hand, or :latest, is left as it was.
    if [[ ${IMAGE} =~ ^${IMAGE_REPOSITORY}:[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      IMAGE=${IMAGE_REPOSITORY}:${ZIDANE_AGENT_RELEASE}
    fi
  fi

  say ""
  say "  Container      ${CONTAINER}$([[ -n ${existing_label} ]] && printf ' (replacing the existing one; state is kept)')"
  say "  Agent name     ${NAME}"
  say "  Server         ${SERVER_URL}"
  say "  API key        ${API_KEY:0:7}… (${#API_KEY} characters)"
  say "  Description    ${DESCRIPTION}"
  say "  Capacity       ${CAPACITY}"
  say "  Image          ${IMAGE}"
  say "  Network        ${NETWORK}"
  say "  State          ${DATA_DIR} -> ${CONTAINER_WORKDIR}"
  say "  Settings       ${ENV_FILE}"
  say ""
  confirm "Install?" y || fail "cancelled"

  # 4. Image first: nothing on the host changes if the pull fails.
  say "Pulling ${IMAGE}…"
  if ! docker pull "${IMAGE}" >&2; then
    docker image inspect "${IMAGE}" >/dev/null 2>&1 || fail "could not pull ${IMAGE}"
    say "  Could not pull; using the local copy of ${IMAGE}."
  fi

  # A bind mount keeps the host's ownership, so the directory is handed to whichever user
  # the image runs as — asked of the image rather than assumed.
  local uid gid
  uid=$(docker run --rm --entrypoint id "${IMAGE}" -u) || fail "could not read the image's user"
  gid=$(docker run --rm --entrypoint id "${IMAGE}" -g) || fail "could not read the image's group"

  install -d -o root -g root -m 0755 "${INSTALL_ROOT}"
  install -d -m 0700 "${DATA_DIR}"
  # Recursive only when something is not already the agent's: a state tree can be large,
  # and a copy made as root leaves the agent owning the directory but nothing inside it.
  if [[ -n $(find "${DATA_DIR}" \( ! -uid "${uid}" -o ! -gid "${gid}" \) -print -quit) ]]; then
    chown -R "${uid}:${gid}" "${DATA_DIR}"
  fi
  chmod 0700 "${DATA_DIR}"

  (
    umask 077
    {
      printf 'ZIDANE_AGENT_NAME=%s\n' "${NAME}"
      printf 'ZIDANE_AGENT_SERVER_URL=%s\n' "${SERVER_URL}"
      printf 'ZIDANE_AGENT_API_KEY=%s\n' "${API_KEY}"
      printf 'ZIDANE_AGENT_DESCRIPTION=%s\n' "${DESCRIPTION}"
      printf 'ZIDANE_AGENT_CAPACITY=%s\n' "${CAPACITY}"
      printf 'ZIDANE_AGENT_ALLOW_INSECURE_WS=%s\n' "${ALLOW_INSECURE_WS}"
      # Read back by the next install; the agent ignores them.
      printf 'ZIDANE_INSTALL_IMAGE=%s\n' "${IMAGE}"
      printf 'ZIDANE_INSTALL_NETWORK=%s\n' "${CHOSEN_NETWORK}"
    } >"${ENV_FILE}.new"
    chown root:root "${ENV_FILE}.new"
    mv -f "${ENV_FILE}.new" "${ENV_FILE}"
  )

  local mount="${DATA_DIR}:${CONTAINER_WORKDIR}"
  if docker info --format '{{ .SecurityOptions }}' 2>/dev/null | grep -q selinux; then
    mount="${mount}:Z"
  fi

  if [[ -n ${existing_label} ]]; then
    say "Replacing container ${CONTAINER}…"
    docker rm -f "${CONTAINER}" >/dev/null
  fi

  say "Starting ${CONTAINER}…"
  docker run -d \
    --name "${CONTAINER}" \
    --label "${LABEL}=${DATA_DIR}" \
    --restart unless-stopped \
    --network "${NETWORK}" \
    --env-file "${ENV_FILE}" \
    --log-opt max-size=10m --log-opt max-file=3 \
    -v "${mount}" \
    "${IMAGE}" >/dev/null || fail "docker run failed"

  # A bad key or an unreachable server shows within seconds; say so here rather than
  # leaving it to be discovered in the console.
  sleep 8
  local state
  state=$(docker container inspect --format '{{ .State.Status }} {{ .RestartCount }}' "${CONTAINER}")
  say ""
  say "Recent log:"
  docker logs --tail 15 "${CONTAINER}" 2>&1 | sed 's/^/  /' >&2
  say ""
  if [[ ${state} != "running 0" ]]; then
    say "The container is not staying up (${state}). Check the log above; fix the settings by running this installer again."
    exit 1
  fi
  if docker logs "${CONTAINER}" 2>&1 | grep -q '"message":"agent registered"'; then
    say "Installed ${CONTAINER}; it is connected and registered as \"${NAME}\"."
  else
    say "Installed ${CONTAINER}, but it has not registered with the server yet. If the log above"
    say "shows connection or authentication errors, check the URL and key and run the installer again."
  fi
  say ""
  say "  Logs       docker logs -f ${CONTAINER}"
  say "  Restart    docker restart ${CONTAINER}"
  say "  Upgrade    curl -fsSL ${UPGRADE_URL} | sudo bash -s -- ${CONTAINER}"
  say "  Uninstall  curl -fsSL ${UNINSTALL_URL} | sudo bash -s -- ${CONTAINER}"
}

# Tests source the helpers without installing anything.
if [[ ${ZIDANE_INSTALL_SOURCE_ONLY:-} != 1 ]]; then
  main "$@"
fi
