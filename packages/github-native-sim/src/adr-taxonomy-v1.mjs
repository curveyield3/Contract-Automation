import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = 'curveyield-defect-taxonomy-v1';
const METHODS = new Set(['FOUNDRY_PERMISSION_MATRIX', 'FOUNDRY_PROPERTY', 'FOUNDRY_INVARIANT', 'MEDUSA_PROPERTY', 'ANVIL_STATE_CHECK', 'REVIEW_ONLY']);
const EXPECTED_COUNT = 18;

export function loadTaxonomyV1(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'protocol/taxonomy/curveyield-defect-taxonomy-v1.json'), 'utf8'));
}

export function validateTaxonomyV1(taxonomy) {
  const errors = [];
  const error = (code, path, message) => errors.push({code, path, message});
  if (!taxonomy || typeof taxonomy !== 'object' || Array.isArray(taxonomy)) {
    error('TAXONOMY_SCHEMA', '$', 'Taxonomy must be an object');
    return {ok:false, errors, value:null};
  }
  if (taxonomy.schemaVersion !== SCHEMA) error('TAXONOMY_SCHEMA', '$.schemaVersion', 'Unexpected taxonomy schema');
  if (!Array.isArray(taxonomy.classes) || taxonomy.classes.length !== EXPECTED_COUNT)
    error('TAXONOMY_SCHEMA', '$.classes', 'Exactly 18 classes required');
  if (!Array.isArray(taxonomy.triggerKeys) || taxonomy.triggerKeys.some(x => typeof x !== 'string') ||
    new Set(taxonomy.triggerKeys ?? []).size !== (taxonomy.triggerKeys ?? []).length ||
    JSON.stringify(taxonomy.triggerKeys) !== JSON.stringify([...(taxonomy.triggerKeys ?? [])].sort()))
    error('TAXONOMY_SCHEMA', '$.triggerKeys', 'Trigger keys must be unique sorted strings');
  const keys = new Set(Array.isArray(taxonomy.triggerKeys) ? taxonomy.triggerKeys : []);
  const used = new Set(), seen = new Set();
  for (const [i, cls] of (Array.isArray(taxonomy.classes) ? taxonomy.classes : []).entries()) {
    const p = '$.classes[' + i + ']';
    if (!cls || typeof cls !== 'object' || !/^[A-Z][A-Z0-9_]+$/.test(cls.classId ?? '') ||
      typeof cls.title !== 'string' || !cls.title ||
      !Array.isArray(cls.triggers) || cls.triggers.length === 0 ||
      !Array.isArray(cls.reviewChecks) || cls.reviewChecks.length === 0 ||
      cls.reviewChecks.some(x => typeof x !== 'string' || !x.trim()))
      error('TAXONOMY_SCHEMA', p, 'Class missing required fields or review checks');
    if (seen.has(cls?.classId)) error('TAXONOMY_DUPLICATE_CLASS', p + '.classId', 'Duplicate classId');
    seen.add(cls?.classId);
    if (!METHODS.has(cls?.testMethod) || typeof cls?.testRequired !== 'boolean' ||
      cls.testRequired !== (cls.testMethod !== 'REVIEW_ONLY'))
      error('TAXONOMY_BAD_TEST_METHOD', p + '.testMethod', 'Unrecognized or inconsistent method/testRequired');
    for (const trigger of (Array.isArray(cls?.triggers) ? cls.triggers : [])) {
      if (!keys.has(trigger)) error('TAXONOMY_UNKNOWN_TRIGGER', p + '.triggers', 'Undeclared trigger: ' + trigger);
      used.add(trigger);
    }
  }
  for (const key of keys) if (!used.has(key)) error('TAXONOMY_UNUSED_TRIGGER', '$.triggerKeys', 'Unused trigger: ' + key);
  return {ok:errors.length===0, errors, value:errors.length===0 ? taxonomy : null};
}

export function classesForTriggersV1(taxonomy, triggerKeys) {
  const selected = new Set(triggerKeys ?? []);
  const result = new Set();
  for (const cls of taxonomy.classes) {
    if (cls.triggers.some(trigger => selected.has(trigger))) result.add(cls.classId);
  }
  if (selected.has('STATE_WRITE') || selected.has('STATE_WRITE_EXTERNAL')) {
    result.add('ACCESS_CONTROL');
    result.add('STATE_MACHINE');
  }
  if (selected.has('ARITHMETIC_ON_STATE')) result.add('ACCOUNTING_MATH');
  return [...result].sort();
}
