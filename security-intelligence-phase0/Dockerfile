# Standalone, source-blind Phase 0 toolchain: constructed BEFORE accepting source ZIP.
# Runtime is --network none, read-only, capability-free and receives no credentials.
FROM node:22-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash ca-certificates git unzip python3 python3-pip python3-venv build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/slither && /opt/slither/bin/pip install --no-cache-dir 'slither-analyzer==0.11.6'
ENV PATH="/opt/slither/bin:/opt/preflight/node_modules/.bin:/opt/preflight/node_modules/@foundry-rs/forge:${PATH}" \
    CI="true" NODE_ENV="test" HOME="/tmp"
WORKDIR /opt/preflight
COPY security-intelligence-phase0/package.json security-intelligence-phase0/package-lock.json ./
COPY security-intelligence-phase0/packages/runner/package.json ./packages/runner/package.json
COPY security-intelligence-phase0/packages/protocol/package.json ./packages/protocol/package.json
RUN npm ci --force --no-audit --no-fund
COPY security-intelligence-phase0/packages/ ./packages/
COPY security-intelligence-phase0/scripts/ ./scripts/
# Only trusted cloned tooling is embedded. The user ZIP enters a separate
# read-only bind mount after this image has been completely built.
