import { validateDeepAssuranceRequestV2 } from './schema.mjs';
import { validateV26RequestConfigurationV1 } from './v26-request-config-v1.mjs';

export function validateDeepAssuranceRequestWithV26V1(input){
  if(!input||typeof input!=='object'||Array.isArray(input)) return validateDeepAssuranceRequestV2(input);
  const hasV26=Object.prototype.hasOwnProperty.call(input.configuration??{},'v26');
  if(!hasV26) return validateDeepAssuranceRequestV2(input);
  const v26=input.configuration.v26;
  const legacy=structuredClone(input);
  delete legacy.configuration.v26;
  const validated=validateDeepAssuranceRequestV2(legacy);
  validated.configuration.v26=validateV26RequestConfigurationV1(v26,{phaseId:input.phaseId});
  const forkState=validated.configuration.v26?.phase0ForkState;
  if(forkState&&(
    forkState.campaignId!==validated.campaignId||
    forkState.sourceSha256!==validated.source.archiveSha256||
    forkState.finalBlock!==validated.configuration.simulation?.block||
    forkState.chainId!==({ethereum:1,base:8453,katana:747474}[validated.configuration.simulation?.chain])||
    String(forkState.hardfork).toLowerCase()!==String(validated.configuration.evmVersion??'').toLowerCase()))
    throw new Error('Phase-0 fork state campaign and exact source mismatch');

  return validated;
}
