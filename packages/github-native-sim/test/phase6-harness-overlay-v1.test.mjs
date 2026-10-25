import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { materializePhase6HarnessOverlayV1 } from '../src/phase6-harness-overlay-v1.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase6-overlay-'));
  const runnerRoot = path.join(root, 'runner');
  const projectRoot = path.join(root, 'project');
  const bundleRoot = path.join(runnerRoot, 'packages/github-native-sim/audit-harnesses/cyvlsdt-v30-phase6-v1');
  await fs.mkdir(bundleRoot, { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'contracts'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'contracts/Production.sol'), 'contract Production {}\n');
  await fs.writeFile(path.join(bundleRoot, 'medusa.json'), '{"fuzzing":{"targetContracts":["AuditHarness"]}}\n');
  await fs.mkdir(path.join(bundleRoot, 'test/phase6'), { recursive: true });
  await fs.writeFile(path.join(bundleRoot, 'test/phase6/AuditHarness.t.sol'), 'contract AuditHarness {}\n');
  await fs.writeFile(path.join(bundleRoot, 'foundry.toml'), '[profile.default]\nsrc="contracts"\ntest="test"\n');
  await fs.writeFile(path.join(bundleRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 'phase6-audit-harness-overlay-v1',
    bundleId: 'cyvlsdt-v30-phase6-v1',
    sourceBinding: {
      repository: 'curveyield3/Solo-Audit-Controller',
      commit: '6bde63416a4611e127b8bb3a5958e6b6d874c188',
      archiveSha256: 'cc5c4dc6f8aa5d2e48043f6c3a837317ce6a4590c291e7e0571e4206c7d9877a'
    },
    files: [
      { source: 'medusa.json', destination: 'medusa.json' },
      { source: 'foundry.toml', destination: 'foundry.toml' },
      { source: 'test/phase6/AuditHarness.t.sol', destination: 'test/phase6/AuditHarness.t.sol' }
    ]
  }, null, 2));
  return { root, runnerRoot, projectRoot };
}

test('materializes a runner-owned audit harness overlay without modifying frozen production files', async (t) => {
  const { root, runnerRoot, projectRoot } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const productionBefore = await fs.readFile(path.join(projectRoot, 'contracts/Production.sol'), 'utf8');

  const result = await materializePhase6HarnessOverlayV1({
    projectRoot,
    runnerRoot,
    bundleId: 'cyvlsdt-v30-phase6-v1',
    source: {
      repository: 'curveyield3/Solo-Audit-Controller',
      commit: '6bde63416a4611e127b8bb3a5958e6b6d874c188',
      archiveSha256: 'cc5c4dc6f8aa5d2e48043f6c3a837317ce6a4590c291e7e0571e4206c7d9877a'
    }
  });

  assert.equal(await fs.readFile(path.join(projectRoot, 'contracts/Production.sol'), 'utf8'), productionBefore);
  assert.match(await fs.readFile(path.join(projectRoot, 'medusa.json'), 'utf8'), /AuditHarness/);
  assert.match(await fs.readFile(path.join(projectRoot, 'foundry.toml'), 'utf8'), /src="contracts"/);
  assert.match(await fs.readFile(path.join(projectRoot, 'test/phase6/AuditHarness.t.sol'), 'utf8'), /AuditHarness/);
  assert.equal(result.bundleId, 'cyvlsdt-v30-phase6-v1');
  assert.equal(result.sourceBinding.commit, '6bde63416a4611e127b8bb3a5958e6b6d874c188');
  assert.equal(result.files.length, 3);
  assert.match(result.overlayDigestSha256, /^[0-9a-f]{64}$/);
});

test('rejects an audit harness overlay whose immutable source binding does not match the request', async (t) => {
  const { root, runnerRoot, projectRoot } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    materializePhase6HarnessOverlayV1({
      projectRoot,
      runnerRoot,
      bundleId: 'cyvlsdt-v30-phase6-v1',
      source: {
        repository: 'curveyield3/Solo-Audit-Controller',
        commit: '0000000000000000000000000000000000000000',
        archiveSha256: 'cc5c4dc6f8aa5d2e48043f6c3a837317ce6a4590c291e7e0571e4206c7d9877a'
      }
    }),
    /source binding/i
  );
});
