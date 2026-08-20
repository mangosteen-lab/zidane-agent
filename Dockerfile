FROM ubuntu:24.04

LABEL org.opencontainers.image.description="Zidane Pi coding agent"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    ZIDANE_AGENT_WORKING_DIRECTORY=/var/lib/zidane-agent

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
