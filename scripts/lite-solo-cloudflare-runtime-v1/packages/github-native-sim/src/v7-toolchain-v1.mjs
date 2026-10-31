import { runProcess } from './execution.mjs';
import { V7_POLICY } from './v7-policy.mjs';

export const V7_TOOLCHAIN = Object.freeze({
  slither: Object.freeze({ command: 'slither', version: V7_POLICY.tools.slither }),
  medusa: Object.freeze({ command: 'medusa', version: V7_POLICY.tools.medusa }),
  forge: Object.freeze({ command: 'forge', version: V7_POLICY.tools.forge }),
});

export function toolOutputMatchesVersion(text, expected) {
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^0-9])${escaped}(?:[^0-9]|$)`).test(String(text ?? ''));
}

async function verifyOne(name, spec, runCommand) {
  let result;
  try {
    result = await runCommand({ command: spec.command, args: ['--version'], cwd: process.cwd() });
  } catch (error) {
    return {
      name,
      command: spec.command,
      expectedVersion: spec.version,
      status: 'FAIL',
      failureKind: 'TOOL_UNAVAILABLE',
      exitCode: -1,
      observedVersionOutput: '',
      reason: error?.message ?? String(error),
    };
  }

  const stdout = String(result?.stdout ?? '');
  const stderr = String(result?.stderr ?? '');
  const output = `${stdout}\n${stderr}`.trim();
  if (!result || result.exitCode !== 0) {
    return {
      name,
      command: spec.command,
      expectedVersion: spec.version,
      status: 'FAIL',
      failureKind: 'TOOL_UNAVAILABLE',
      exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : -1,
      observedVersionOutput: output,
    };
  }
  if (!toolOutputMatchesVersion(output, spec.version)) {
    return {
      name,
      command: spec.command,
      expectedVersion: spec.version,
      status: 'FAIL',
      failureKind: 'TOOL_VERSION_MISMATCH',
      exitCode: result.exitCode,
      observedVersionOutput: output,
    };
  }
  return {
    name,
    command: spec.command,
    expectedVersion: spec.version,
    status: 'PASS',
    failureKind: null,
    exitCode: result.exitCode,
    observedVersionOutput: output,
  };
}

export async function verifyV7Toolchain({ runCommand = runProcess } = {}) {
  const tools = {};
  for (const [name, spec] of Object.entries(V7_TOOLCHAIN)) {
    tools[name] = await verifyOne(name, spec, runCommand);
  }
  const status = Object.values(tools).every((tool) => tool.status === 'PASS') ? 'PASS' : 'FAIL';
  return {
    schemaVersion: 'curveyield-v7-toolchain-verification-v1',
    status,
    tools,
  };
}
