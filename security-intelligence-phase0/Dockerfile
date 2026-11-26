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
# Solidity <=0.8.28 uses a dynamically loaded Z3 library. The upstream 0.8.28 build tests Z3 4.12.1.
# Solidity >=0.8.29 uses the z3 executable; upstream 0.8.29/0.8.30 CI uses Z3 4.13.3.
# Keep both toolchain dependencies separate from the other scanners.
RUN python3 -m venv /opt/smtchecker-z3 && /opt/smtchecker-z3/bin/pip install --no-cache-dir --no-deps 'z3-solver==4.12.1.0' && \
    mkdir -p /opt/smtchecker-z3/solver-lib && \
    /opt/smtchecker-z3/bin/python -c "import pathlib,z3; p=pathlib.Path(z3.__file__).parent/'lib'/'libz3.so'; assert p.is_file(); d=pathlib.Path('/opt/smtchecker-z3/solver-lib'); (d/'libz3.so').symlink_to(p); (d/'libz3.so.4.12').symlink_to(p); assert z3.get_version_string() == '4.12.1'; print('SMTChecker shared library Z3 '+z3.get_version_string())"
# Exact upstream 0.8.30 CI release archive and SHA-256, from scripts/docker/buildpack-deps/Dockerfile.ubuntu2204.
RUN mkdir -p /opt/smtchecker-z3-cli/bin && \
    python3 -c "import urllib.request,hashlib,zipfile,pathlib; url='https://github.com/Z3Prover/z3/releases/download/z3-4.13.3/z3-4.13.3-x64-glibc-2.35.zip'; p=pathlib.Path('/tmp/smtchecker-z3-cli.zip'); urllib.request.urlretrieve(url,p); assert hashlib.sha256(p.read_bytes()).hexdigest()=='32c7377026733c9d7b33c21cd77a68f50ba682367207b031a6bfd80140a8722f'; target=pathlib.Path('/opt/smtchecker-z3-cli/bin/z3'); target.write_bytes(zipfile.ZipFile(p).read('z3-4.13.3-x64-glibc-2.35/bin/z3')); target.chmod(0o755); p.unlink()" && \
    /opt/smtchecker-z3-cli/bin/z3 --version | grep -F 'Z3 version 4.13.3'
ENV PATH="/usr/local/bin:/opt/slither/bin:/opt/wake/bin:/opt/mythril/bin:/opt/semgrep/bin:/opt/preflight/node_modules/.bin:/opt/preflight/node_modules/@foundry-rs/forge:${PATH}" \
    CI="true" NODE_ENV="test" HOME="/opt/preflight"
RUN if command -v z3 >/dev/null 2>&1; then echo "Unqualified scanner PATH Z3: $(command -v z3)"; z3 --version; else echo 'Unqualified scanner PATH Z3: absent'; fi
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
