import { digestCanonicalV1 } from './canonical-json-v1.mjs';
function withoutDigest(v,key){ const x=structuredClone(v); delete x[key]; return x; }
export function computeSimulationLifecycleLedgerDigestV1(ledger){ return digestCanonicalV1(withoutDigest(ledger,'ledgerDigest')); }
export function buildSimulationLifecycleLedgerV1({request,build,simulation,deploymentGasEvidence,attestation}){
  const steps=simulation?.steps??[]; const segments=(simulation?.segments??[]).length?simulation.segments:[{recipeId:request?.configuration?.simulation?.recipeId??null,label:'simulation workflow',stepIndexes:steps.map((_,i)=>i)}];
  const simulations=segments.map((segment,index)=>{
    const selected=(segment.stepIndexes??[]).map(i=>steps[i]).filter(Boolean); const status=selected.some(s=>s.status==='FAIL'||s.status==='FAILED')?'FAIL':'PASS';
    const affectedContracts=[...new Set(selected.flatMap(s=>s.affectedContracts??[]))].sort();
    const obligationsSatisfied=[...new Set(selected.filter(s=>String(s.action??'').startsWith('assert')||String(s.label??'').toLowerCase().includes('assert')).flatMap(s=>s.obligationsSatisfied??[]))].sort();
    const evidenceDigest=digestCanonicalV1({recipeId:segment.recipeId??null,label:segment.label??null,stepIndexes:[...(segment.stepIndexes??[])],steps:selected});
    return {simId:`SIM-${String(index+1).padStart(3,'0')}`,recipeId:segment.recipeId??null,label:segment.label??null,stepIndexes:[...(segment.stepIndexes??[])],status,evidenceDigest,affectedContracts,obligationsSatisfied};
  });
  const fork=simulation?.fork??{};
  const ledger={schemaVersion:'audit-v7-simulation-lifecycle-ledger-v1',sourceIdentity:structuredClone(request?.sourceIdentity??request?.source??null),requestDigest:request?.requestDigest??null,fork:{chain:fork.chain??'ethereum',chainId:fork.chainId??1,blockNumber:fork.blockNumber??null,blockHash:fork.blockHash??null,engine:'anvil'},simulations,deploymentGasEvidenceDigest:deploymentGasEvidence?.deploymentGasEvidenceDigest??deploymentGasEvidence?.digest??null,attestationDigest:attestation?.attestationDigest??null};
  return {...ledger,ledgerDigest:computeSimulationLifecycleLedgerDigestV1(ledger)};
}
