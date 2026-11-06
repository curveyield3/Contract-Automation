const DIGEST=/^[0-9a-f]{64}$/;
const ADDRESS=/^0x[0-9a-fA-F]{40}$/;
const SLOT=/^0x[0-9a-fA-F]{64}$/;
const CAMPAIGN_CLASSES=new Set(['discovery','property','targeted','stateful','boundary-dictionary','multi-actor','ghost-reference','differential','deep-escalation']);
function obj(v,path){ if(!v||typeof v!=='object'||Array.isArray(v)) throw new Error(`${path} must be an object`); return v; }
function bool(v,path){ if(typeof v!=='boolean') throw new Error(`${path} must be boolean`); }
function digest(v,path){ if(typeof v!=='string'||!DIGEST.test(v)) throw new Error(`${path} must be a 64-hex digest`); }
function string(v,path){ if(typeof v!=='string'||!v.trim()) throw new Error(`${path} must be a non-empty string`); }
function only(v,allowed,path){ for(const k of Object.keys(v)) if(!allowed.has(k)) throw new Error(`${path}.${k} is not allowed`); }
function validateObservation(type,o){
  obj(o,'configuration.v26.reproduction.expectedObservation');
  if(type==='MEDUSA_PROPERTY'){
    only(o,new Set(['propertyName','propertyStatus']),'configuration.v26.reproduction.expectedObservation'); string(o.propertyName,'configuration.v26.reproduction.expectedObservation.propertyName'); if(!['passed','failed'].includes(o.propertyStatus)) throw new Error('Medusa reproduction propertyStatus must be passed or failed');
  } else if(type==='FOUNDRY_TEST'){
    only(o,new Set(['componentStatus']),'configuration.v26.reproduction.expectedObservation'); if(!['COMPLETED','COMPLETED_WITH_FAILURES','FAILED'].includes(o.componentStatus)) throw new Error('Foundry reproduction componentStatus invalid');
  } else {
    only(o,new Set(['stepLabel','stepStatus']),'configuration.v26.reproduction.expectedObservation'); string(o.stepLabel,'configuration.v26.reproduction.expectedObservation.stepLabel'); if(!['completed','failed','PASS','FAIL'].includes(o.stepStatus)) throw new Error('Anvil reproduction stepStatus invalid');
  }
}
function validateCoverageObligation(o,i){
  const p=`configuration.v26.foundryCoverageObligations[${i}]`; obj(o,p);
  if(o.type==='FILE_PRESENT'){only(o,new Set(['type','path']),p);string(o.path,`${p}.path`);return;}
  if(o.type==='FUNCTION_COVERED'){only(o,new Set(['type','source','function']),p);string(o.source,`${p}.source`);string(o.function,`${p}.function`);return;}
  if(o.type==='MINIMUM_METRIC'){only(o,new Set(['type','metric','minimumPercent']),p);if(!['lines','statements','branches','functions'].includes(o.metric))throw new Error(`${p}.metric invalid`);if(typeof o.minimumPercent!=='number'||!Number.isFinite(o.minimumPercent)||o.minimumPercent<0||o.minimumPercent>100)throw new Error(`${p}.minimumPercent must be 0-100`);return;}
  throw new Error('unsupported Foundry coverage obligation');
}
function nullableAddress(v,path){if(v!==null&&v!==undefined&&(!ADDRESS.test(v)))throw new Error(`${path} must be address or null`);}
function nullableSlot(v,path){if(v!==null&&v!==undefined&&(!SLOT.test(v)))throw new Error(`${path} must be 32-byte slot or null`);}
function validateAttestation(a){
  const p='configuration.v26.liveDeploymentAttestation'; obj(a,p); only(a,new Set(['chain','deployments']),p); if(a.chain!=='ethereum')throw new Error('v26 live attestation currently supports ethereum only'); if(!Array.isArray(a.deployments)||a.deployments.length===0)throw new Error('live deployment attestation deployments required');
  for(const [i,d] of a.deployments.entries()){
    const dp=`${p}.deployments[${i}]`;obj(d,dp);only(d,new Set(['label','address','expectedRuntimeBytecodeSha256','proxy','criticalReads']),dp);string(d.label,`${dp}.label`);if(!ADDRESS.test(d.address??''))throw new Error(`${dp}.address invalid`);if(d.expectedRuntimeBytecodeSha256!==null&&d.expectedRuntimeBytecodeSha256!==undefined)digest(d.expectedRuntimeBytecodeSha256,`${dp}.expectedRuntimeBytecodeSha256`);
    const proxy=obj(d.proxy,`${dp}.proxy`);only(proxy,new Set(['kind','expectedImplementation','expectedAdmin','implementationSlot','adminSlot','beaconSlot']),`${dp}.proxy`);if(!['NONE','EIP1967','BEACON','CUSTOM_DECLARED'].includes(proxy.kind))throw new Error(`${dp}.proxy.kind invalid`);nullableAddress(proxy.expectedImplementation,`${dp}.proxy.expectedImplementation`);nullableAddress(proxy.expectedAdmin,`${dp}.proxy.expectedAdmin`);nullableSlot(proxy.implementationSlot,`${dp}.proxy.implementationSlot`);nullableSlot(proxy.adminSlot,`${dp}.proxy.adminSlot`);nullableSlot(proxy.beaconSlot,`${dp}.proxy.beaconSlot`);if(proxy.kind==='CUSTOM_DECLARED'&&!proxy.implementationSlot&&!proxy.adminSlot&&!proxy.beaconSlot)throw new Error(`${dp}.proxy custom slots must be declared`);
    if(!Array.isArray(d.criticalReads))throw new Error(`${dp}.criticalReads must be array`);for(const [j,r] of d.criticalReads.entries()){const rp=`${dp}.criticalReads[${j}]`;obj(r,rp);only(r,new Set(['function','args','expected','comparison']),rp);string(r.function,`${rp}.function`);if(!Array.isArray(r.args))throw new Error(`${rp}.args must be array`);if(!['EQUALS','NONZERO','ADDRESS_EQUALS'].includes(r.comparison))throw new Error(`${rp}.comparison invalid`);if(!['string','number','boolean'].includes(typeof r.expected)&&r.expected!==null)throw new Error(`${rp}.expected invalid`);}
  }
}

export function validateV26RequestConfigurationV1(v26,{phaseId}={}){
  if(v26===undefined) return undefined; obj(v26,'configuration.v26');
  only(v26,new Set(['phaseContractDigest','phase6CampaignPlan','foundryCoverageObligations','foundryRefinementRequired','foundryRunType','foundryRefinementOf','foundryBasisEvidenceIds','sbomRequired','liveDeploymentAttestation','simulationLedgerRequired','reproduction','phase0ForkState']),'configuration.v26');
  if(v26.phaseContractDigest!==undefined) digest(v26.phaseContractDigest,'configuration.v26.phaseContractDigest');
  if(v26.phase0ForkState!==undefined){
    const p='configuration.v26.phase0ForkState',state=obj(v26.phase0ForkState,p);
    only(state,new Set(['manifestRef','sha256','sourceSha256','campaignId','chainId','finalBlock','hardfork']),p);
    if(phaseId!=='fork-simulation-lifecycle')throw new Error('Phase-0 fork state reuse requires Anvil workflow');
    if(!/^campaigns\/[^/]+\/evidence\/phase0\/PHASE0_FORK_STATE_MANIFEST_v1\.json$/.test(state.manifestRef??''))
      throw new Error(p+'.manifestRef must be a campaign-bound state manifest');
    digest(state.sha256,p+'.sha256');digest(state.sourceSha256,p+'.sourceSha256');
    string(state.campaignId,p+'.campaignId');
    string(state.hardfork,p+'.hardfork');
    if(!Number.isSafeInteger(state.chainId)||state.chainId<1||
      !Number.isSafeInteger(state.finalBlock)||state.finalBlock<0)
      throw new Error(p+' requires valid chainId and finalBlock');
  }

  if(v26.sbomRequired!==undefined){bool(v26.sbomRequired,'configuration.v26.sbomRequired');if(v26.sbomRequired&&phaseId!=='build-and-test')throw new Error('v26 SBOM generation is build-and-test only');}
  if(v26.simulationLedgerRequired!==undefined){bool(v26.simulationLedgerRequired,'configuration.v26.simulationLedgerRequired');if(v26.simulationLedgerRequired&&phaseId!=='fork-simulation-lifecycle')throw new Error('v26 simulation ledger is Phase 7 only');}
  if(v26.foundryRefinementRequired!==undefined){bool(v26.foundryRefinementRequired,'configuration.v26.foundryRefinementRequired');if(phaseId!=='build-and-test')throw new Error('v26 Foundry refinement evidence is Phase 6 only');}
  if(v26.foundryRunType!==undefined&&!['baseline','refinement'].includes(v26.foundryRunType)) throw new Error('configuration.v26.foundryRunType must be baseline or refinement');
  if(v26.foundryRefinementOf!==undefined&&v26.foundryRefinementOf!==null) string(v26.foundryRefinementOf,'configuration.v26.foundryRefinementOf');
  if(v26.foundryBasisEvidenceIds!==undefined&&(!Array.isArray(v26.foundryBasisEvidenceIds)||v26.foundryBasisEvidenceIds.some(x=>typeof x!=='string'||!x))) throw new Error('configuration.v26.foundryBasisEvidenceIds must contain non-empty strings');
  if(v26.foundryRunType==='refinement'&&!v26.foundryRefinementOf) throw new Error('Foundry refinement run requires foundryRefinementOf');
  if(v26.phase6CampaignPlan!==undefined){
    if(phaseId!=='build-and-test') throw new Error('configuration.v26.phase6CampaignPlan is Phase 6 only');
    obj(v26.phase6CampaignPlan,'configuration.v26.phase6CampaignPlan'); only(v26.phase6CampaignPlan,new Set(['sourceSnapshotDigest','harnessBundleDigest','requiredCampaignClasses','refinementRequired','deepEscalationRequired','activeCampaignClass','runOrdinal','refinementOf','configurationDigest']),'configuration.v26.phase6CampaignPlan');
    digest(v26.phase6CampaignPlan.sourceSnapshotDigest,'configuration.v26.phase6CampaignPlan.sourceSnapshotDigest'); digest(v26.phase6CampaignPlan.harnessBundleDigest,'configuration.v26.phase6CampaignPlan.harnessBundleDigest');
    if(!Array.isArray(v26.phase6CampaignPlan.requiredCampaignClasses)||v26.phase6CampaignPlan.requiredCampaignClasses.length===0||v26.phase6CampaignPlan.requiredCampaignClasses.some(x=>!CAMPAIGN_CLASSES.has(x))) throw new Error('configuration.v26.phase6CampaignPlan.requiredCampaignClasses invalid');
    bool(v26.phase6CampaignPlan.refinementRequired,'configuration.v26.phase6CampaignPlan.refinementRequired'); bool(v26.phase6CampaignPlan.deepEscalationRequired,'configuration.v26.phase6CampaignPlan.deepEscalationRequired');
    if(!CAMPAIGN_CLASSES.has(v26.phase6CampaignPlan.activeCampaignClass)) throw new Error('configuration.v26.phase6CampaignPlan.activeCampaignClass invalid');
    if(!v26.phase6CampaignPlan.requiredCampaignClasses.includes(v26.phase6CampaignPlan.activeCampaignClass)) throw new Error('activeCampaignClass must be required by the campaign plan');
    if(!Number.isInteger(v26.phase6CampaignPlan.runOrdinal)||v26.phase6CampaignPlan.runOrdinal<1) throw new Error('configuration.v26.phase6CampaignPlan.runOrdinal must be positive integer');
    if(v26.phase6CampaignPlan.refinementOf!==undefined&&v26.phase6CampaignPlan.refinementOf!==null) string(v26.phase6CampaignPlan.refinementOf,'configuration.v26.phase6CampaignPlan.refinementOf');
    digest(v26.phase6CampaignPlan.configurationDigest,'configuration.v26.phase6CampaignPlan.configurationDigest');
    if(v26.phase6CampaignPlan.runOrdinal>1&&!v26.phase6CampaignPlan.refinementOf) throw new Error('Phase 6 campaign rerun requires refinementOf');
  }
  if(v26.foundryCoverageObligations!==undefined){if(phaseId!=='build-and-test')throw new Error('v26 Foundry coverage obligations are Phase 6 only');if(!Array.isArray(v26.foundryCoverageObligations))throw new Error('configuration.v26.foundryCoverageObligations must be an array');v26.foundryCoverageObligations.forEach(validateCoverageObligation);}
  if(v26.liveDeploymentAttestation!==undefined){if(phaseId!=='fork-simulation-lifecycle')throw new Error('live deployment attestation is Phase 7 only');validateAttestation(v26.liveDeploymentAttestation);}
  if(v26.reproduction!==undefined){
    obj(v26.reproduction,'configuration.v26.reproduction'); only(v26.reproduction,new Set(['candidateId','reproductionType','expectedObservation']),'configuration.v26.reproduction');
    if(!['FOUNDRY_TEST','MEDUSA_PROPERTY','ANVIL_WORKFLOW'].includes(v26.reproduction.reproductionType)) throw new Error('unsupported reproductionType'); string(v26.reproduction.candidateId,'configuration.v26.reproduction.candidateId'); validateObservation(v26.reproduction.reproductionType,v26.reproduction.expectedObservation);
    if(v26.reproduction.reproductionType==='ANVIL_WORKFLOW'&&phaseId!=='fork-simulation-lifecycle')throw new Error('Anvil candidate reproduction must use Phase 7 lifecycle execution');
    if(['FOUNDRY_TEST','MEDUSA_PROPERTY'].includes(v26.reproduction.reproductionType)&&phaseId!=='build-and-test')throw new Error('Foundry/Medusa candidate reproduction must use Phase 6 execution evidence');
  }
  return structuredClone(v26);
}
