const POLICY = 'audit-detection-rebuild-v1';

export function authorityRootFromHomepageV1(homepagePath) {
  if (typeof homepagePath !== 'string' || !homepagePath.endsWith('/SKILL.md') || homepagePath.startsWith('/') || homepagePath.includes('..'))
    throw new TypeError('authority homepagePath must end with /SKILL.md and be repository-relative');
  return homepagePath.slice(0, -'/SKILL.md'.length);
}

export function detectionPolicyForAuthorityV1({repoRoot, authorityRoot, readJsonIfExists}) {
  if (typeof readJsonIfExists !== 'function') throw new TypeError('readJsonIfExists must be a function');
  if (typeof authorityRoot !== 'string' || !authorityRoot.length) throw new TypeError('authorityRoot required');
  const manifest = readJsonIfExists(authorityRoot.replace(/\\/g,'/') + '/MANIFEST.json', repoRoot);
  if (manifest && typeof manifest.then === 'function')
    return manifest.then(value => value?.detectionPolicy === POLICY ? POLICY : null);
  return manifest?.detectionPolicy === POLICY ? POLICY : null;
}
