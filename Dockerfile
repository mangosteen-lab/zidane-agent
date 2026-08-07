FROM python:3.12-slim

# Containers upgrade by rolling the image, never by the in-app upgrade button — the
# agent detects it is containerised and replies UPGRADE_SKIPPED.
WORKDIR /opt/zidane/zidane-agent
COPY pyproject.toml README.md ./
COPY app ./app

RUN pip install --no-cache-dir . && \
    useradd --system --create-home --home-dir /opt/zidane/zidane-agent \
            --shell /usr/sbin/nologin zidane && \
    mkdir -p state work logs conf && chown -R zidane /opt/zidane

USER zidane
ENV ZIDANE_MANAGED_BY_SERVICE=1 \
    ZIDANE_AGENT_STATE_DIR=/opt/zidane/zidane-agent/state \
    ZIDANE_AGENT_WORKDIR_ROOT=/opt/zidane/zidane-agent/work

# Configure entirely by environment: ZIDANE_BACKEND_WSS_URL, ZIDANE_BACKEND_API_KEY,
# ZIDANE_AGENT_LABELS, ZIDANE_AGENT_CAPACITY.
CMD ["python", "-m", "app.main", "--config", "/opt/zidane/zidane-agent/conf/config.ini"]
