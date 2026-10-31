import {Contract} from 'ethers';

const ABI_TYPES=/^(address|bool|bytes32|u?int(?:[0-9]{1,3})?)$/;
const ERROR='curveyield-deployed-state-snapshot-v1';
const textValue=(value)=>typeof value==='bigint'?value.toString():typeof value==='string'?value:
  Array.isArray(value)?JSON.stringify(value.map(textValue)):value===null?'null':String(value);
function readArtifacts(artifacts,qualified) {
  if(artifacts instanceof Map)return artifacts.get(qualified);
  return artifacts?.[qualified];
}
function rowFor(row) {
  return {contract:row.qualifiedName,address:row.address};
}
export async function captureDeployedStateSnapshotV1({provider,deployedContracts,artifactByQualified,maxCallsPerContract=50}={}) {
  const rows=[];
  try {
    if(!Array.isArray(deployedContracts)||!deployedContracts.length)
      return {schemaVersion:ERROR,status:'NO_DEPLOYMENT_ADDRESSES',rows};
    for(const deployed of [...deployedContracts].sort((a,b)=>String(a.qualifiedName??'').localeCompare(String(b.qualifiedName??''))||
      String(a.address??'').localeCompare(String(b.address??'')))) {
      if(!deployed.address||!deployed.qualifiedName)continue;
      const artifact=readArtifacts(artifactByQualified,deployed.qualifiedName);
      if(!artifact)continue;
      const abi=artifact.abi??artifact.output?.abi??[];
      let called=0;
      for(const fragment of abi) {
        if(called>=maxCallsPerContract)break;
        if(fragment.type!=='function'||!['view','pure'].includes(fragment.stateMutability)||
          (fragment.inputs??[]).length!==0||!(fragment.outputs??[]).length||
          !(fragment.outputs??[]).every(x=>ABI_TYPES.test(x.type??'')))continue;
        called++;
        const row={...rowFor(deployed),function:fragment.name,result:null,status:'ERROR'};
        let timer;
        try {
          const contract=new Contract(deployed.address,[fragment],provider);
          const call=contract.getFunction(fragment.name).staticCall();
          const result=await Promise.race([call,new Promise((_,reject)=>{
            timer=setTimeout(()=>reject(Object.assign(new Error('snapshot read timed out'),{code:'ADR_TIMEOUT'})),5000);
          })]);
          row.result=textValue(result);
          row.status='OK';
        }catch(error) {
          row.status=error?.code==='ADR_TIMEOUT'?'TIMEOUT':
            error?.code==='CALL_EXCEPTION'||/revert/i.test(String(error?.message??''))?'REVERTED':'ERROR';
        }finally{if(timer)clearTimeout(timer);}
        rows.push(row);
      }
    }
    return {schemaVersion:ERROR,status:rows.length?'CAPTURED':'NO_DEPLOYMENT_ADDRESSES',rows};
  }catch(error) {
    return {schemaVersion:ERROR,status:'ERROR',rows,error:String(error?.message??error).slice(0,2000)};
  }
}
