#!/usr/bin/env bash
set -euo pipefail
# Branch-scoped v34 Ethereum source and compiler setup; the existing v13 path below is untouched.
if [[ "${GITHUB_REF_NAME:-}" == "boosthub-v34-ethereum-fork-sim" ]]; then
  ROOT="$GITHUB_WORKSPACE/.boosthub-v34-full"
  SOURCE="github-native-sim/boosthub-v13-full-stack-v1/source/BoostHub_v34_sim_source_v1.tar.xz.b64"
  mkdir -p "$ROOT"
  tr -d '\r\n' < "$SOURCE" | base64 --decode > "$RUNNER_TEMP/boosthub-v34-source.tar.xz"
  echo '4c371a44aab88dab46e899bb03c98f76517e67db685cf803df84e10e6b18fa00  '"$RUNNER_TEMP/boosthub-v34-source.tar.xz" | sha256sum -c -
  tar -xJf "$RUNNER_TEMP/boosthub-v34-source.tar.xz" -C "$ROOT"
  echo '[v34] Installing exact dependencies from package source'
  npm install --prefix "$ROOT/dependencies" --no-package-lock --no-audit --no-fund --ignore-scripts
  python3 -m pip install --disable-pip-version-check --no-input vyper==0.4.3
  python3 "$ROOT/tooling/make_staking_artifact.py" 2>&1 | tee boosthub-v34-vyper-compile-v1.log
  echo '[v34] Compiling exact Ethereum deployment source'
  forge build --root "$ROOT" 2>&1 | tee boosthub-v34-solidity-compile-v1.log
  mkdir -p "$RUNNER_TEMP/boosthub-v34-js"
  npm install --prefix "$RUNNER_TEMP/boosthub-v34-js" --no-save --no-package-lock --no-audit --no-fund --ignore-scripts ethers@6.15.0
  exit 0
fi
ROOT="$GITHUB_WORKSPACE/.boosthub-v13-full"
SRC=github-native-sim/boosthub-v13-full-stack-v1/source/BoostHub_v13_fork_build_source_v1.tar.xz
echo '8dbb709fe785b276b388e17c78d57cac36038381bc80b3abb290b99d83cc9474  '${SRC} | sha256sum -c -
mkdir -p "$ROOT"
tar -xJf "$SRC" -C "$ROOT"
python3 github-native-sim/boosthub-v13-full-stack-v1/validate_source_v1.py "$ROOT"
# Code-size qualification overlay: exact four converter sources and their associated tests.
OVERLAY=github-native-sim/boosthub-v13-full-stack-v1/source/BoostHub_v13_helper_overlay_v1.tar.xz
echo 'a73da8645241de4ddef52cf3ef9be1392139cf616bec7104b37d871f5fc0ec0c  '${OVERLAY} | sha256sum -c -
tar -xJf "$OVERLAY" -C "$ROOT"
rm -f "$ROOT/beefy/contracts/converter/BoostHubDexTwapRoutes_v1.sol" "$ROOT/beefy/contracts/converter/BoostHubEthereumRewardConverter_v8.sol" "$ROOT/beefy/contracts/converter/BoostHubFraxtalRewardConverter_v2.sol"
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys,hashlib,json
root=Path(sys.argv[1])
manifest=root/'package_manifest_v13.json'
data=json.loads(manifest.read_text())
for name in list(data['sha256']):
    if name.startswith('beefy/contracts/converter/') or name=='beefy/tests/BoostHubMultiOracleRoutes_v1.t.sol':
        del data['sha256'][name]
for p in (root/'beefy/contracts/converter').glob('*.sol'):
    data['sha256'][p.relative_to(root).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
p=root/'beefy/tests/BoostHubMultiOracleRoutes_v1.t.sol'
data['sha256'][p.relative_to(root).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
manifest.write_text(json.dumps(data,indent=2)+'\n')
PY
mkdir -p "$ROOT/lib"
git clone -q --depth 1 --branch v4.9.6 https://github.com/OpenZeppelin/openzeppelin-contracts.git "$ROOT/lib/openzeppelin-4"
git clone -q --depth 1 --branch v5.4.0 https://github.com/OpenZeppelin/openzeppelin-contracts.git "$ROOT/lib/openzeppelin-5"
mkdir -p "$ROOT/ci-src"
cp -a "$ROOT/beefy/contracts/beefy" "$ROOT/ci-src/beefy"
cp -a "$ROOT/beefy/contracts/converter" "$ROOT/ci-src/converter"
cat > "$ROOT/foundry.toml" <<'EOF'
[profile.default]
src = "ci-src"
test = "unused-tests"
script = "unused-scripts"
out = "out"
libs = ["lib"]
solc_version = "0.8.28"
optimizer = true
optimizer_runs = 1
via_ir = true
remappings = [
  "@openzeppelin-4/contracts/=lib/openzeppelin-4/contracts/",
  "@openzeppelin/contracts/=lib/openzeppelin-5/contracts/"
]
EOF
forge build --root "$ROOT" 2>&1 | tee boosthub-v13-solidity-compile-v1.log
python3 -m pip install --disable-pip-version-check --no-input 'vyper==0.4.3'
python3 github-native-sim/boosthub-v13-full-stack-v1/build_vyper_v1.py "$ROOT" 2>&1 | tee boosthub-v13-vyper-compile-v1.log
python3 "$ROOT/deployment/Import_Build_Artifacts_v5.py" \
 --staking "$ROOT/build_v1/BoostHubStaking_v22.json" \
 --strategy "$ROOT/out/StrategyConvexBoostHubStakingV5.sol/StrategyConvexBoostHubStakingV5.json" \
 --vault "$ROOT/out/BeefyVaultV7FixedV2.sol/BeefyVaultV7FixedV2.json" \
 --converter "$ROOT/out/BoostHubEthereumRewardConverter_v9.sol/BoostHubEthereumRewardConverter.json" \
 --fraxtalConverter "$ROOT/out/BoostHubFraxtalRewardConverter_v3.sol/BoostHubFraxtalRewardConverter.json" \
 2>&1 | tee boosthub-v13-artifact-import-v1.log
cd "$ROOT"
npm install --no-save --no-audit --no-fund --ignore-scripts ethers@6.15.0
node --check deployment/deploy_runner_v10.mjs
