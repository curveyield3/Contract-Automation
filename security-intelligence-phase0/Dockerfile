# Standalone, source-blind Phase 0 toolchain: constructed BEFORE accepting source ZIP.
# Runtime is --network none, read-only, capability-free and receives no credentials.
FROM node:22-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash ca-certificates git unzip python3 python3-pip python3-venv build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/slither && /opt/slither/bin/pip install --no-cache-dir 'slither-analyzer==0.11.6' 'vyper==0.4.3'
ENV PATH="/opt/slither/bin:/opt/preflight/node_modules/.bin:/opt/preflight/node_modules/@foundry-rs/forge:${PATH}" \
    CI="true" NODE_ENV="test" HOME="/tmp"
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
# Trusted, fixed-version library cache: fetched before the user-supplied ZIP exists.
# Runtime validates the archive's declared dependency versions before copying.
RUN mkdir -p /opt/preflight/trusted-source-deps && \
    npm install --prefix /opt/preflight/trusted-source-deps --ignore-scripts \
      --no-audit --no-fund --package-lock=false \
      '@openzeppelin/contracts@5.4.0' \
      '@openzeppelin/contracts-upgradeable@4.9.6' \
      '@openzeppelin-4/contracts@npm:@openzeppelin/contracts@4.9.6' \
      '@openzeppelin-5/contracts@npm:@openzeppelin/contracts@5.4.0' \
      '@uniswap/v4-core@1.0.2'
# Prepare two source-compatible native solc binaries while build networking is
# available. These are compilation-only toolchain probes, not contract tests.
RUN mkdir -p /tmp/security-preflight-solc/src && \
    printf 'pragma solidity 0.8.28; contract PreflightCompiler028 {}\n' > /tmp/security-preflight-solc/src/Compiler028.sol && \
    printf 'pragma solidity 0.8.30; contract PreflightCompiler030 {}\n' > /tmp/security-preflight-solc/src/Compiler030.sol && \
    forge build --root /tmp/security-preflight-solc --force && \
    mkdir -p /opt/preflight/solc-cache && \
    cp -R /root/.svm/. /opt/preflight/solc-cache/ && \
    chmod -R a+rX /opt/preflight/solc-cache
COPY security-intelligence-phase0/packages/ ./packages/
COPY security-intelligence-phase0/scripts/ ./scripts/
COPY security-intelligence-phase0/protocol/taxonomy/ ./protocol/taxonomy/
# Only trusted cloned tooling is embedded. The user ZIP enters a separate
# read-only bind mount after this image has been completely built.
