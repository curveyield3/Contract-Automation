import fs from 'node:fs/promises';
import path from 'node:path';
import { executeBrowserOperation } from './browser-operations-v1.mjs';

function substitute(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, key) => String(vars[key] ?? ''));
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, vars)]));
  }
  return value;
}

export async function loadBrowserRoutine(routineId, { root = process.cwd() } = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(routineId || ''))) {
    throw new Error('Invalid browser routine id');
  }
  const file = path.join(root, 'process', 'browser-routines', routineId + '.json');
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  if (parsed.schemaVersion !== 'curveyield-browser-routine-v1') {
    throw new Error('Unsupported browser routine schema');
  }
  if (parsed.id !== routineId) throw new Error('Browser routine id mismatch');
  return parsed;
}

export async function runBrowserRoutineStage({ page, routine, stage, vars = {} }) {
  const steps = routine?.stages?.[stage] ?? [];
  if (!Array.isArray(steps)) throw new Error(`Browser routine stage ${stage} must be an array`);

  const results = [];
  for (const step of steps) {
    if (!step || typeof step.operation !== 'string') throw new Error('Browser routine step missing operation');
    const args = substitute(step.args ?? {}, vars);
    const result = await executeBrowserOperation({ page, name: step.operation, args });
    results.push({ operation: step.operation, result });
  }
  return results;
}
