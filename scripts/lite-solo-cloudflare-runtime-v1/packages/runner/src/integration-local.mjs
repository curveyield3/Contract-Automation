import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCompilerInput, compileProject } from './compiler.mjs';
import { startGanacheEngine } from './engine.mjs';
import { executeWorkflow } from './workflow.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const source = await fs.readFile(path.join(root, 'fixtures/contracts/VaultSystem.sol'), 'utf8');
const workflow = JSON.parse(await fs.readFile(path.join(root, 'fixtures/vault-workflow.json'), 'utf8'));
const compilation = await compileProject({
  sources: { 'VaultSystem.sol': source },
  compilerVersion: '0.8.30',
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: false }
});
const engine = await startGanacheEngine({
  artifacts: compilation.artifacts,
  workflow,
  chainId: 31337,
  forkUrl: undefined
});
try {
  const execution = await executeWorkflow(workflow, engine.runtime, { aliases: engine.aliases });
  if (execution.steps.some((step) => step.status !== 'completed')) throw new Error('Integration workflow contained failures');
  console.log(JSON.stringify({ status: 'completed', steps: execution.steps.length, deployments: execution.context.deployments }, null, 2));
} finally {
  await engine.close();
}
