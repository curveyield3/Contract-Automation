#!/usr/bin/env node

const LIGHT_PATTERNS = [
  /^\.github\/workflows\/audit-controller-execution\.yml$/,
  /^\.github\/workflows\/browser-agent-wake\.yml$/,
  /^\.github\/workflows\/browser-agent-watchdog\.yml$/,
  /^\.github\/workflows\/browser-agent-reviewer-repair-v1\.yml$/,
  /^\.github\/workflows\/(?:lite|ultralite)-audit-browser-orchestrator-v1\.yml$/,
  /^\.github\/workflows\/development-agent-task-manager\.yml$/,
  /^\.github\/actions\/setup-browser-agent-runtime\//,
  /^\.github\/workflows\/agent-zip-import-v1\.yml$/,
  /^\.github\/workflows\/audit-source-initialization-v1\.yml$/,
  /^scripts\/browser-agent-wake\.mjs$/,
  /^scripts\/browser-operations-v1\.mjs$/,
  /^scripts\/browser-routine-engine-v1\.mjs$/,
  /^scripts\/browser-session-state-v1\.mjs$/,
  /^scripts\/select-audit-controller-token\.sh$/,
  /^scripts\/audit-source-initialization\//,
  /^scripts\/classify-v7-qualification-change\.mjs$/,
  /^scripts\/rebuild-current-audit-skill-manifests-v1\.mjs$/,
  /^\.github\/workflows\/rebuild-current-audit-skill-package-v1\.yml$/,
  /^docs\//,
  /^process\/browser-agent-wake\//,
  /^process\/browser-routines\//,
  /^process\/browser-agent-watchdog\//,
  /^process\/development-agent-task-manager\//,
  /^process\/audit-source-initialization\//,
  /^process\/V7_QUALIFICATION_STATUS\.json$/,
  /^process\/V7_QUALIFICATION_LAST_RUN\.json$/,
  /^protocol\/schemas\/curveyield-lite-interphase-.*\.schema\.json$/,
  /^protocol\/schemas\/curveyield-reviewer-repair-request-v1\.schema\.json$/,
  /^protocol\/schemas\/curveyield-development-task-completion-v1\.schema\.json$/,
  /^protocol\/schemas\/curveyield-development-agent-task-request-v1\.schema\.json$/,
  /^protocol\/schemas\/curveyield-development-authority-import-v1\.schema\.json$/,
  /^packages\/github-native-sim\/test\/browser-agent-.*\.test\.mjs$/,
  /^packages\/github-native-sim\/test\/development-agent-task-manager-v1\.test\.mjs$/,
  /^packages\/github-native-sim\/test\/development-agent-task-manager-.*\.test\.mjs$/,
  /^packages\/github-native-sim\/test\/agent-zip-import-.*\.test\.mjs$/,
  /^packages\/github-native-sim\/test\/audit-source-initialization-.*\.test\.mjs$/,
  /^packages\/github-native-sim\/test\/audit-controller-token-selection-v1\.test\.mjs$/,
  /^packages\/github-native-sim\/test\/atomic-request-bridge-v1\.test\.mjs$/,
  /^packages\/github-native-sim\/test\/execution-workflow-v2\.test\.mjs$/,
  // Controller Phase-5 evidence selection is independently covered by the
  // lightweight exact-evidence regression workflow. It does not change the
  // V7 engine, fork simulator, or deployment runtime.
  /^packages\/github-native-sim\/src\/lite-boundary-artifacts-v1\.mjs$/,
  /^packages\/github-native-sim\/test\/lite-phase5-execution-gate-v1\.test\.mjs$/,
];

export function classifyV7QualificationChanges(paths, { forceFull = false } = {}) {
  const normalized = [...new Set((paths ?? []).map((value) => String(value).trim()).filter(Boolean))].sort();
  if (forceFull || normalized.length === 0) {
    return { lane: 'FULL', paths: normalized, reason: forceFull ? 'EXPLICIT_FULL' : 'NO_CHANGED_PATHS' };
  }
  const nonLight = normalized.filter((file) => !LIGHT_PATTERNS.some((pattern) => pattern.test(file)));
  return nonLight.length === 0
    ? { lane: 'CONTROL_LIGHT', paths: normalized, reason: 'ALL_PATHS_CONTROL_PLANE' }
    : { lane: 'FULL', paths: normalized, reason: 'RUNNER_OR_UNKNOWN_PATH', escalatedPaths: nonLight };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const forceFull = process.argv.includes('--full');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const result = classifyV7QualificationChanges(input.split(/\r?\n/), { forceFull });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

