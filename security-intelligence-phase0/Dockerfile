# Standalone, source-blind Phase 0 toolchain: constructed BEFORE accepting source ZIP.
# Runtime is --network none, read-only, capability-free and receives no credentials.
FROM node:22-bookworm-slim AS phase0-scanner-tools
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash ca-certificates git unzip python3 python3-dev python3-pip python3-venv build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/slither && /opt/slither/bin/pip install --no-cache-dir 'slither-analyzer==0.11.6'
RUN python3 -m venv /opt/wake && /opt/wake/bin/pip install --no-cache-dir 'eth-wake==4.21.0'
RUN python3 -m venv /opt/mythril && /opt/mythril/bin/pip install --no-cache-dir 'mythril==0.24.8' 'zope.interface==6.4.post2' 'zope.deferredimport==5.0' 'zope.proxy==5.2'
# Pinned defensive source scanner and immutable trusted rules, built before any source ZIP enters the image.
RUN python3 -m venv /opt/semgrep && /opt/semgrep/bin/pip install --no-cache-dir 'semgrep==1.187.0'
RUN git init /opt/semgrep-rules && \
    git -C /opt/semgrep-rules fetch --depth 1 https://github.com/Decurity/semgrep-smart-contracts.git 2e878a89ac7bba1f8435e8a68e3ecb7700096cd5 && \
    git -C /opt/semgrep-rules checkout --detach FETCH_HEAD && \
    test "$(git -C /opt/semgrep-rules rev-parse HEAD)" = "2e878a89ac7bba1f8435e8a68e3ecb7700096cd5" && \
    test -d /opt/semgrep-rules/solidity/security && rm -rf /opt/semgrep-rules/.git
ENV PATH="/usr/local/bin:/opt/slither/bin:/opt/wake/bin:/opt/mythril/bin:/opt/semgrep/bin:/opt/preflight/node_modules/.bin:/opt/preflight/node_modules/@foundry-rs/forge:${PATH}" \
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
# Official Emscripten compiler distributions contain Z3; no system solver is installed.
RUN mkdir -p /opt/preflight/smt-wasm && \
    python3 -c "import hashlib,pathlib,urllib.request; root=pathlib.Path('/opt/preflight/smt-wasm'); releases=[('0.8.28','7893614a','72ef580a6ec5943130028e5294313f24e9435520acc89f8c9dbfd0139d9ae146'),('0.8.30','73712a01','81475c98b6d2094a821fd9d7b6278556d8095ccc23e0b8a1029b1c08a89cd4b2')]; [(lambda data: (hashlib.sha256(data).hexdigest()==digest or (_ for _ in ()).throw(ValueError('Official soljson SHA256 mismatch: '+version)), (root/(version+'.cjs')).write_bytes(data)))(urllib.request.urlopen('https://binaries.soliditylang.org/wasm/soljson-v'+version+'+commit.'+commit+'.js',timeout=60).read()) for version,commit,digest in releases]"
# Source-independent Slither, Wake, Mythril, Semgrep, Foundry and Node layers end here.
# Only this target is exported to persistent GitHub cache; no per-source plan
# or authenticated ZIP ever enters the reusable cache.
FROM phase0-scanner-tools
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
