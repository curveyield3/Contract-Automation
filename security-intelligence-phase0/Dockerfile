# Standalone, source-blind Phase 0 toolchain: constructed BEFORE accepting source ZIP.
# Runtime is --network none, read-only, capability-free and receives no credentials.
FROM node:22-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash ca-certificates git unzip python3 python3-pip python3-venv build-essential openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/slither && /opt/slither/bin/pip install --no-cache-dir 'slither-analyzer==0.11.6'
# EVMLiSA is source-language agnostic: analyze the already compiled Vyper
# runtime bytecode. Install at pinned public upstream commit while image build
# still has network and before the untrusted archive is downloaded.
# This builds a production analyzer jar only; no source/test suites execute.
RUN git clone --quiet https://github.com/lisa-analyzer/evm-lisa.git /opt/evm-lisa-src && \
    cd /opt/evm-lisa-src && \
    git checkout --quiet 44ae6dde995c9fb8f4a94932d26d07b11066525f && \
    test "$(git rev-parse HEAD)" = "44ae6dde995c9fb8f4a94932d26d07b11066525f" && \
    chmod +x ./gradlew && \
    ./gradlew --no-daemon --console=plain shadowJar -x test -x check && \
    test -s build/libs/evm-lisa-all.jar && \
    mkdir -p /opt/evm-lisa && \
    cp build/libs/evm-lisa-all.jar /opt/evm-lisa/evm-lisa-all.jar && \
    cd / && rm -rf /opt/evm-lisa-src
ENV PATH="/usr/local/bin:/opt/slither/bin:/opt/preflight/node_modules/.bin:/opt/preflight/node_modules/@foundry-rs/forge:${PATH}" \
    CI="true" NODE_ENV="test" HOME="/opt/preflight"
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
