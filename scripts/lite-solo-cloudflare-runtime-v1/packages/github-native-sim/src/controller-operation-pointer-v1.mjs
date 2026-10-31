const SCHEMA_VERSION='audit-controller-operation-pointer-v1';
const PROCESS_ID='audit-v7-independent-review';
const CONTROLLER_REPOSITORY='curveyield3/Audit-Controller';

function fail(message){throw new Error(`Controller operation pointer v1: ${message}`);}
function safePath(value,label){
  if(typeof value!=='string'||!value)fail(`${label} is required`);
  if(value.startsWith('/')||value.includes('\\')||value.split('/').some((segment)=>!segment||segment==='.'||segment==='..'))fail(`${label} must be a safe relative path`);
  return value;
}

export function validateControllerOperationPointerV1(input){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('request must be an object');
  const allowed=new Set(['schemaVersion','processId','requestId','controller','verifyController']);
  for(const key of Object.keys(input))if(!allowed.has(key))fail(`${key} is unsupported`);
  if(input.schemaVersion!==SCHEMA_VERSION)fail('schemaVersion mismatch');
  if(input.processId!==PROCESS_ID)fail('processId mismatch');
  if(typeof input.requestId!=='string'||!/^[A-Za-z0-9._-]{1,160}$/.test(input.requestId))fail('requestId is invalid');
  if(!input.controller||typeof input.controller!=='object'||Array.isArray(input.controller))fail('controller is required');
  const controllerKeys=new Set(['repository','commit','requestPath']);
  for(const key of Object.keys(input.controller))if(!controllerKeys.has(key))fail(`controller.${key} is unsupported`);
  if(input.controller.repository!==CONTROLLER_REPOSITORY)fail('controller.repository mismatch');
  if(typeof input.controller.commit!=='string'||!/^[0-9a-f]{40}$/.test(input.controller.commit))fail('controller.commit must be exact 40-hex commit');
  const requestPath=safePath(input.controller.requestPath,'controller.requestPath');
  const expected=`.deep-assurance/operator/requests/${input.requestId}.json`;
  if(requestPath!==expected)fail(`controller.requestPath must equal ${expected}`);
  if(input.verifyController!==undefined&&typeof input.verifyController!=='boolean')fail('verifyController must be boolean');
  return {
    schemaVersion:SCHEMA_VERSION,
    processId:PROCESS_ID,
    requestId:input.requestId,
    controller:{
      repository:CONTROLLER_REPOSITORY,
      commit:input.controller.commit,
      requestPath,
    },
    verifyController:input.verifyController===true,
  };
}
