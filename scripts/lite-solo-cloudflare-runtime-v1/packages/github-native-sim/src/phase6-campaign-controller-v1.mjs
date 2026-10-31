import { digestCanonicalV1 } from './canonical-json-v1.mjs';

export const PHASE6_CAMPAIGN_CLASSES_V1=Object.freeze(['discovery','property','targeted','stateful','boundary-dictionary','multi-actor','ghost-reference','differential','deep-escalation']);
const TERMINAL=new Set(['COMPLETED','COMPLETED_WITH_FAILURES','FAILED','PROPERTY_FALSIFICATION','NO_TESTS_DISCOVERED']);
function clone(v){ return structuredClone(v); }
function assertDigest(v,name){ if(typeof v!=='string'||!/^[0-9a-f]{64}$/.test(v)) throw new Error(`${name} must be a 64-hex digest`); }
function normalizeMetricGroup(value){
  if(value && typeof value==='object' && ['PRESENT','UNAVAILABLE_FROM_OUTPUT_MODE','PARSE_FAILED'].includes(value.status)) return clone(value);
  if(value && typeof value==='object' && Object.keys(value).length>0) return {status:'PRESENT',data:clone(value)};
  return {status:'UNAVAILABLE_FROM_OUTPUT_MODE',data:null};
}

export function createPhase6CampaignPlanV1({sourceSnapshotDigest,harnessBundleDigest,requiredCampaignClasses=[],refinementRequired=false,deepEscalationRequired=false}={}){
  assertDigest(sourceSnapshotDigest,'sourceSnapshotDigest'); assertDigest(harnessBundleDigest,'harnessBundleDigest');
  for(const c of requiredCampaignClasses) if(!PHASE6_CAMPAIGN_CLASSES_V1.includes(c)) throw new Error(`unsupported campaign class ${c}`);
  const required=[...new Set(requiredCampaignClasses)]; if(deepEscalationRequired&&!required.includes('deep-escalation')) required.push('deep-escalation');
  return {schemaVersion:'audit-v7-phase6-campaign-plan-v1',sourceSnapshotDigest,harnessBundleDigest,requiredCampaignClasses:required.sort(),refinementRequired:refinementRequired===true,deepEscalationRequired:deepEscalationRequired===true,campaigns:[]};
}

export function recordPhase6CampaignV1(state,input){
  const next=clone(state); if(!PHASE6_CAMPAIGN_CLASSES_V1.includes(input?.campaignClass)) throw new Error('unsupported campaign class');
  if(!['medusa','foundry'].includes(input?.engine)) throw new Error('engine must be medusa or foundry');
  if(input.sourceSnapshotDigest!==state.sourceSnapshotDigest) throw new Error('source snapshot digest mismatch');
  if(input.harnessBundleDigest!==state.harnessBundleDigest && !input.refinementOf) throw new Error('harness bundle digest mismatch');
  if(next.campaigns.some(c=>c.campaignId===input.campaignId)) throw new Error('duplicate campaignId');
  if(input.engine==='foundry'){
    const missingMedusa=state.requiredCampaignClasses.filter(c=>c!=='deep-escalation'&&!state.campaigns.some(x=>x.engine==='medusa'&&x.campaignClass===c&&TERMINAL.has(x.terminalStatus)));
    if(missingMedusa.length) throw new Error(`Medusa terminal ordering prerequisite missing: ${missingMedusa.join(', ')}`);
  }
  if(input.refinementOf){
    const prior=state.campaigns.find(c=>c.campaignId===input.refinementOf); if(!prior) throw new Error('refinementOf campaign does not exist');
    if(input.runOrdinal<=prior.runOrdinal) throw new Error('refinement runOrdinal must increase');
    if(input.configurationDigest===prior.configurationDigest && input.harnessBundleDigest===prior.harnessBundleDigest) throw new Error('refinement must use changed configuration or harness digest');
  }
  const normalized={...clone(input),corpus:normalizeMetricGroup(input.corpus),coverage:normalizeMetricGroup(input.coverage),statistics:normalizeMetricGroup(input.statistics),authoritativeFinding:false};
  normalized.campaignDigest=digestCanonicalV1(normalized);
  next.campaigns.push(normalized); return next;
}

export function evaluatePhase6CampaignPlanV1(state){
  const missingCampaignClasses=state.requiredCampaignClasses.filter(c=>!state.campaigns.some(x=>x.campaignClass===c&&TERMINAL.has(x.terminalStatus)));
  if(missingCampaignClasses.length) return {status:'INCOMPLETE',missingCampaignClasses};
  if(state.deepEscalationRequired&&!state.campaigns.some(x=>x.campaignClass==='deep-escalation'&&TERMINAL.has(x.terminalStatus))) return {status:'DEEP_ESCALATION_REQUIRED',missingCampaignClasses:['deep-escalation']};
  if(state.refinementRequired&&!state.campaigns.some(x=>typeof x.refinementOf==='string'&&x.refinementOf.length>0&&TERMINAL.has(x.terminalStatus))) return {status:'REFINEMENT_REQUIRED',missingCampaignClasses:[]};
  return {status:'PASS',missingCampaignClasses:[]};
}
