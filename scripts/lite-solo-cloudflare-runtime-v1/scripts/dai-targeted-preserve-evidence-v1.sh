#!/usr/bin/env bash
set -euo pipefail
dest="process/dai-master-targeted-tests/evidence/run-${GITHUB_RUN_ID}"
mkdir -p "$dest"
if [ "${DAI_TEST_ROUND:-1}" = "2" ]; then
  cp -a dai-historical-raw "$dest/raw"
else
  cp -a dai-targeted-raw "$dest/raw"
fi
cp TARGETED_RESULT_v1.json "$dest/TARGETED_RESULT_v1.json"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add "$dest"
git commit -m "test(dai): preserve raw evidence for execution ${GITHUB_RUN_ID}"
for attempt in 1 2 3 4; do
  git fetch origin main
  git rebase origin/main
  if git push origin HEAD:main; then
    echo "Evidence committed after attempt $attempt"
    exit 0
  fi
  sleep "$attempt"
done
echo "::error::Evidence retention push failed after four rebases" >&2
exit 1
