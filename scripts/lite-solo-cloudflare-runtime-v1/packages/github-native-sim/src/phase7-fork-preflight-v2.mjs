import { runPhase7ForkPreflightV1 } from './phase7-fork-preflight-v1.mjs';
import { validateWorkflowAgainstV7RecipeV1 } from './lifecycle-recipes-v1.mjs';

export async function runPhase7ForkPreflightV2(options) {
  const request = options?.request;
  if (!request || request.phaseId !== 'fork-simulation-lifecycle') {
    throw new Error('Phase 7 fork preflight v2 requires fork-simulation-lifecycle request');
  }
  const workflow = request.configuration?.simulation?.workflow;
  const recipeId = request.configuration?.harness?.recipeId;
  if (typeof recipeId !== 'string' || recipeId.length === 0) {
    return {
      schemaVersion: 'audit-v7-phase7-fork-preflight-v2',
      status: 'FAIL',
      failureKind: 'RECIPE_GAP',
      requestId: request.requestId,
      sourceCommit: request.source?.commit ?? null,
      chain: request.configuration?.simulation?.chain ?? null,
      pinnedBlock: request.configuration?.simulation?.block ?? null,
      evmVersion: request.configuration?.evmVersion ?? null,
      recipeId: null,
      checks: {
        lifecycleRecipe: {
          status: 'FAIL',
          reason: 'configuration.harness.recipeId is mandatory for Phase 7 lifecycle execution',
        },
      },
      nextState: 'PHASE7_FORK_PREFLIGHT',
    };
  }


  // Never allow the non-redeployment recipe against a fresh or unverified fork.
  // Anvil's code probe checks this literal, source-planned contract before
  // execution, so a misbound or zero-code address fails rather than faking PASS.
  if(recipeId==='phase0-snapshot-targeted-v1'){
    const verified=typeof options?.environment?.V7_PHASE0_FORK_STATE_PATH==='string'&&
      options.environment.V7_PHASE0_FORK_STATE_PATH.length>0&&
      Number.isSafeInteger(Number(options.environment.V7_PHASE0_FORK_FINAL_BLOCK));
    const callActions=new Set(['call','staticCall','assertCall','expectRevert']);
    const hasLiteralTarget=(workflow?.steps??[]).some(step=>
      callActions.has(step?.action)&&/^0x[0-9a-fA-F]{40}$/.test(step?.target??''));
    if(!verified||!hasLiteralTarget){
      return{schemaVersion:'audit-v7-phase7-fork-preflight-v2',
        status:'FAIL',failureKind:'PHASE0_SNAPSHOT_RECIPE_UNBOUND',
        requestId:request.requestId,chain:request.configuration?.simulation?.chain??null,
        pinnedBlock:request.configuration?.simulation?.block??null,
        checks:{snapshotRecipe:{status:'FAIL',
          reason:!verified?'No verified bound Phase-0 state':'No literal deployed contract target for pre-execution code proof'}},
        nextState:'PHASE7_FORK_PREFLIGHT'};
    }
  }
  // Snapshot-proven, non-redeployment execution is a separate mode. Legacy
  // lifecycle recipes retain the requirement to freshly deploy audited aliases.
  if(options?.environment?.V7_PHASE0_FORK_STATE_PATH&&
     recipeId!=='phase0-snapshot-targeted-v1'){
    return{schemaVersion:'audit-v7-phase7-fork-preflight-v2',
      status:'FAIL',failureKind:'SNAPSHOT_RECIPE_MISMATCH',
      requestId:request.requestId,
      checks:{snapshotRecipe:{status:'FAIL',reason:'Only saved-state targeted recipe is permitted'}},
      nextState:'PHASE7_FORK_PREFLIGHT'};
  }

  const recipe = validateWorkflowAgainstV7RecipeV1(recipeId, workflow);
  if (recipe.status !== 'SUPPORTED') {
    return {
      schemaVersion: 'audit-v7-phase7-fork-preflight-v2',
      status: 'FAIL',
      failureKind: 'RECIPE_GAP',
      requestId: request.requestId,
      sourceCommit: request.source?.commit ?? null,
      chain: request.configuration?.simulation?.chain ?? null,
      pinnedBlock: request.configuration?.simulation?.block ?? null,
      evmVersion: request.configuration?.evmVersion ?? null,
      recipeId,
      checks: {
        lifecycleRecipe: {
          status: 'FAIL',
          recipeId,
          unsupported: recipe.unsupported ?? [],
          missingRequiredLabels: recipe.missingRequiredLabels ?? [],
          supportedRecipeIds: recipe.supportedRecipeIds ?? null,
        },
      },
      nextState: 'PHASE7_FORK_PREFLIGHT',
    };
  }

  const base = await runPhase7ForkPreflightV1(options);
  const lifecycleRecipe = {
    status: 'PASS',
    recipeId,
    purpose: recipe.recipe.purpose,
    requiredLabels: recipe.recipe.requiredLabels ?? [],
  };
  const checks = { ...(base.checks ?? {}), lifecycleRecipe };
  const allPass = Object.values(checks).every((check) => ['PASS', 'UNAVAILABLE'].includes(check?.status))
    && base.status === 'PASS';
  return {
    ...base,
    schemaVersion: 'audit-v7-phase7-fork-preflight-v2',
    status: allPass ? 'PASS' : base.status,
    recipeId,
    checks,
  };
}
