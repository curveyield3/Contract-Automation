import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/browser-agent-watchdog.yml'), 'utf8');
const functions = workflow.slice(workflow.indexOf('          safe_repo_path() {'), workflow.indexOf('          if ! fetch_state; then'));
const handoff = 'campaigns/synthetic/handoffs/P0_TO_P1/START_HERE.md';
const dir = path.posix.dirname(handoff);
const packetPath = dir + '/MECHANICAL_WORK_PACKET_v2.json';
const completionPath = dir + '/MECHANICAL_WORK_COMPLETION_v2.json';
const unitOutputPaths = Array.from({ length: 10 }, (_, i) => dir + `/MECHANICAL/UNIT_${String(i + 1).padStart(2, '0')}_v2.json`);
const reconciliationPath = dir + '/MECHANICAL/FINAL_RECONCILIATION_v2.json';
const outputPath = unitOutputPaths[0];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function exercise(mutate = () => {}, launch = false) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-interphase-'));
  try {
    const output = '{"indexed":true}\n';
    const workUnits = unitOutputPaths.map((unitPath, index) => ({
      id: `unit-${String(index + 1).padStart(2, '0')}`,
      instructions: `Mechanically reconcile synthetic evidence partition ${index + 1}.`,
      outputPath: unitPath,
      verification: 'Output must match the exact filed synthetic evidence bytes.'
    }));
    const requiredOutputs = [
      ...unitOutputPaths.map((unitPath) => ({ path: unitPath })),
      { path: reconciliationPath }
    ];
    const packet = {
      schemaVersion: 'curveyield-lite-interphase-work-packet-v2',
      taskClass: 'MECHANICAL_ONLY', campaignId: 'synthetic',
      completedMilestoneId: 'P0_BOOTSTRAP', handoffPath: handoff,
      instructions: 'Complete all ten synthetic evidence reconciliation units and the final reconciliation output.',
      workUnits,
      reconciliationOutputPath: reconciliationPath,
      requiredOutputs
    };
    const files = { output };
    mutate(packet, files);
    const packetBytes = JSON.stringify(packet);
    const receipt = {
      schemaVersion: 'curveyield-lite-interphase-completion-v2',
      status: 'PASS', campaignId: 'synthetic',
      completedMilestoneId: 'P0_BOOTSTRAP', handoffPath: handoff,
      workPacketPath: packetPath, workPacketSha256: sha(packetBytes),
      workUnitReceipts: workUnits.map((unit) => ({ id: unit.id, outputPath: unit.outputPath, sha256: sha(output) })),
      outputs: requiredOutputs.map((entry) => ({ path: entry.path, sha256: sha(output) })),
      completedAt: '2026-09-25T00:00:00Z'
    };
    if (files.receipt) Object.assign(receipt, files.receipt);
    const named = { packet: packetBytes, receipt: JSON.stringify(receipt),
      output: files.output ?? output,
      pointer: JSON.stringify({
        completedMilestone: { id: 'P0_BOOTSTRAP', status: 'SEALED' },
        nextPhaseId: 'phase-1',
        nextMilestone: { id: 'P1', state: 'READY', phaseRange: ['1'], reviewer: 'reviewer-1' },
        authoritativeHandoff: handoff,
        authoritativeHandoffIdentity: { contentCommit: '1111111111111111111111111111111111111111' }
      }),
      campaignState: JSON.stringify({
        campaignId: 'synthetic',
        auditName: 'Synthetic Audit',
        mode: 'LITE',
        
        controller: { workspacePath: 'campaigns/synthetic' },
        routingPlan: { workers: [{ lineage: 'reviewer-1', milestone: 'P1', status: 'NOT_STARTED' }] }
      }),
      successorHandoff: JSON.stringify({
        schemaVersion: 'audit-v7-lite-successor-handoff-v38',
        boundaryProfileId: 'P0_TO_P1',
        campaign: {
          campaignType: 'LITE',
          campaignName: 'Synthetic Audit',
          campaignId: 'synthetic',
          campaignGenerationId: 'synthetic-g1',
          workspacePath: 'campaigns/synthetic',
          campaignFolderUrl: 'https://github.com/curveyield3/Audit-Controller/tree/main/campaigns/synthetic',
          campaignLink: 'https://github.com/curveyield3/Audit-Controller/tree/main/campaigns/synthetic'
        },
        reviewers: { outgoing: 'web-bootstrap-agent', incoming: 'reviewer-1' },
        assignment: { incomingReviewer: 'reviewer-1', assignedLitePhaseOrMilestone: 'Phase 1' },
        authority: {
          liteSkillRepositoryPath: 'curveyield3/Audit-Controller/Audit Skill - Current Authority',
          liteSkillUrl: 'https://github.com/curveyield3/Audit-Controller/tree/main/Audit%20Skill%20-%20Current%20Authority'
        }
      }),
      wake: [
        '# Lite Successor Wake-Up Message',
        '',
        '- Campaign type: **LITE**',
        '- Campaign name: Synthetic Audit',
        '- Controller `workspacePath`: `campaigns/synthetic`',
        '- Campaign ID / generation: `synthetic / synthetic-g1`',
        '- Incoming reviewer: `reviewer-1`',
        '- Assigned Lite phase/milestone: `Phase 1`',
        '- Repository path: `curveyield3/Audit-Controller/Audit Skill - Current Authority`',
        ''
      ].join('\n') };
    for (const [name, value] of Object.entries(named)) fs.writeFileSync(path.join(temp, name), value);
    fs.writeFileSync(path.join(temp, 'state'), JSON.stringify({
      gate: { interphase: { workPacketSha256: files.pinnedSha ?? sha(packetBytes) } }
    }));
    const script = String.raw`
set -euo pipefail
gh() {
  if [ "$1" = api ]; then
    case "$2" in
      *MECHANICAL_WORK_PACKET_v1.json*) return 1;;
      *MECHANICAL_WORK_PACKET_v2.json*) base64 -w0 "$FIXTURE_DIR/packet";;
      *MECHANICAL_WORK_COMPLETION_v2.json*) [ "$MISSING_RECEIPT" = no ] && base64 -w0 "$FIXTURE_DIR/receipt" || return 1;;
      *MECHANICAL/*.json*) [ "$MISSING_OUTPUT" = no ] && base64 -w0 "$FIXTURE_DIR/output" || return 1;;
      *pointer.json*) base64 -w0 "$FIXTURE_DIR/pointer";;
      *SUCCESSOR_HANDOFF.json*) base64 -w0 "$FIXTURE_DIR/successorHandoff";;
      *WAKE_UP_MESSAGE.md*) base64 -w0 "$FIXTURE_DIR/wake";;
      *) return 1;;
    esac
  elif [ "$1" = workflow ]; then
    printf '%s\n' "$*" >> "$FIXTURE_DIR/dispatch"
  fi
}
campaign_id=synthetic
worker_role=interphase_mechanical
gate_interphase_work_packet_path="$PACKET_PATH"
gate_interphase_completion_path="$COMPLETION_PATH"
gate_interphase_handoff_path="$HANDOFF_PATH"
AUDIT_CONTROLLER_GITHUB_TOKEN=synthetic
GITHUB_REPOSITORY=curveyield3/Contract-Automation
GITHUB_RUN_ID=123
cycle=1
gate_path=campaigns/synthetic/state.json
gate_expected_phase=phase-0
cp "$FIXTURE_DIR/state" /tmp/watchdog-state.json
cp "$FIXTURE_DIR/campaignState" /tmp/canonical-campaign-state.json
`;
    const command = script + functions + (launch === 'mechanical'
      ? String.raw`
if launch_lite_successor campaigns/synthetic/pointer.json P0_BOOTSTRAP curveyield3/Audit-Controller main; then
  exit 42
else
  [ "$?" -eq 4 ]
fi
`
      : launch ? String.raw`
if verify_lite_interphase_completion "$PACKET_PATH" "$COMPLETION_PATH" "$HANDOFF_PATH" P0_BOOTSTRAP curveyield3/Audit-Controller main; then
  launch_lite_successor campaigns/synthetic/pointer.json P0_BOOTSTRAP curveyield3/Audit-Controller main
else
  exit 41
fi
`
      : String.raw`
verify_lite_interphase_completion "$PACKET_PATH" "$COMPLETION_PATH" "$HANDOFF_PATH" P0_BOOTSTRAP curveyield3/Audit-Controller main
`);
    const result = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: {
      ...process.env, FIXTURE_DIR: temp, PACKET_PATH: packetPath,
      COMPLETION_PATH: completionPath, HANDOFF_PATH: handoff,
      MISSING_OUTPUT: files.missingOutput ? 'yes' : 'no',
      MISSING_RECEIPT: files.missingReceipt ? 'yes' : 'no'
    } });
    return { result, dispatched: fs.existsSync(path.join(temp, 'dispatch'))
      ? fs.readFileSync(path.join(temp, 'dispatch'), 'utf8') : '' };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

test('sealed P0 synthetic packet validates and dispatches one successor with verified mechanical context', () => {
  const { result, dispatched } = exercise(() => {}, true);
  assert.notEqual(result.status, 0);
  assert.equal(dispatched, '');
  assert.match(result.stdout, /Legacy create-fresh Lite successor launcher is retired/);
  assert.match(result.stdout, /pre-created reviewer chats and the Phase-1 fixed X11 sender/);
});

test('interphase gate fails closed across packet and receipt mutations', () => {
  const cases = [
    (p) => { p.taskClass = 'SEMANTIC'; },
    (p) => { p.schemaVersion = 'invalid'; },
    (p) => { p.unexpectedApproval = true; },
    (p) => { p.requiredOutputs[0].securityDisposition = 'APPROVED'; },
    (p, f) => { f.receipt = { semanticApproval: true }; },
    (p, f) => { f.receipt = { outputs: [{ path: outputPath, sha256: sha('{"indexed":true}\n'), semanticApproval: true }] }; },
    (p, f) => { f.receipt = { handoffPath: 'other' }; },
    (p) => { p.requiredOutputs = []; },
    (p, f) => { f.pinnedSha = '0'.repeat(64); },
    (p, f) => { f.missingOutput = true; },
    (p, f) => { f.receipt = { workPacketSha256: '0'.repeat(64) }; },
    (p, f) => { f.receipt = { outputs: [{ path: outputPath, sha256: '0'.repeat(64) }] }; },
    (p, f) => { f.receipt = { outputs: [] }; },
    (p, f) => { f.receipt = { outputs: [{ path: outputPath, sha256: sha('{"indexed":true}\n') }, { path: outputPath, sha256: sha('{"indexed":true}\n') }] }; },
    (p, f) => { f.receipt = { campaignId: 'other' }; },
    (p, f) => { f.receipt = { status: 'INCOMPLETE' }; },
    (p) => { p.requiredOutputs = [{ path: dir + '/OTHER.json' }]; }
  ];
  for (const mutate of cases) {
    const { result, dispatched } = exercise(mutate, true);
    assert.notEqual(result.status, 0, mutate.toString());
    assert.equal(dispatched, '', mutate.toString());
  }
});

test('sealed P0 dispatches a bounded mechanical wake before a receipt exists', () => {
  const { result, dispatched } = exercise((packet, files) => {
    files.missingReceipt = true;
  }, 'mechanical');
  assert.notEqual(result.status, 0);
  assert.equal(dispatched, '');
  assert.match(result.stdout, /Legacy create-fresh Lite successor launcher is retired/);
});
