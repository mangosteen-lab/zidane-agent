FROM ubuntu:24.04

LABEL org.opencontainers.image.description="Zidane Pi coding agent"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    ZIDANE_AGENT_WORKING_DIRECTORY=/var/lib/zidane-agent

# Where a skill looks for the agent's config maps and its synced knowledge. A separate ENV
# so the paths derive from the working directory above rather than repeating it:
# substitution within one ENV instruction only sees values set before that instruction. The
# agent re-asserts both at startup, so overriding ZIDANE_AGENT_WORKING_DIRECTORY at run time
# still resolves correctly for the agent and everything it spawns; this is what
# `docker exec` sees.
ENV AI_AGENT_CONFIG_MAPS_FOLDER=${ZIDANE_AGENT_WORKING_DIRECTORY}/config-maps \
    AI_AGENT_KNOWLEDGE_FOLDER=${ZIDANE_AGENT_WORKING_DIRECTORY}/knowledge

# The tools a session can reach are the ones in this image, plus whatever it installs
# into its shared $HOME: a session runs unprivileged, so apt is out of reach and a
# `~/.local` install is the only other way in. Anything the work needs regularly belongs
# here, where it is version-controlled and the same for every agent from this image.
# `gh` and `glab` come from Ubuntu's own repositories rather than a vendor apt source:
# no key to manage, both architectures covered, and security updates arrive with the
# base image. They read GH_TOKEN/GITHUB_TOKEN and GITLAB_TOKEN from the environment,
# which is where a config map's secret values already land.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl fd-find gh git git-lfs glab jq openssh-client \
      python3 python3-venv ripgrep tini unzip xz-utils \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# The system git config, which is the layer everything else overrides.
#
# An identity has to exist somewhere or `git commit` fails outright with "Author identity
# unknown", and this is the only layer the image can write: `~/.gitconfig` belongs to the
# sessions, which is exactly why it must not be the only source of one. Set it per agent
# with `git config --global` from a session — the shared home persists, and global beats
# system.
#
# `git lfs install --system` registers the LFS filters here for the same reason: without
# it a repository using LFS checks out pointer files and the build fails a step later,
# somewhere that does not mention LFS at all.
RUN git config --system user.name "Zidane Agent" \
    && git config --system user.email "zidane-agent@localhost" \
    && git config --system init.defaultBranch main \
    && git lfs install --system

WORKDIR /opt/zidane-agent
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src ./src

RUN useradd --system --create-home --home-dir /var/lib/zidane-agent zidane \
    && install -d -o zidane -g zidane -m 0700 /var/lib/zidane-agent

USER zidane
VOLUME ["/var/lib/zidane-agent"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.mjs"]
