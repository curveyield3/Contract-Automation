import { FunctionFragment } from 'ethers';

export const CAPABILITY_CONTRACT_VERSION_V2='curveyield-phase0-execution-capability-v2';
export const TERMINAL_OUTCOMES_V2=Object.freeze([
  'NOT_EXECUTED_ENCODING_OR_PLANNING',
  'SIMULATED_REJECTION',
  'SIMULATION_INFRASTRUCTURE_ERROR',
  'SUBMISSION_INFRASTRUCTURE_ERROR',
  'SUBMITTED_OUTCOME_UNKNOWN',
  'MINED_SUCCESS',
  'MINED_REVERT'
]);

const AUTHORITY_CONFIG_SIGNATURES=new Set([
  'transferOwnership(address)','acceptOwnership()','renounceOwnership()',
  'grantRole(bytes32,address)','revokeRole(bytes32,address)','renounceRole(bytes32,address)',
  'pause()','unpause()'
]);

function abiType(input){
  const type=String(input?.type??'');
  if(!type.startsWith('tuple'))return type;
  return `(${(input?.components??[]).map(abiType).join(',')})${type.slice(5)}`;
}
function signatureFromAbi(entry){return `${entry.name}(${(entry.inputs??[]).map(abiType).join(',')})`;}
function asFunction(raw){
  if(raw&&typeof raw==='object'&&raw.type==='function')return raw;
  if(typeof raw!=='string')return null;
  const s=raw.trim();
  if(!s.startsWith('function '))return null;
  const f=FunctionFragment.from(s);
  return {
    type:'function',name:f.name,stateMutability:f.stateMutability,payable:f.payable,
    inputs:f.inputs.map(x=>x.format('json')).map(JSON.parse),
    outputs:f.outputs.map(x=>x.format('json')).map(JSON.parse)
  };
}
function surfaceKind(raw){
  if(raw&&typeof raw==='object')return String(raw.type??'').toUpperCase();
  const s=String(raw??'').trim();
  if(/^receive\s*\(/.test(s))return'RECEIVE';
  if(/^fallback\s*\(/.test(s))return'FALLBACK';
  if(/^constructor\s*\(/.test(s))return'CONSTRUCTOR';
  if(/^function\s+/.test(s))return'FUNCTION';
  return'UNKNOWN';
}

export function buildCallableInventoryV2({contractId,qualifiedName,abi=[],instantiated=false}={}){
  const rows=[];
  for(const [index,raw] of abi.entries()){
    const kind=surfaceKind(raw);
    if(!['FUNCTION','RECEIVE','FALLBACK','CONSTRUCTOR'].includes(kind))continue;
    if(kind==='CONSTRUCTOR'){
      rows.push({contractId,qualifiedName,surfaceKind:kind,executionKey:`${contractId}:constructor:${index}`,signature:'constructor',stateMutability:null,disposition:'NOT_EXTERNALLY_CALLABLE'});
      continue;
    }
    const fn=kind==='FUNCTION'?asFunction(raw):null;
    const sig=kind==='FUNCTION'?signatureFromAbi(fn):kind==='RECEIVE'?'receive()':'fallback()';
    rows.push({
      contractId,qualifiedName,surfaceKind:kind,executionKey:`${contractId}:${sig}:${index}`,
      signature:sig,stateMutability:fn?.stateMutability??(String(raw?.stateMutability??'payable')),
      disposition:instantiated?'READY':'FIXTURE_GAP',
      contextRequirements:[],
      basis:'COMPILER_ABI'
    });
  }
  return rows;
}

function resourceLimit(code,detail){return{code,detail};}
function intBits(type){
  const m=String(type).match(/^(u?int)(\d+)?$/);
  return m?{signed:m[1]==='int',bits:Number(m[2]??256)}:null;
}
function bytesLength(type){
  const m=String(type).match(/^bytes(\d+)$/);
  return m?Number(m[1]):null;
}
function elementBudget(tracker,n,limits){
  if(n<0||tracker.elements+n>limits.maxTotalElements)return false;
  tracker.elements+=n;return true;
}
function generated(param,rng,ctx,tracker,depth){
  const limits=ctx.limits??{};
  if(depth>(limits.maxDepth??8))return{value:null,limitation:resourceLimit('ABI_RESOURCE_LIMIT','maximum ABI recursion depth exceeded')};
  const base=param?.baseType??param?.type;
  if(base==='array'||String(param?.type??'').endsWith(']')){
    const fixed=Number(param.arrayLength);
    const dynamic=!Number.isInteger(fixed)||fixed<0;
    const cap=Number(limits.maxDynamicArrayLength??3);
    const length=dynamic?Math.max(0,Math.min(cap,Math.floor(rng()*(cap+1)))):fixed;
    if(!elementBudget(tracker,length,limits))return{value:null,limitation:resourceLimit('ABI_RESOURCE_LIMIT','aggregate ABI element budget exceeded')};
    const out=[];
    for(let i=0;i<length;i++){
      const child=generated(param.arrayChildren,rng,ctx,tracker,depth+1);
      if(child.limitation)return child;
      out.push(child.value);
    }
    return{value:out,limitation:null};
  }
  if(base==='tuple'){
    const out=[];
    for(const component of param.components??[]){
      const child=generated(component,rng,ctx,tracker,depth+1);
      if(child.limitation)return child;
      out.push(child.value);
    }
    return{value:out,limitation:null};
  }
  const type=String(param?.type??base??'');
  const integer=intBits(type);
  if(integer){
    const bits=BigInt(integer.bits),r=Number(rng());
    if(integer.signed){
      const min=-(1n<<(bits-1n)),max=(1n<<(bits-1n))-1n;
      return{value:(r<0.5?min:max).toString(),limitation:null};
    }
    const max=(1n<<bits)-1n;
    return{value:(r<0.5?0n:max).toString(),limitation:null};
  }
  if(type==='address'){
    const addresses=(ctx.addresses??[]).filter(x=>/^0x[0-9a-fA-F]{40}$/.test(String(x)));
    return{value:addresses.length?addresses[Math.min(addresses.length-1,Math.floor(rng()*addresses.length))]:'0x0000000000000000000000000000000000000000',limitation:null};
  }
  if(type==='bool')return{value:rng()>=0.5,limitation:null};
  const n=bytesLength(type);
  if(n!==null)return{value:'0x'+('ab'.repeat(n)),limitation:null};
  if(type==='bytes'){
    const cap=Math.max(0,Number(limits.maxDynamicBytes??32)),len=Math.min(cap,Math.floor(rng()*(cap+1)));
    if(!elementBudget(tracker,len,limits))return{value:null,limitation:resourceLimit('ABI_RESOURCE_LIMIT','dynamic bytes budget exceeded')};
    return{value:'0x'+('ab'.repeat(len)),limitation:null};
  }
  if(type==='string'){
    const cap=Math.max(0,Number(limits.maxStringBytes??64)),len=Math.min(cap,Math.floor(rng()*(cap+1)));
    if(!elementBudget(tracker,len,limits))return{value:null,limitation:resourceLimit('ABI_RESOURCE_LIMIT','string budget exceeded')};
    return{value:'x'.repeat(len),limitation:null};
  }
  return{value:null,limitation:{code:'UNSUPPORTED_ABI_TYPE',type}};
}
export function generateTypedValueV2(param,rng=Math.random,ctx={}){
  const limits={
    maxDynamicArrayLength:3,maxDepth:8,maxTotalElements:64,maxDynamicBytes:32,maxStringBytes:64,
    ...(ctx.limits??{})
  };
  return generated(param,rng,{...ctx,limits},{elements:0},0);
}

function normalizedStandards(values=[]){return new Set(values.map(x=>String(x).toUpperCase().replace(/[^A-Z0-9]/g,'')));}
function functionSignatures(abi=[]){
  const out=new Set();
  for(const raw of abi){
    try{const f=asFunction(raw);if(f)out.add(signatureFromAbi(f));}catch{}
  }
  return out;
}
function hasAll(set,rows){return rows.every(x=>set.has(x));}
export function qualifyRecipeV2({qualifiedName=null,abi=[],declaredStandards=[],implementationIdentity=null}={}){
  const sigs=functionSignatures(abi),declared=normalizedStandards(declaredStandards);
  const evidence=[];
  if(declared.has('ERC20'))evidence.push({kind:'DECLARED_STANDARD',standard:'ERC20'});
  if(declared.has('ERC4626'))evidence.push({kind:'DECLARED_STANDARD',standard:'ERC4626'});
  if(declared.has('ERC3156FLASHLENDER'))evidence.push({kind:'DECLARED_STANDARD',standard:'ERC3156FLASHLENDER'});
  if(implementationIdentity)evidence.push({kind:'IMPLEMENTATION_IDENTITY',value:implementationIdentity});
  const erc20=hasAll(sigs,['totalSupply()','balanceOf(address)','transfer(address,uint256)','approve(address,uint256)','allowance(address,address)','transferFrom(address,address,uint256)']);
  const erc4626=hasAll(sigs,['asset()','totalAssets()','deposit(uint256,address)','mint(uint256,address)','withdraw(uint256,address,address)','redeem(uint256,address,address)']);
  const erc3156=hasAll(sigs,['maxFlashLoan(address)','flashFee(address,uint256)','flashLoan(address,address,uint256,bytes)']);
  if(erc3156&&declared.has('ERC3156FLASHLENDER'))return{
    status:'QUALIFIED',recipeId:'erc3156-flash-lender-v1',qualifiedName,evidence,
    functionFamilies:{'flashLoan(address,address,uint256,bytes)':'ECONOMIC'},
    observationFamilies:['TOKEN_BALANCE','CALLBACK_RECEIPT','TOTAL_SUPPLY'],
    requiredObservationFamilies:['TOKEN_BALANCE','TOTAL_SUPPLY'],
    semanticLimitations:['NO_ASSUMED_FEE_OR_BALANCE_CONSERVATION_BEYOND_OBSERVED_RECEIPTS']
  };
  if(erc4626&&declared.has('ERC4626'))return{
    status:'QUALIFIED',recipeId:'erc4626-standard-v1',qualifiedName,evidence,
    functionFamilies:{
      'deposit(uint256,address)':'ECONOMIC','mint(uint256,address)':'ECONOMIC',
      'withdraw(uint256,address,address)':'ECONOMIC','redeem(uint256,address,address)':'ECONOMIC'
    },
    observationFamilies:['TOKEN_BALANCE','SHARE_BALANCE','TOTAL_ASSETS','TOTAL_SUPPLY'],
    requiredObservationFamilies:['TOKEN_BALANCE','SHARE_BALANCE','TOTAL_ASSETS','TOTAL_SUPPLY'],
    semanticLimitations:['NO_UNIVERSAL_PRICE_OR_ASSET_SHARE_CONSERVATION_ASSERTION','YIELD_AND_FEES_REQUIRE_OBSERVED_TYPED_DELTAS']
  };
  if(erc20&&declared.has('ERC20')){
    const functionFamilies={
      'transfer(address,uint256)':'ECONOMIC','transferFrom(address,address,uint256)':'ECONOMIC',
      'approve(address,uint256)':'AUTHORITY_CONFIG'
    };
    if(sigs.has('burn(uint256)'))functionFamilies['burn(uint256)']='ECONOMIC';
    if(sigs.has('burnFrom(address,uint256)'))functionFamilies['burnFrom(address,uint256)']='ECONOMIC';
    return{
      status:'QUALIFIED',recipeId:'erc20-standard-v1',qualifiedName,evidence,
      functionFamilies,
      observationFamilies:['TOKEN_BALANCE','ALLOWANCE','TOTAL_SUPPLY'],
      requiredObservationFamilies:['TOKEN_BALANCE','TOTAL_SUPPLY'],
      semanticLimitations:['BURNS_ARE_ALLOWED_WHEN_EXPLICITLY_EXPOSED','NO_FIXED_SUPPLY_OR_FEELESS_TRANSFER_ASSUMPTION']
    };
  }
  return{
    status:'ORACLE_GAP',recipeId:null,qualifiedName,evidence,
    reason:(erc20||erc4626)?'STANDARD_LOOKING_ABI_WITHOUT_QUALIFYING_SEMANTIC_EVIDENCE':'NO_TRUSTED_RECIPE_MATCH'
  };
}

export const ACCOUNTING_MUTATION_NAME_RE_V2=/^(?:deposit|mint|stake|supply|lend|borrow|repay|withdraw|redeem|unstake|unsupply|transfer|transferFrom|burn|swap|addLiquidity|removeLiquidity|join|exit|claim|harvest|collect|distribute|accrue|settle|liquidate|donate|sync|skim|flashLoan|erc4626BufferWrapOrUnwrap)/i;

export function classifySemanticFamilyV2({signature='',stateMutability=null,recipe=null}={}){
  const mutability=['view','pure'].includes(stateMutability)?'READ_ONLY':'STATE_CHANGING';
  if(mutability==='READ_ONLY')return{declaredMutability:mutability,semanticFamily:'VIEW',basis:'ABI_STATE_MUTABILITY'};
  if(recipe?.functionFamilies?.[signature])return{declaredMutability:mutability,semanticFamily:recipe.functionFamilies[signature],basis:'QUALIFIED_RECIPE'};
  if(AUTHORITY_CONFIG_SIGNATURES.has(signature)||/^set[A-Z_]/.test(signature)||/^configure[A-Z_(]/.test(signature))return{declaredMutability:mutability,semanticFamily:'AUTHORITY_CONFIG',basis:'EXACT_AUTHORITY_CONFIGURATION_SIGNATURE'};
  if(/^multicall\(/.test(signature))return{declaredMutability:mutability,semanticFamily:'OTHER_MUTATION',basis:'KNOWN_BATCH_DISPATCH_SURFACE'};
  // Non-standard protocols (DEX vaults, routers, hooks) never match a token recipe; their deposit/swap/liquidity/fee
  // surfaces are still accounting-changing and must keep the accounting weighting and before/after accounting reads.
  if(ACCOUNTING_MUTATION_NAME_RE_V2.test(signature))return{declaredMutability:mutability,semanticFamily:'ECONOMIC',basis:'ACCOUNTING_MUTATION_NAME'};
  return{declaredMutability:mutability,semanticFamily:'UNKNOWN',basis:'NO_QUALIFIED_SEMANTIC_RECIPE'};
}

export function classifyExecutionOutcomeV2({argumentGeneration=null,preflight=null,submission=null,receipt=null}={}){
  if(argumentGeneration?.success!==true)return'NOT_EXECUTED_ENCODING_OR_PLANNING';
  if(preflight?.success!==true)return preflight?.kind==='INFRASTRUCTURE'?'SIMULATION_INFRASTRUCTURE_ERROR':'SIMULATED_REJECTION';
  if(submission?.success!==true)return'SUBMISSION_INFRASTRUCTURE_ERROR';
  if(!receipt||receipt.status===undefined||receipt.status===null)return'SUBMITTED_OUTCOME_UNKNOWN';
  return Number(receipt.status)===1?'MINED_SUCCESS':'MINED_REVERT';
}

export function observationDeltaV2(before,after){
  if(before?.status!=='OK'||after?.status!=='OK')return{status:'UNKNOWN',reason:'OBSERVATION_UNAVAILABLE'};
  if(before.quantityId!==after.quantityId||before.unit!==after.unit)return{status:'UNKNOWN',reason:'INCOMPARABLE_QUANTITIES'};
  try{return{status:'KNOWN',value:(BigInt(after.value)-BigInt(before.value)).toString()};}
  catch{return{status:'UNKNOWN',reason:'NON_INTEGER_QUANTITY'};}
}

export function assessMedusaV2({mode='DISCOVERY_ONLY',observedCalls=0,engineProperties=[],properties=[]}={}){
  const discovered=engineProperties.filter(x=>x&&typeof x.name==='string');
  const target=properties.filter(x=>x?.category==='TARGET_BEHAVIOR'&&x.discoveredByEngine===true);
  const exercised=target.filter(x=>Array.isArray(x.preconditionWitnessRefs)&&x.preconditionWitnessRefs.length>0&&Array.isArray(x.executionEvidenceRefs)&&x.executionEvidenceRefs.length>0);
  const checked=exercised.filter(x=>['CHECKED_NO_DEVIATION_OBSERVED','DEVIATION_OBSERVED'].includes(x.result));
  const deviations=checked.filter(x=>x.result==='DEVIATION_OBSERVED').length;
  let checkStatus='NOT_RUN';
  if(mode==='CHECKED_DISCOVERY'){
    if(discovered.length===0)checkStatus='NO_PROPERTY_ASSURANCE';
    else if(target.length===0||checked.length<target.length)checkStatus='PARTIAL';
    else checkStatus=deviations?'CHECK_DEVIATIONS_OBSERVED':'CHECKED';
  }else if(mode==='DISCOVERY_WITH_ORACLE_GAPS')checkStatus='ORACLE_GAP';
  return{
    capabilityContractVersion:CAPABILITY_CONTRACT_VERSION_V2,mode,
    executionStatus:Number(observedCalls)>0?'COMPLETED':'INCOMPLETE',
    coverageStatus:Number(observedCalls)>=100001?'DISCOVERY_VOLUME_MET':'DISCOVERY_VOLUME_INCOMPLETE',
    checkStatus,reachabilityStatus:checked.length?'REACHABLE':'UNKNOWN',
    observationStatus:target.some(x=>x.result==='OBSERVATION_GAP')?'PARTIAL':(target.length?'AVAILABLE':'UNAVAILABLE'),
    engineDiscoveredTests:discovered.length,targetBehaviorProperties:target.length,exercisedTargetProperties:checked.length,deviations
  };
}

export function validateTelemetryCountersV2(summary={},rows=[]){
  const counts=Object.fromEntries(TERMINAL_OUTCOMES_V2.map(x=>[x,0]));
  const indexes=new Set(),byContract={},byFunction={};
  let observationReads=0,observationFailures=0,accountingActions=0,otherActions=0,positiveTransitions=0,positiveEconomicTransitions=0;
  for(const row of rows){
    if(!TERMINAL_OUTCOMES_V2.includes(row.executionOutcome))throw new Error('unknown telemetry terminal outcome '+String(row.executionOutcome));
    if(!Number.isInteger(row.callIndex)||row.callIndex<1||row.callIndex>rows.length)throw new Error('telemetry row has invalid or missing callIndex');
    if(indexes.has(row.callIndex))throw new Error('duplicate telemetry callIndex '+row.callIndex);
    indexes.add(row.callIndex);
    if(summary.runId&&row.runId!==summary.runId)throw new Error('telemetry row runId mismatch');
    counts[row.executionOutcome]++;
    if(row.semanticFamily==='ECONOMIC')accountingActions++;else otherActions++;
    if(row.positiveTransition===true){positiveTransitions++;if(row.semanticFamily==='ECONOMIC')positiveEconomicTransitions++;}
    const observations=[...(row.observations?.before??[]),...(row.observations?.after??[])];
    observationReads+=observations.length;observationFailures+=observations.filter(x=>x?.status!=='OK').length;
    const contractKey=row.target?.qualifiedName??'UNKNOWN';
    byContract[contractKey]=(byContract[contractKey]??0)+1;
    const fnKey=`${contractKey}::${row.functionSignature??'UNKNOWN'}`;
    byFunction[fnKey]=(byFunction[fnKey]??0)+1;
  }
  for(let i=1;i<=rows.length;i++)if(!indexes.has(i))throw new Error('missing telemetry callIndex '+i);
  const infrastructureErrors=counts.SIMULATION_INFRASTRUCTURE_ERROR+counts.SUBMISSION_INFRASTRUCTURE_ERROR+counts.SUBMITTED_OUTCOME_UNKNOWN+counts.NOT_EXECUTED_ENCODING_OR_PLANNING;
  const expected={
    plannedActions:rows.length,
    terminalActions:rows.length,
    calls:rows.length,
    submittedActions:counts.MINED_SUCCESS+counts.MINED_REVERT+counts.SUBMITTED_OUTCOME_UNKNOWN,
    minedSuccess:counts.MINED_SUCCESS,
    successes:counts.MINED_SUCCESS,
    minedRevert:counts.MINED_REVERT,
    reverts:counts.MINED_REVERT,
    simulatedRejection:counts.SIMULATED_REJECTION,
    simulationInfrastructureError:counts.SIMULATION_INFRASTRUCTURE_ERROR,
    submissionInfrastructureError:counts.SUBMISSION_INFRASTRUCTURE_ERROR,
    submittedOutcomeUnknown:counts.SUBMITTED_OUTCOME_UNKNOWN,
    notExecutedEncodingOrPlanning:counts.NOT_EXECUTED_ENCODING_OR_PLANNING,
    errors:infrastructureErrors,
    accountingActions,
    otherActions,
    positiveTransitions,
    positiveEconomicTransitions,
    observationReads,
    observationFailures
  };
  for(const [key,value] of Object.entries(expected)){
    if(summary[key]!==undefined&&Number(summary[key])!==value)throw new Error(`telemetry counter mismatch ${key}: expected ${value} observed ${summary[key]}`);
  }
  const sameMap=(a,b)=>JSON.stringify(Object.fromEntries(Object.entries(a??{}).sort()))===JSON.stringify(Object.fromEntries(Object.entries(b??{}).sort()));
  const byFunctionCounts=Object.fromEntries(Object.entries(summary.byFunction??{}).map(([key,value])=>[
    key,
    value&&typeof value==='object'?Number(value.calls??value.attempts??0):Number(value)
  ]));
  if(summary.byContract&&!sameMap(summary.byContract,byContract))throw new Error('telemetry byContract reconciliation mismatch');
  if(summary.byFunction&&!sameMap(byFunctionCounts,byFunction))throw new Error('telemetry byFunction reconciliation mismatch');
  return{status:'PASS',counts,expected,byContract,byFunction};
}

export function migrateLegacyCapabilityV2(summary={}){
  return{
    capabilityContractVersion:CAPABILITY_CONTRACT_VERSION_V2,
    legacyDisposition:'LEGACY_LIMITED',
    sourceSchemaVersion:summary.schemaVersion??null,
    executionStatus:summary.medusa?.observedCalls>0?'COMPLETED':'INCOMPLETE',
    coverageStatus:Number(summary.medusa?.observedCalls??0)>=100001?'DISCOVERY_VOLUME_RECORDED':'UNKNOWN',
    checkStatus:'NO_PROPERTY_ASSURANCE',
    reachabilityStatus:'UNKNOWN',
    observationStatus:'LEGACY_INADEQUATE',
    limitations:[
      'LEGACY_MEDUSA_QUANTITY_DOES_NOT_ESTABLISH_PROPERTY_ASSURANCE',
      'LEGACY_TELEMETRY_TERMINAL_OUTCOMES_AND_OBSERVATION_QUALITY_NOT_RECONSTRUCTIBLE'
    ]
  };
}
