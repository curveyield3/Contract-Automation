export const MAX_INLINE_BYTES = 2 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
export const MAX_STEPS = 200;

export const CHAINS = Object.freeze({
  ethereum: { chainId: 1, rpcEnv: 'RPC_ETHEREUM' },
  base: { chainId: 8453, rpcEnv: 'RPC_BASE' },
  katana: { chainId: 747474, rpcEnv: 'RPC_KATANA' },
  fraxtal: { chainId: 252, rpcEnv: 'RPC_FRAXTAL' },
  arbitrum: { chainId: 42161, rpcEnv: 'RPC_ARBITRUM' },
  polygon: { chainId: 137, rpcEnv: 'RPC_POLYGON' },
  optimism: { chainId: 10, rpcEnv: 'RPC_OPTIMISM' }
});

export const ACTIONS = Object.freeze(new Set([
  'deploy',
  'call',
  'staticCall',
  'expectRevert',
  'setBalance',
  'transferNative',
  'mine',
  'increaseTime',
  'snapshot',
  'revertSnapshot',
  'assertBalance',
  'assertCall'
]));

const FORBIDDEN_KEYS = new Set([
  'privateKey', 'privateKeys', 'mnemonic', 'seed', 'secret', 'signer',
  'rpcUrl', 'rpc', 'rawTransaction', 'signedTransaction', 'shell', 'command',
  'script', 'npmScript', 'broadcast'
]);

const TOP_LEVEL_KEYS = new Set([
  'mode', 'project', 'compilerVersion', 'openZeppelinVersion', 'chain', 'block',
  'timeoutMinutes', 'workflow', 'optimizer', 'evmVersion', 'viaIR'
]);

const COMMON_STEP_KEYS = new Set(['action', 'label', 'continueOnFailure']);
const STEP_KEYS = Object.freeze({
  deploy: new Set([...COMMON_STEP_KEYS, 'alias', 'contract', 'source', 'args', 'from', 'value']),
  call: new Set([...COMMON_STEP_KEYS, 'target', 'function', 'args', 'from', 'value', 'saveAs']),
  staticCall: new Set([...COMMON_STEP_KEYS, 'target', 'function', 'args', 'from', 'saveAs']),
  expectRevert: new Set([...COMMON_STEP_KEYS, 'target', 'function', 'args', 'from', 'value', 'reason']),
  setBalance: new Set([...COMMON_STEP_KEYS, 'account', 'amount']),
  transferNative: new Set([...COMMON_STEP_KEYS, 'from', 'to', 'amount']),
  mine: new Set([...COMMON_STEP_KEYS, 'blocks']),
  increaseTime: new Set([...COMMON_STEP_KEYS, 'seconds']),
  snapshot: new Set([...COMMON_STEP_KEYS, 'alias']),
  revertSnapshot: new Set([...COMMON_STEP_KEYS, 'snapshot']),
  assertBalance: new Set([...COMMON_STEP_KEYS, 'account', 'equals', 'min', 'max']),
  assertCall: new Set([...COMMON_STEP_KEYS, 'target', 'function', 'args', 'from', 'equals'])
});

export class ValidationError extends Error {
  constructor(code, message, path = '$') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.path = path;
  }
}

function assertPlainObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('invalid_type', `${path} must be an object`, path);
  }
}

function scanForbidden(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbidden(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ValidationError('forbidden_field', `${path}.${key} is forbidden`, `${path}.${key}`);
    }
    scanForbidden(child, `${path}.${key}`);
  }
}

function rejectUnknownKeys(object, allowed, path) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new ValidationError('unknown_field', `${path}.${key} is not allowed`, `${path}.${key}`);
    }
  }
}

function requireString(value, path, { min = 1, max = 4096 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new ValidationError('invalid_string', `${path} must be a string between ${min} and ${max} characters`, path);
  }
  return value;
}

function optionalExactVersion(value, path) {
  if (value === undefined) return undefined;
  requireString(value, path, { max: 32 });
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new ValidationError('invalid_compiler_version', `${path} must be an exact semantic version`, path);
  }
  return value;
}

function validatePath(path) {
  requireString(path, 'project.files path', { max: 512 });
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.includes('../') || normalized === '..' || normalized.includes('/./')) {
    throw new ValidationError('invalid_path', `Unsafe project path: ${path}`, `project.files.${path}`);
  }
  if (!normalized.endsWith('.sol')) {
    throw new ValidationError('invalid_path', `Only .sol files are accepted inline: ${path}`, `project.files.${path}`);
  }
  return normalized;
}

export function validateProject(project) {
  assertPlainObject(project, '$.project');
  scanForbidden(project, '$.project');
  if (!['inline', 'github', 'upload'].includes(project.type)) {
    throw new ValidationError('invalid_project_type', 'project.type must be inline, github, or upload', '$.project.type');
  }

  if (project.type === 'inline') {
    rejectUnknownKeys(project, new Set(['type', 'files']), '$.project');
    assertPlainObject(project.files, '$.project.files');
    const normalizedFiles = {};
    let bytes = 0;
    for (const [path, source] of Object.entries(project.files)) {
      const safePath = validatePath(path);
      requireString(source, `$.project.files.${path}`, { max: MAX_INLINE_BYTES });
      bytes += new TextEncoder().encode(source).byteLength;
      normalizedFiles[safePath] = source;
    }
    if (Object.keys(normalizedFiles).length === 0) {
      throw new ValidationError('empty_project', 'At least one Solidity file is required', '$.project.files');
    }
    if (bytes > MAX_INLINE_BYTES) {
      throw new ValidationError('project_too_large', `Inline project exceeds ${MAX_INLINE_BYTES} bytes`, '$.project.files');
    }
    return { type: 'inline', files: normalizedFiles };
  }

  if (project.type === 'github') {
    rejectUnknownKeys(project, new Set(['type', 'repository', 'ref']), '$.project');
    const repository = requireString(project.repository, '$.project.repository', { max: 200 });
    const match = repository.match(/^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
    if (!match) {
      throw new ValidationError('invalid_repository', 'Only public GitHub owner/repository values are accepted', '$.project.repository');
    }
    const ref = project.ref === undefined ? 'main' : requireString(project.ref, '$.project.ref', { max: 200 });
    if (!/^[A-Za-z0-9._\/-]+$/.test(ref) || ref.includes('..')) {
      throw new ValidationError('invalid_ref', 'GitHub ref contains unsafe characters', '$.project.ref');
    }
    return { type: 'github', repository: `${match[1]}/${match[2]}`, ref };
  }

  rejectUnknownKeys(project, new Set(['type', 'objectKey']), '$.project');
  const objectKey = requireString(project.objectKey, '$.project.objectKey', { max: 512 });
  if (!/^uploads\/[A-Za-z0-9_-]+\/project\.zip$/.test(objectKey)) {
    throw new ValidationError('invalid_object_key', 'Upload object key is invalid', '$.project.objectKey');
  }
  return { type: 'upload', objectKey };
}

function validateBlock(block) {
  if (block === undefined || block === 'latest') return 'latest';
  if (Number.isSafeInteger(block) && block >= 0) return block;
  throw new ValidationError('invalid_block', 'block must be latest or a non-negative integer', '$.block');
}

function validateStep(step, index) {
  const path = `$.workflow.steps[${index}]`;
  assertPlainObject(step, path);
  scanForbidden(step, path);
  const action = requireString(step.action, `${path}.action`, { max: 40 });
  if (!ACTIONS.has(action)) {
    throw new ValidationError('unsupported_action', `Unsupported action: ${action}`, `${path}.action`);
  }
  rejectUnknownKeys(step, STEP_KEYS[action], path);

  const normalized = { ...step, action };
  if ('args' in normalized && !Array.isArray(normalized.args)) {
    throw new ValidationError('invalid_args', `${path}.args must be an array`, `${path}.args`);
  }
  if ('alias' in normalized) requireString(normalized.alias, `${path}.alias`, { max: 80 });
  if ('contract' in normalized) requireString(normalized.contract, `${path}.contract`, { max: 160 });
  if ('target' in normalized) requireString(normalized.target, `${path}.target`, { max: 160 });
  if ('function' in normalized) requireString(normalized.function, `${path}.function`, { max: 512 });
  if ('from' in normalized) requireString(normalized.from, `${path}.from`, { max: 160 });
  if ('account' in normalized) requireString(normalized.account, `${path}.account`, { max: 160 });
  if ('to' in normalized) requireString(normalized.to, `${path}.to`, { max: 160 });
  if ('amount' in normalized) requireString(String(normalized.amount), `${path}.amount`, { max: 100 });
  if (action === 'deploy' && !normalized.alias) {
    throw new ValidationError('missing_field', `${path}.alias is required`, `${path}.alias`);
  }
  if (['deploy'].includes(action) && !normalized.contract) {
    throw new ValidationError('missing_field', `${path}.contract is required`, `${path}.contract`);
  }
  if (['call', 'staticCall', 'expectRevert', 'assertCall'].includes(action)) {
    if (!normalized.target || !normalized.function) {
      throw new ValidationError('missing_field', `${path}.target and function are required`, path);
    }
  }
  return normalized;
}

export function validateWorkflow(workflow, { allowEmpty = false } = {}) {
  assertPlainObject(workflow, '$.workflow');
  rejectUnknownKeys(workflow, new Set(['steps']), '$.workflow');
  const minimum = allowEmpty ? 0 : 1;
  if (!Array.isArray(workflow.steps) || workflow.steps.length < minimum || workflow.steps.length > MAX_STEPS) {
    throw new ValidationError('invalid_steps', `workflow.steps must contain ${minimum}-${MAX_STEPS} steps`, '$.workflow.steps');
  }
  return { steps: workflow.steps.map(validateStep) };
}

export function validateCreateJobRequest(input) {
  assertPlainObject(input, '$');
  scanForbidden(input);
  rejectUnknownKeys(input, TOP_LEVEL_KEYS, '$');
  const mode = input.mode === undefined ? 'simulate' : requireString(input.mode, '$.mode', { max: 16 });
  if (!['compile', 'simulate'].includes(mode)) {
    throw new ValidationError('invalid_mode', 'mode must be compile or simulate', '$.mode');
  }
  let chain;
  if (mode === 'simulate') {
    chain = requireString(input.chain, '$.chain', { max: 32 });
    if (!(chain in CHAINS)) {
      throw new ValidationError('unsupported_chain', `Unsupported chain: ${chain}`, '$.chain');
    }
  } else if (input.chain !== undefined) {
    chain = requireString(input.chain, '$.chain', { max: 32 });
    if (!(chain in CHAINS)) {
      throw new ValidationError('unsupported_chain', `Unsupported chain: ${chain}`, '$.chain');
    }
  }
  const compilerVersion = optionalExactVersion(input.compilerVersion, '$.compilerVersion');
  if (!compilerVersion) {
    throw new ValidationError('missing_field', 'compilerVersion is required in Lite v1', '$.compilerVersion');
  }
  const timeoutMinutes = input.timeoutMinutes === undefined ? 10 : input.timeoutMinutes;
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 35) {
    throw new ValidationError('invalid_timeout', 'timeoutMinutes must be an integer from 1 to 35', '$.timeoutMinutes');
  }
  const optimizer = input.optimizer === undefined
    ? { enabled: true, runs: 200 }
    : input.optimizer;
  assertPlainObject(optimizer, '$.optimizer');
  rejectUnknownKeys(optimizer, new Set(['enabled', 'runs']), '$.optimizer');
  if (typeof optimizer.enabled !== 'boolean' || !Number.isInteger(optimizer.runs) || optimizer.runs < 0 || optimizer.runs > 1000000) {
    throw new ValidationError('invalid_optimizer', 'optimizer requires boolean enabled and runs from 0 to 1,000,000', '$.optimizer');
  }

  const workflowInput = input.workflow ?? { steps: [] };
  return {
    mode,
    project: validateProject(input.project),
    compilerVersion,
    openZeppelinVersion: optionalExactVersion(input.openZeppelinVersion, '$.openZeppelinVersion'),
    chain,
    block: validateBlock(input.block),
    timeoutMinutes,
    workflow: validateWorkflow(workflowInput, { allowEmpty: mode === 'compile' }),
    optimizer,
    evmVersion: input.evmVersion === undefined ? undefined : requireString(input.evmVersion, '$.evmVersion', { max: 40 }),
    viaIR: input.viaIR === undefined
      ? false
      : typeof input.viaIR === 'boolean'
        ? input.viaIR
        : (() => { throw new ValidationError('invalid_via_ir', 'viaIR must be a boolean', '$.viaIR'); })()
  };
}

export function validateJobResult(result) {
  assertPlainObject(result, '$');
  if (!['completed', 'failed'].includes(result.status)) {
    throw new ValidationError('invalid_result', 'result.status must be completed or failed', '$.status');
  }
  if (typeof result.jobId !== 'string' || typeof result.startedAt !== 'string' || typeof result.finishedAt !== 'string') {
    throw new ValidationError('invalid_result', 'result requires jobId, startedAt, and finishedAt strings', '$');
  }
  if (!Array.isArray(result.steps) || !Array.isArray(result.compilerDiagnostics)) {
    throw new ValidationError('invalid_result', 'result requires steps and compilerDiagnostics arrays', '$');
  }
  return result;
}
