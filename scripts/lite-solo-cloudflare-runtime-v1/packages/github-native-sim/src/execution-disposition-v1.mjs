import { V7_POLICY, executionRecoveryCommand, phase6HarnessRecoveryCommand } from './v7-policy.mjs';

function base(disposition, fields = {}) {
  return { disposition, ...fields };
}

export function deriveExecutionDisposition({ request, result, requestPath = '<request.json>' } = {}) {
  const preflight = result?.preflight ?? null;
  if (preflight && preflight.status !== 'PASS') {
    if (preflight.nextState === 'PHASE6_HARNESS_AUTHORING') {
      return base(V7_POLICY.dispositions.harnessRequired, {
        blocking: true,
        owner: 'AUDITOR',
        nextAction: 'CREATE_OR_REPAIR_PHASE6_HARNESS',
        retryFrom: 'PHASE6_EXECUTION_PREFLIGHT',
        recoveryCommand: phase6HarnessRecoveryCommand(requestPath),
      });
    }
    if (preflight.failureKind === 'RECIPE_GAP' || preflight.nextState === 'RECIPE_GAP') {
      return base(V7_POLICY.dispositions.recipeGap, {
        blocking: true,
        owner: 'RUNNER_MAINTAINER',
        nextAction: 'ADD_OR_APPROVE_LIFECYCLE_RECIPE',
        retryFrom: request?.phaseId ?? null,
        recoveryCommand: null,
      });
    }
    if (preflight.nextState === 'RUNNER_REPAIR_REBIND') {
      return base(V7_POLICY.dispositions.runnerRepair, {
        blocking: true,
        owner: 'RUNNER_MAINTAINER',
        nextAction: 'REPAIR_AND_REQUALIFY_RUNNER',
        retryFrom: request?.phaseId ?? null,
        recoveryCommand: null,
      });
    }
    return base(V7_POLICY.dispositions.infrastructureBlocked, {
      blocking: true,
      owner: 'RUNNER_MAINTAINER',
      nextAction: 'RESOLVE_PREFLIGHT_BLOCKER',
      retryFrom: request?.phaseId ?? null,
      recoveryCommand: null,
    });
  }

  if (result?.status === 'completed') {
    const hasIssues = (result.failedStepCount ?? 0) > 0 || (result.analysisComponentFailureCount ?? 0) > 0;
    return base(hasIssues ? V7_POLICY.dispositions.findings : V7_POLICY.dispositions.pass, {
      blocking: false,
      owner: 'AUDITOR',
      nextAction: hasIssues ? 'INGEST_EXECUTION_EVIDENCE' : 'CONTINUE_AUDIT',
      retryFrom: null,
      recoveryCommand: null,
    });
  }

  const kind = result?.error?.kind ?? result?.error?.code ?? null;
  if (kind === 'RECIPE_GAP') {
    return base(V7_POLICY.dispositions.recipeGap, {
      blocking: true,
      owner: 'RUNNER_MAINTAINER',
      nextAction: 'ADD_OR_APPROVE_LIFECYCLE_RECIPE',
      retryFrom: request?.phaseId ?? null,
      recoveryCommand: null,
    });
  }
  if (result?.continuityDisposition === 'RUNNER_REPAIR_REBIND_REQUIRED') {
    return base(V7_POLICY.dispositions.runnerRepair, {
      blocking: true,
      owner: 'RUNNER_MAINTAINER',
      nextAction: 'REPAIR_AND_REQUALIFY_RUNNER',
      retryFrom: request?.phaseId ?? null,
      recoveryCommand: null,
    });
  }
  return base(V7_POLICY.dispositions.executionFailed, {
    blocking: true,
    owner: 'AUDITOR',
    nextAction: 'REVIEW_TYPED_FAILURE_EVIDENCE',
    retryFrom: request?.phaseId ?? null,
    recoveryCommand: executionRecoveryCommand(requestPath),
  });
}

export function attachExecutionDisposition({ request, result, requestPath } = {}) {
  const disposition = deriveExecutionDisposition({ request, result, requestPath });
  return { ...result, ...disposition };
}
