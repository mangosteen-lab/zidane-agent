FROM ubuntu:24.04

LABEL org.opencontainers.image.description="Zidane Pi coding agent"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    ZIDANE_AGENT_WORKING_DIRECTORY=/var/lib/zidane-agent

# Where a skill looks for the agent's config maps. A separate ENV so the path derives
# from the working directory above rather than repeating it: substitution within one ENV
# instruction only sees values set before that instruction. The agent re-asserts it at
# startup, so overriding ZIDANE_AGENT_WORKING_DIRECTORY at run time still resolves
# correctly for the agent and everything it spawns; this is what `docker exec` sees.
ENV AI_AGENT_CONFIG_MAPS_FOLDER=${ZIDANE_AGENT_WORKING_DIRECTORY}/config-maps

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl fd-find git jq openssh-client python3 ripgrep tini \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

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
