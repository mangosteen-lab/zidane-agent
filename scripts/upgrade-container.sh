#!/usr/bin/env bash
#
# Upgrade a Zidane agent container installed by install-container.sh to the latest release.
#
#   curl -fsSL https://raw.githubusercontent.com/mangosteen-lab/zidane-agent/main/scripts/upgrade-container.sh | sudo bash
#   curl -fsSL .../upgrade-container.sh | sudo bash -s -- qa --yes
#   curl -fsSL .../upgrade-container.sh | sudo bash -s -- --all --yes
#
# The upgrade is the target release's own installer, run unattended against the existing
# container: it reads the settings saved beside the state directory, pulls the new image,
# and replaces the container, leaving the state directory as it was. Using that release's
# installer rather than a copy of its steps means a release that changes how the container
# is run upgrades into exactly that.
#
# If the new container does not stay up, the previous image is put back the same way.
set -euo pipefail

REPOSITORY=mangosteen-lab/zidane-agent
IMAGE_REPOSITORY=ghcr.io/${REPOSITORY}
LABEL=io.mangosteen.zidane-agent

usage() {
  cat <<EOF
Upgrade Zidane agent containers installed by install-container.sh.

Usage: upgrade-container.sh [CONTAINER | --all] [options]

  --all              Upgrade every agent container installed by install-container.sh
  --version VERSION  Upgrade to this release instead of the latest (e.g. 1.1.0)
  --installer FILE   Use this install-container.sh instead of the release's own
  --force            Replace the container even when it already runs the target release,
                     and allow moving to an older release without asking
  -y, --yes          Do not ask
  -h, --help         Show this help
EOF
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

is_version() { [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

# The highest x.y.z among the lines on stdin; anything else is ignored.
highest_version() {
  grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1
}

# 0 when $1 is older than $2.
older_than() {
  [[ $1 != "$2" && $(printf '%s\n%s\n' "$1" "$2" | highest_version) == "$2" ]]
}

# The newest release: GitHub's latest release, or failing that — an API rate limit, a
# proxy that only lets the registry through — the highest version tag on the image.
latest_release() {
  local version token
  version=$(curl -fsSL --max-time 20 "https://api.github.com/repos/${REPOSITORY}/releases/latest" 2>/dev/null \
    | sed -nE 's/^[[:space:]]*"tag_name":[[:space:]]*"v?([^"]+)".*/\1/p' | head -n 1) || true
  if ! is_version "${version}"; then
    token=$(curl -fsSL --max-time 20 "https://ghcr.io/token?scope=repository:${REPOSITORY}:pull&service=ghcr.io" 2>/dev/null \
      | sed -nE 's/.*"token":"([^"]+)".*/\1/p') || true
    version=$(curl -fsSL --max-time 20 -H "Authorization: Bearer ${token}" "https://ghcr.io/v2/${REPOSITORY}/tags/list" 2>/dev/null \
      | grep -oE '"[0-9]+\.[0-9]+\.[0-9]+"' | tr -d '"' | highest_version) || true
  fi
  is_version "${version}" || return 1
  printf '%s\n' "${version}"
}

# The release an image reference names, when its tag is one.
version_of() {
  local tag=${1##*/}
  [[ ${tag} == *:* ]] || return 1
  tag=${tag##*:}
  is_version "${tag}" || return 1
  printf '%s\n' "${tag}"
}

installed() {
  docker ps -a --filter "label=${LABEL}" --format '{{ .Names }}' 2>/dev/null || true
}

# Run an installer against one container, with nothing from this shell's environment
# overriding the settings that install saved.
run_installer() {
  local installer=$1 container=$2 image=$3 root=$4
  env -u ZIDANE_AGENT_NAME -u ZIDANE_AGENT_SERVER_URL -u ZIDANE_AGENT_API_KEY \
    -u ZIDANE_AGENT_DESCRIPTION -u ZIDANE_AGENT_CAPACITY -u ZIDANE_AGENT_IMAGE \
    -u ZIDANE_AGENT_NETWORK -u ZIDANE_AGENT_ALLOW_INSECURE_WS -u ZIDANE_AGENT_CONTAINER \
    ZIDANE_INSTALL_ROOT="${root}" \
    bash "${installer}" --yes --container "${container}" --image "${image}" </dev/null
}

upgrade_one() {
  local container=$1 target=$2 installer=$3
  local data_dir image image_id current root expected
  docker container inspect "${container}" >/dev/null 2>&1 || { say "${container}: no such container"; return 1; }
  data_dir=$(docker container inspect --format "{{ index .Config.Labels \"${LABEL}\" }}" "${container}")
  [[ -n ${data_dir} ]] || { say "${container}: not installed by install-container.sh; skipping"; return 1; }
  image=$(docker container inspect --format '{{ .Config.Image }}' "${container}")
  image_id=$(docker container inspect --format '{{ .Image }}' "${container}")
  current=$(version_of "${image}") || current=""

  # The installer derives the state directory from its root and the container name, so
  # the root is taken from where this container's state actually is — and checked, since
  # a mismatch would start the agent on an empty directory.
  root=$(dirname "${data_dir}")
  expected="${root}/zidane-agent-${container#zidane-agent-}"
  [[ ${expected} == "${data_dir}" ]] || { say "${container}: state ${data_dir} is not where the installer would look (${expected}); upgrade it by hand"; return 1; }
  [[ -r ${data_dir}.env ]] || { say "${container}: settings file ${data_dir}.env is missing; run install-container.sh for it instead"; return 1; }

  local target_image=${IMAGE_REPOSITORY}:${target}
  say ""
  say "${container}: ${current:-${image}} -> ${target}"

  if [[ ${current} == "${target}" && ${FORCE} != true ]]; then
    # A release tag is not supposed to move, but check the image rather than trust it.
    if docker pull -q "${target_image}" >/dev/null 2>&1 \
      && [[ $(docker image inspect --format '{{ .Id }}' "${target_image}") == "${image_id}" ]]; then
      say "  Already up to date."
      return 0
    fi
  fi
  if [[ -n ${current} ]] && older_than "${target}" "${current}" && [[ ${FORCE} != true ]]; then
    confirm "  ${target} is older than the running ${current}. Downgrade?" n \
      || { say "  Skipped: not downgrading without --force."; return 1; }
  elif ! confirm "  Upgrade ${container} to ${target}?" y; then
    say "  Skipped."
    return 0
  fi

  if run_installer "${installer}" "${container}" "${target_image}" "${root}"; then
    say "${container}: now running ${target}."
    return 0
  fi

  # A failure before the container was replaced — the pull, say — left the old one running.
  if [[ $(docker container inspect --format '{{ .Image }} {{ .State.Running }}' "${container}" 2>/dev/null) == "${image_id} true" ]]; then
    say "${container}: not upgraded; still running ${image}."
    return 1
  fi

  # Otherwise the new container is not staying up. Put back exactly what was running: by
  # tag when it was a release, by image id otherwise, since a moving tag may no longer
  # name it.
  local previous=${image}
  [[ -n ${current} ]] || previous=${image_id}
  say "${container}: ${target} did not come up; rolling back to ${image}."
  if run_installer "${installer}" "${container}" "${previous}" "${root}"; then
    say "${container}: rolled back to ${image}."
  else
    say "${container}: rollback failed too; check docker logs ${container}."
  fi
  return 1
}

main() {
  local container="" all=false version="" installer=""
  FORCE=false
  ASSUME_YES=false
  while (($#)); do
    case $1 in
      --all) all=true ;;
      --version) version=${2:?--version needs a value}; version=${version#v}; shift ;;
      --installer) installer=${2:?--installer needs a value}; shift ;;
      --force) FORCE=true ;;
      -y | --yes) ASSUME_YES=true ;;
      -h | --help) usage; exit 0 ;;
      -*) usage >&2; fail "unknown option: $1" ;;
      *) [[ -z ${container} ]] || fail "name one container, or use --all"; container=$1 ;;
    esac
    shift
  done
  [[ -z ${container} || ${all} != true ]] || fail "name one container, or use --all — not both"

  [[ ${EUID} -eq 0 ]] || fail "run as root, e.g. curl -fsSL <url> | sudo bash"
  command -v docker >/dev/null || fail "docker is not installed"
  command -v curl >/dev/null || fail "curl is required"
  docker info >/dev/null 2>&1 || fail "cannot reach the Docker daemon; is it running?"

  local containers=()
  if [[ ${all} == true ]]; then
    mapfile -t containers < <(installed)
    ((${#containers[@]})) || fail "no agent containers installed by install-container.sh were found"
  elif [[ -n ${container} ]]; then
    containers=("${container}")
  else
    mapfile -t containers < <(installed)
    ((${#containers[@]})) || fail "no agent containers installed by install-container.sh were found"
    if ((${#containers[@]} > 1)); then
      say "Installed agents:"
      docker ps -a --filter "label=${LABEL}" --format '  {{ .Names }}\t{{ .Status }}\t{{ .Image }}' >&2
      interactive || fail "several agents are installed; name one, or use --all"
      read -r -p "Container to upgrade (or 'all'): " container </dev/tty
      [[ -n ${container} ]] || fail "name the container to upgrade"
      [[ ${container} == all ]] || containers=("${container}")
    fi
  fi

  if [[ -z ${version} ]]; then
    say "Looking up the latest release…"
    version=$(latest_release) || fail "could not find the latest release; pass --version"
  fi
  is_version "${version}" || fail "not a release version: ${version}"
  say "Target release: ${version}"

  SCRATCH=$(mktemp -d)
  trap 'rm -rf "${SCRATCH}"' EXIT
  if [[ -z ${installer} ]]; then
    installer=${SCRATCH}/install-container.sh
    curl -fsSL --max-time 60 -o "${installer}" \
      "https://raw.githubusercontent.com/${REPOSITORY}/v${version}/scripts/install-container.sh" \
      || fail "release ${version} has no install-container.sh to upgrade with"
  fi
  [[ -r ${installer} ]] || fail "cannot read ${installer}"
  bash -n "${installer}" || fail "${installer} is not a valid script"

  local failed=0
  for container in "${containers[@]}"; do
    upgrade_one "${container}" "${version}" "${installer}" || failed=$((failed + 1))
  done
  say ""
  ((failed == 0)) || fail "${failed} of ${#containers[@]} container(s) were not upgraded"
  say "Done."
}

if [[ ${ZIDANE_INSTALL_SOURCE_ONLY:-} != 1 ]]; then
  main "$@"
fi
