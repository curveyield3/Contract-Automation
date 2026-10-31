const RUNTIME_ACTIONS = Object.freeze(['deploy','call','staticCall','expectRevert','setBalance','transferNative','mine','increaseTime','snapshot','revertSnapshot','assertBalance','assertCall']);

const BASE_RECIPES = {
  'phase0-snapshot-targeted-v1': {
    purpose: 'Source-bound tests against a verified post-deployment Anvil snapshot; deployment is already completed.',
    allowedActions:['snapshot','call','staticCall','expectRevert','assertCall','assertBalance',
      'setBalance','transferNative','mine','increaseTime','revertSnapshot'],
    requiresFreshDeployment:false,
    requiredLabels:['pin persisted Phase 0 baseline']
  },
  'external-readiness-v1': {
    purpose: 'Pinned external dependency identity and state assertions.',
    allowedActions: ['staticCall', 'assertCall', 'snapshot'],
    requiresFreshDeployment: false,
  },
  'deploy-configure-smoke-v1': {
    purpose: 'Deploy exact accepted artifacts and exercise intended configuration ordering.',
    allowedActions: ['snapshot', 'deploy', 'call', 'staticCall', 'assertCall', 'expectRevert', 'revertSnapshot'],
    requiresFreshDeployment: true,
  },
  'deposit-withdraw-cycle-v1': {
    purpose: 'Complete custody, share-accounting, fee and withdrawal lifecycle.',
    allowedActions: ['deploy', 'setBalance', 'call', 'staticCall', 'assertCall', 'assertBalance', 'increaseTime', 'mine'],
    requiresFreshDeployment: true,
  },
  'reward-accrual-claim-v1': {
    purpose: 'Reward index, checkpoint, zero-supply, accrual and claim lifecycle.',
    allowedActions: ['deploy', 'setBalance', 'call', 'increaseTime', 'mine', 'staticCall', 'assertCall'],
    requiresFreshDeployment: true,
  },
  'privilege-transition-v1': {
    purpose: 'Owner, DAO, operator, keeper or delegation transition and stale-state assertions.',
    allowedActions: ['deploy', 'call', 'expectRevert', 'staticCall', 'assertCall', 'snapshot', 'revertSnapshot'],
    requiresFreshDeployment: true,
  },
  'external-swap-minout-v1': {
    purpose: 'External route identity, units and atomic final minOut protection.',
    allowedActions: ['deploy', 'setBalance', 'call', 'staticCall', 'expectRevert', 'snapshot', 'revertSnapshot'],
    requiresFreshDeployment: true,
  },
  'zero-supply-restart-v1': {
    purpose: 'Final-exit and first-redeposit value attribution across zero supply.',
    allowedActions: ['deploy', 'call', 'increaseTime', 'mine', 'staticCall', 'assertCall', 'snapshot'],
    requiresFreshDeployment: true,
  },
  'repeated-lifecycle-v1': {
    purpose: 'Catch state that becomes unsafe only after multiple cycles.',
    allowedActions: ['deploy','call','staticCall','expectRevert','setBalance','transferNative','mine','increaseTime','snapshot','revertSnapshot','assertBalance','assertCall'],
    requiresFreshDeployment: true,
    repeatedLifecycle: true,
  },
};

const GOVERNANCE_STAKING_ZERO_SUPPLY_RESTART = {
  purpose: 'Deploy GovernanceStaking on the pinned Ethereum fork and prove custody, zero-working-supply reward handling, first-redeposit attribution, claimability, and restart behavior.',
  allowedActions: ['snapshot', 'setBalance', 'deploy', 'call', 'assertCall', 'staticCall', 'increaseTime', 'mine', 'revertSnapshot'],
  requiresFreshDeployment: true,
  requiredLabels: [
    'pin lifecycle baseline',
    'fund staking user with forked SDT',
    'deploy governance staking',
    'deposit staking principal',
    'withdraw staking principal to zero supply',
    'fund reward distributor with WETH',
    'register WETH reward token',
    'deposit WETH reward at zero working supply',
    'restart staking after zero supply',
    'observe restarted reward attribution',
    'claim restarted reward',
    'observe claimed WETH balance',
    'restore lifecycle baseline',
  ],
};

function freezeRecipe(recipe){ return Object.freeze({...recipe,allowedActions:Object.freeze([...recipe.allowedActions]),...(recipe.requiredLabels?{requiredLabels:Object.freeze([...recipe.requiredLabels])}:{})}); }
export const V7_LIFECYCLE_RECIPES_V1 = Object.freeze(Object.fromEntries(
  Object.entries({...BASE_RECIPES,'governance-staking-zero-supply-restart-v1':GOVERNANCE_STAKING_ZERO_SUPPLY_RESTART}).map(([id,recipe])=>[id,freezeRecipe(recipe)])
));

export function getV7LifecycleRecipeV1(recipeId) {
  const recipe = V7_LIFECYCLE_RECIPES_V1[recipeId];
  if (!recipe) return { status: 'RECIPE_GAP', recipeId, supportedRecipeIds: Object.keys(V7_LIFECYCLE_RECIPES_V1).sort() };
  return { status: 'SUPPORTED', recipeId, recipe: structuredClone(recipe) };
}

function repeatedLifecycleGaps(steps){
  const calls=steps.filter(s=>s?.action==='call').length;
  const time=steps.filter(s=>s?.action==='increaseTime').length;
  const mine=steps.filter(s=>s?.action==='mine').length;
  const snapshots=steps.filter(s=>s?.action==='snapshot').length;
  const reverts=steps.filter(s=>s?.action==='revertSnapshot').length;
  const gaps=[];
  if(calls<2) gaps.push('at least two lifecycle action cycles are required');
  if((time>0||mine>0)&&(time<2||mine<2)) gaps.push('time/state lifecycle repetition must occur across at least two cycles');
  if(snapshots>0&&reverts===0) gaps.push('snapshot use requires revertSnapshot validation');
  return gaps;
}

const LOCAL_ALIAS_TARGET = /^\$([A-Za-z][A-Za-z0-9_]*)$/;
const FUNCTION_TEST_ACTIONS = new Set(['call', 'staticCall', 'assertCall', 'expectRevert']);

function validateFreshDeploymentPrerequisite(recipe, steps) {
  if (!recipe.requiresFreshDeployment) return { status: 'NOT_REQUIRED', aliasesUsedBeforeDeployment: [] };

  const deployedAliases = new Set();
  const aliasesUsedBeforeDeployment = new Set();
  let deploymentCount = 0;
  let deployedAliasFunctionTests = 0;

  for (const step of steps) {
    if (step?.action === 'deploy') {
      if (typeof step.alias === 'string' && step.alias.length > 0) deployedAliases.add(step.alias);
      deploymentCount += 1;
      continue;
    }
    if (!FUNCTION_TEST_ACTIONS.has(step?.action) || typeof step?.target !== 'string') continue;
    const match = step.target.match(LOCAL_ALIAS_TARGET);
    if (!match) continue;
    const alias = match[1];
    if (/^account\d+$/.test(alias)) continue;
    if (!deployedAliases.has(alias)) aliasesUsedBeforeDeployment.add(alias);
    else deployedAliasFunctionTests += 1;
  }

  const aliases = [...aliasesUsedBeforeDeployment].sort();
  if (deploymentCount === 0) {
    return { status: 'MISSING_FRESH_DEPLOYMENT', deploymentCount, deployedAliasFunctionTests, aliasesUsedBeforeDeployment: aliases };
  }
  if (aliases.length > 0) {
    return { status: 'ALIAS_USED_BEFORE_DEPLOYMENT', deploymentCount, deployedAliasFunctionTests, aliasesUsedBeforeDeployment: aliases };
  }
  if (deployedAliasFunctionTests === 0) {
    return { status: 'MISSING_DEPLOYED_FUNCTION_TEST', deploymentCount, deployedAliasFunctionTests, aliasesUsedBeforeDeployment: [] };
  }
  return { status: 'SATISFIED', deploymentCount, deployedAliasFunctionTests, aliasesUsedBeforeDeployment: [] };
}

export function validateWorkflowAgainstV7RecipeV1(recipeId, workflow) {
  const resolved = getV7LifecycleRecipeV1(recipeId);
  if (resolved.status !== 'SUPPORTED') return resolved;
  const allowed = new Set(resolved.recipe.allowedActions);
  const steps = workflow?.steps ?? [];
  const unsupported = steps.map((step,index)=>({index,action:step?.action})).filter(({action})=>!allowed.has(action));
  const labels = new Set(steps.map((step)=>step?.label).filter((label)=>typeof label==='string'));
  const missingRequiredLabels = (resolved.recipe.requiredLabels ?? []).filter((label)=>!labels.has(label));
  const repeatedLifecycleFailures = recipeId==='repeated-lifecycle-v1' ? repeatedLifecycleGaps(steps) : [];
  const deploymentPrerequisite = validateFreshDeploymentPrerequisite(resolved.recipe, steps);
  const status = unsupported.length===0
    && missingRequiredLabels.length===0
    && repeatedLifecycleFailures.length===0
    && ['NOT_REQUIRED','SATISFIED'].includes(deploymentPrerequisite.status)
    ? 'SUPPORTED'
    : 'RECIPE_GAP';
  return { status, recipeId, unsupported, missingRequiredLabels, repeatedLifecycleFailures, deploymentPrerequisite, recipe: resolved.recipe };
}

export function registerV7LifecycleRecipeExtensionV1(baseRegistry, extension){
  if(!baseRegistry||typeof baseRegistry!=='object'||Array.isArray(baseRegistry)) throw new Error('baseRegistry must be an object');
  const id=extension?.id; if(typeof id!=='string'||!id.trim()) throw new Error('extension id is required');
  if(Object.prototype.hasOwnProperty.call(baseRegistry,id)) throw new Error(`duplicate canonical recipe ID: ${id}`);
  if(!Array.isArray(extension.allowedActions)||extension.allowedActions.length===0) throw new Error('extension allowedActions must be non-empty');
  for(const action of extension.allowedActions) if(!RUNTIME_ACTIONS.includes(action)) throw new Error(`unsupported action in recipe extension: ${action}`);
  if(extension.requiredLabels!==undefined&&(!Array.isArray(extension.requiredLabels)||extension.requiredLabels.some(x=>typeof x!=='string'||!x.trim()))) throw new Error('malformed required labels');
  const recipe=freezeRecipe({
    purpose:typeof extension.purpose==='string'?extension.purpose:'Code-reviewed V7 lifecycle recipe extension.',
    allowedActions:[...new Set(extension.allowedActions)],
    requiresFreshDeployment:extension.requiresFreshDeployment===true,
    requiredLabels:extension.requiredLabels?[...new Set(extension.requiredLabels)]:undefined
  });
  return Object.freeze({...baseRegistry,[id]:recipe});
}

export function buildGovernanceStakingZeroSupplyRestartRecipeV1({
  sdt,
  sdtFundingSource,
  weth,
  stakingContract = 'CurveYieldGovernanceStaking',
  stakingSource = 'contracts/CurveYieldGovernanceStaking.vy',
  user = '$account1',
  manager = '$account0',
  stakeAmount = '100000000000000000000',
  rewardAmount = '1000000000000000000',
  rewardObservationSeconds = 86400,
} = {}) {
  for (const [label, value] of Object.entries({ sdt, sdtFundingSource, weth })) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} must be a literal address`);
  }
  if (!Number.isInteger(rewardObservationSeconds) || rewardObservationSeconds < 1) throw new Error('rewardObservationSeconds must be a positive integer');
  return {
    recipeId: 'governance-staking-zero-supply-restart-v1',
    workflow: {
      steps: [
        { action: 'snapshot', alias: 'lifecycleBaseline', label: 'pin lifecycle baseline' },
        { action: 'setBalance', account: sdtFundingSource, amount: '10000000000000000000', label: 'fund SDT source gas' },
        { action: 'call', target: sdt, function: 'transfer(address,uint256) returns (bool)', args: [user, stakeAmount], from: sdtFundingSource, label: 'fund staking user with forked SDT' },
        { action: 'deploy', alias: 'governanceStaking', contract: stakingContract, source: stakingSource, args: [sdt, manager], from: manager, label: 'deploy governance staking' },
        { action: 'call', target: sdt, function: 'approve(address,uint256) returns (bool)', args: ['$governanceStaking', stakeAmount], from: user, label: 'approve staking principal' },
        { action: 'call', target: '$governanceStaking', function: 'deposit(uint256)', args: [stakeAmount], from: user, label: 'deposit staking principal' },
        { action: 'assertCall', target: '$governanceStaking', function: 'totalSupply() view returns (uint256)', args: [], equals: stakeAmount, label: 'assert initial staking supply' },
        { action: 'call', target: '$governanceStaking', function: 'withdraw(uint256)', args: [stakeAmount], from: user, label: 'withdraw staking principal to zero supply' },
        { action: 'assertCall', target: '$governanceStaking', function: 'totalSupply() view returns (uint256)', args: [], equals: '0', label: 'assert zero staking supply' },
        { action: 'assertCall', target: '$governanceStaking', function: 'working_supply() view returns (uint256)', args: [], equals: '0', label: 'assert zero working supply' },
        { action: 'setBalance', account: manager, amount: '10000000000000000000', label: 'fund reward distributor gas' },
        { action: 'call', target: weth, function: 'deposit() payable', args: [], from: manager, value: rewardAmount, label: 'fund reward distributor with WETH' },
        { action: 'call', target: '$governanceStaking', function: 'add_reward(address,address)', args: [weth, manager], from: manager, label: 'register WETH reward token' },
        { action: 'call', target: weth, function: 'approve(address,uint256) returns (bool)', args: ['$governanceStaking', rewardAmount], from: manager, label: 'approve WETH reward' },
        { action: 'call', target: '$governanceStaking', function: 'deposit_reward_token(address,uint256)', args: [weth, rewardAmount], from: manager, label: 'deposit WETH reward at zero working supply' },
        { action: 'staticCall', target: '$governanceStaking', function: 'reward_remaining(address) view returns (uint256)', args: [weth], saveAs: 'rewardRemainingAtZeroSupply', label: 'observe reward remaining at zero supply' },
        { action: 'call', target: sdt, function: 'approve(address,uint256) returns (bool)', args: ['$governanceStaking', stakeAmount], from: user, label: 'approve restart staking principal' },
        { action: 'call', target: '$governanceStaking', function: 'deposit(uint256)', args: [stakeAmount], from: user, label: 'restart staking after zero supply' },
        { action: 'increaseTime', seconds: rewardObservationSeconds, label: 'advance restarted reward epoch' },
        { action: 'mine', blocks: 2, label: 'mine restarted reward blocks' },
        { action: 'staticCall', target: '$governanceStaking', function: 'claimable_reward(address,address) view returns (uint256)', args: [user, weth], saveAs: 'claimableAfterRestart', label: 'observe restarted reward attribution' },
        { action: 'call', target: '$governanceStaking', function: 'claim_rewards()', args: [], from: user, label: 'claim restarted reward' },
        { action: 'staticCall', target: weth, function: 'balanceOf(address) view returns (uint256)', args: [user], saveAs: 'claimedWethBalance', label: 'observe claimed WETH balance' },
        { action: 'revertSnapshot', snapshot: '$lifecycleBaseline', label: 'restore lifecycle baseline' },
      ],
    },
  };
}