#!/usr/bin/env bash
set -euo pipefail
dest="process/dai-master-targeted-tests/evidence/run-${GITHUB_RUN_ID}"
mkdir -p "$dest"
cp -a dai-targeted-raw "$dest/raw"
cp TARGETED_RESULT_v1.json "$dest/TARGETED_RESULT_v1.json"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add "$dest"
git commit -m "test(dai): preserve raw evidence for execution ${GITHUB_RUN_ID}"
git push origin HEAD:main
