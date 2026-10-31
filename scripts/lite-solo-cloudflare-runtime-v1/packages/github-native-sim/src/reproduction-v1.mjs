import { canonicalJsonV1, digestCanonicalV1 } from './canonical-json-v1.mjs';
const TERMINAL=new Set(['REPRODUCED','NOT_REPRODUCED','INCONCLUSIVE','EXECUTION_FAILED']);
function same(a,b){ return canonicalJsonV1(a)===canonicalJsonV1(b); }
export function computeCandidateReproductionDigestV1(result){ const copy=structuredClone(result); delete copy.reproductionDigest; return digestCanonicalV1(copy); }
export function normalizeCandidateReproductionV1(input,{expectedSourceIdentity=null}={}){
  if(!input||typeof input!=='object') throw new Error('candidate reproduction input is required');
  if(typeof input.candidateId!=='string'||!input.candidateId) throw new Error('candidateId is required');
  if(!TERMINAL.has(input.status)) throw new Error(`unsupported reproduction status: ${input.status}`);
  if(!input.sourceIdentity) throw new Error('source identity is required');
  if(expectedSourceIdentity&&!same(input.sourceIdentity,expectedSourceIdentity)) throw new Error('source identity mismatch');
  const result={schemaVersion:'audit-v7-candidate-reproduction-v1',candidateId:input.candidateId,status:input.status,sourceIdentity:structuredClone(input.sourceIdentity),engine:input.engine??({FOUNDRY_TEST:'foundry',MEDUSA_PROPERTY:'medusa',ANVIL_WORKFLOW:'anvil'}[input.reproductionType]??null),evidenceReferences:[...(input.evidenceReferences??[])],observedPredicate:structuredClone(input.observedPredicate??null),rawArtifactRefs:[...(input.rawArtifactRefs??[])],authoritativeFinding:false};
  return {...result,reproductionDigest:computeCandidateReproductionDigestV1(result)};
}

export async function executeCandidateReproductionV1(spec,{executeFoundry,executeMedusa,executeAnvil}={}){
  const runner={FOUNDRY_TEST:executeFoundry,MEDUSA_PROPERTY:executeMedusa,ANVIL_WORKFLOW:executeAnvil}[spec?.reproductionType];
  if(typeof runner!=='function') return normalizeCandidateReproductionV1({candidateId:spec?.candidateId,sourceIdentity:spec?.sourceIdentity,reproductionType:spec?.reproductionType,engine:null,status:'EXECUTION_FAILED',evidenceReferences:[],observedPredicate:{matched:false,reason:'execution adapter unavailable'},rawArtifactRefs:[]});
  try{
    const observed=await runner(spec); const matched=observed?.matched===true;
    const status=observed?.inconclusive===true?'INCONCLUSIVE':matched?'REPRODUCED':'NOT_REPRODUCED';
    return normalizeCandidateReproductionV1({candidateId:spec.candidateId,sourceIdentity:spec.sourceIdentity,reproductionType:spec.reproductionType,engine:observed?.engine,evidenceReferences:observed?.evidenceReferences??[],observedPredicate:observed?.predicate??{matched},rawArtifactRefs:observed?.rawArtifactRefs??[],status});
  }catch(error){ return normalizeCandidateReproductionV1({candidateId:spec.candidateId,sourceIdentity:spec.sourceIdentity,reproductionType:spec.reproductionType,engine:null,evidenceReferences:[],observedPredicate:{matched:false,error:error.message},rawArtifactRefs:[],status:'EXECUTION_FAILED'}); }
}
