# Standalone, source-blind Phase 0 toolchain: constructed BEFORE accepting source ZIP.
# Runtime is --network none, read-only, capability-free and receives no credentials.
FROM node:22-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash ca-certificates git unzip python3 python3-pip python3-venv build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/slither && /opt/slither/bin/pip install --no-cache-dir 'slither-analyzer==0.11.6'
RUN python3 -m venv /opt/wake && /opt/wake/bin/pip install --no-cache-dir 'eth-wake==4.21.0'
ENV PATH="/usr/local/bin:/opt/slither/bin:/opt/wake/bin:/opt/preflight/node_modules/.bin:/opt/preflight/node_modules/@foundry-rs/forge:${PATH}" \
    CI="true" NODE_ENV="test" HOME="/opt/preflight" XDG_DATA_HOME="/opt/preflight/.local/share"
WORKDIR /opt/preflight
COPY security-intelligence-phase0/package.json security-intelligence-phase0/package-lock.json ./
COPY security-intelligence-phase0/packages/runner/package.json ./packages/runner/package.json
COPY security-intelligence-phase0/packages/protocol/package.json ./packages/protocol/package.json
RUN npm ci --force --no-audit --no-fund
RUN test -f node_modules/@foundry-rs/forge/bin.mjs && \
    test -f node_modules/@foundry-rs/cast/bin.mjs && \
    chmod +x node_modules/@foundry-rs/forge/bin.mjs node_modules/@foundry-rs/cast/bin.mjs && \
    ln -s /opt/preflight/node_modules/@foundry-rs/forge/bin.mjs /usr/local/bin/forge && \
    ln -s /opt/preflight/node_modules/@foundry-rs/cast/bin.mjs /usr/local/bin/cast
# The archive admission job extracts a bounded, non-executable toolchain plan.
# The plan, never the actual source ZIP, enters this trusted build job.
COPY .preflight-plan/ ./toolchain-plan/
COPY security-intelligence-phase0/scripts/ ./scripts/
RUN node ./scripts/install-source-toolchain-v1.mjs \
    /opt/preflight/toolchain-plan /opt/preflight/prepared-packages
RUN if [ -d /opt/preflight/.svm ]; then chmod -R a+rX /opt/preflight/.svm; fi && \
    if [ -d /opt/preflight/vyper-envs ]; then chmod -R a+rX /opt/preflight/vyper-envs; fi
RUN cp scripts/preflight-vyper-wrapper-v1.sh /usr/local/bin/vyper && chmod 755 /usr/local/bin/vyper
COPY security-intelligence-phase0/packages/ ./packages/
COPY security-intelligence-phase0/protocol/taxonomy/ ./protocol/taxonomy/
# Only trusted cloned tooling is embedded. The user ZIP enters a separate
# read-only bind mount after this image has been completely built.
