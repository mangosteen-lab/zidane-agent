# Zidane agent — a general-purpose build machine in a container.
#
#   docker run -d --name zidane-agent --restart unless-stopped \
#     -e ZIDANE_BACKEND_WSS_URL=wss://zidane.example.com:17001/ws/agent \
#     -e ZIDANE_BACKEND_API_KEY=zdn_... \
#     -e ZIDANE_AGENT_LABELS="os=linux,template=UBUNTU_2404" \
#     ghcr.io/mangosteen-lab/zidane-agent:latest
#
# One image, deliberately: the workflows this fleet runs are mixed-language, and a step
# that lands on an agent missing its toolchain fails at run time rather than at placement.
# Splitting into per-language images means labelling them accurately and keeping the
# selectors in step with reality — worth doing when the image gets big enough to hurt,
# not before.
#
# Layout matches a machine install exactly, so the same scripts and the same docs apply:
#   /opt/mangosteen/zidane-agent/versions/<v>/   the agent, one dir per version
#   /opt/mangosteen/zidane-agent/current -> versions/<v>
#   /opt/mangosteen/zidane-agent/conf/config.ini rendered from the environment at start
#   /opt/mangosteen/zidane-workspace             cwd for the container and for tasks
FROM ubuntu:24.04

LABEL org.opencontainers.image.source=https://github.com/mangosteen-lab/zidane-agent
LABEL org.opencontainers.image.description="Zidane agent on Ubuntu 24.04 with a general build toolchain"
LABEL org.opencontainers.image.licenses=MIT

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC

# Pinned so an image rebuild does not silently move a toolchain under the fleet.
ARG NODE_MAJOR=22
ARG GRADLE_VERSION=8.10.2
ARG GRADLE_SHA256=31c55713e40233a8303827ceb42ca48a47267a0ad4bab9177123121e71524c26

# --- base + toolchain -------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg git openssh-client rsync unzip zip tar gzip \
        jq make build-essential pkg-config \
        python3 python3-venv python3-pip python3-dev \
        openjdk-21-jdk-headless maven \
        tzdata locales procps sudo \
    && rm -rf /var/lib/apt/lists/*

# Node from NodeSource: Ubuntu's own package trails the LTS by too much to build with.
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g yarn pnpm \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# Gradle from the official distribution — apt's package lags several majors. Checksum
# verified: this is a binary the fleet will execute.
RUN curl -fsSL -o /tmp/gradle.zip \
        "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
    && echo "${GRADLE_SHA256}  /tmp/gradle.zip" | sha256sum -c - \
    && unzip -q /tmp/gradle.zip -d /opt \
    && ln -s "/opt/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle \
    && rm -f /tmp/gradle.zip

ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
ENV GRADLE_HOME=/opt/gradle-${GRADLE_VERSION}
ENV PATH="${JAVA_HOME}/bin:${GRADLE_HOME}/bin:${PATH}"

# --- the agent --------------------------------------------------------------
ARG INSTALL_ROOT=/opt/mangosteen/zidane-agent
ARG WORKSPACE=/opt/mangosteen/zidane-workspace
ENV ZIDANE_INSTALL_ROOT=${INSTALL_ROOT} \
    ZIDANE_WORKSPACE=${WORKSPACE}

# A fixed uid keeps bind-mounted state readable across image rolls. 1000 is taken by
# ubuntu:24.04's own `ubuntu` account, so use 1001.
RUN useradd --create-home --home-dir /home/zidane --shell /bin/bash --uid 1001 zidane \
    && mkdir -p "${INSTALL_ROOT}" "${WORKSPACE}"

COPY . /tmp/zidane-agent-src

# Installs from this checkout into the versioned tree, exactly as install.sh does on a
# machine. --no-service because there is no init in here; the entrypoint is pid 1.
RUN cd /tmp/zidane-agent-src \
    && bash scripts/install.sh \
         --install-root "${INSTALL_ROOT}" --user zidane --no-service \
         --url "ws://placeholder/ws/agent" --token "placeholder" \
    # The baked config carries placeholders; the entrypoint rewrites it from the real
    # environment on every start, so a stale token can never survive into a running agent.
    && rm -f "${INSTALL_ROOT}/conf/config.ini" \
    && cp scripts/upgrade.sh scripts/docker-entrypoint.sh /usr/local/bin/ \
    && chmod +x /usr/local/bin/upgrade.sh /usr/local/bin/docker-entrypoint.sh \
    && rm -rf /tmp/zidane-agent-src \
    && chown -R zidane:zidane "${INSTALL_ROOT}" "${WORKSPACE}"

USER zidane
WORKDIR ${WORKSPACE}

# Tasks run under the workspace, and the agent's own state lives with the install.
ENV ZIDANE_AGENT_WORKDIR_ROOT=${WORKSPACE} \
    ZIDANE_AGENT_STATE_DIR=${INSTALL_ROOT}/state \
    ZIDANE_AGENT_INSTALL_ROOT=${INSTALL_ROOT} \
    ZIDANE_LOGGING_FILE=${INSTALL_ROOT}/logs/agent.log \
    ZIDANE_AGENT_CAPACITY=4 \
    ZIDANE_AGENT_LABELS="os=linux,template=UBUNTU_2404" \
    # Pull the newest published agent on every start. 0 pins the version baked into the
    # image, which is what you want when the fleet must not move under you.
    ZIDANE_UPGRADE_ON_START=1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
