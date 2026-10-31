import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// A v13 authority is not eligible for production until an independent private
// seed evaluation is recorded. This tiny release decision is not a reviewer
// work form and never includes the sealed answer-key manifest.
export const ADR_V13_RELEASE_RECEIPT_V1='process/qualification/adr-v13/QUALIFICATION_PASS_v1.json';
export const ADR_V13_RELEASE_SCORE_V1='process/qualification/adr-v13/QUALIFICATION_SCORE_v1.json';
const sha=/^[0-9a-f]{64}$/;

/**
 * Reduce the adjudicator's PRIVATE score to a public, identity-free release
 * proof. Class/contract names, per-stage labels, case IDs, all raw findings
 * and hidden truth never enter the GitHub authority checkout.
 */
export function publicV13QualificationScoreV1(privateScore){
 if(privateScore?.schemaVersion!=='curveyield-seeded-detection-score-v1'||
    privateScore?.defectCount!==41||
    !Number.isSafeInteger(privateScore?.caught)||privateScore.caught<30||
    privateScore.caught>41||privateScore.decoysFlagged!==0||
    privateScore.cleanControlCriticalHighFalsePositiveCount!==0||
    privateScore.gate?.passed!==true||
    !Number.isSafeInteger(privateScore.gate?.requiredCaught)||
    privateScore.gate.requiredCaught<30||privateScore.gate.maxDecoys!==0)
    throw new Error('V13_QUALIFICATION_REQUIRED: private report fails release thresholds');
 return{
  schemaVersion:'curveyield-seeded-detection-score-v1',
  defectCount:41,caught:privateScore.caught,
  decoysFlagged:0,cleanControlCriticalHighFalsePositiveCount:0,
  gate:{passed:true,requiredCaught:privateScore.gate.requiredCaught,maxDecoys:0}
 };
}

export function verifyV13ReleaseV1({repoRoot,receipt=null}={}){
 const row=receipt??(()=>{
   if(!repoRoot)throw new Error('v13 qualification requires automation repository root');
   const file=path.join(repoRoot,...ADR_V13_RELEASE_RECEIPT_V1.split('/'));
   if(!fs.existsSync(file))throw new Error('V13_QUALIFICATION_REQUIRED: private seeded campaign is not independently qualified');
   return JSON.parse(fs.readFileSync(file,'utf8'));
 })();
 if(row?.schemaVersion!=='curveyield-adr-v13-qualification-pass-v1'||
    row?.status!=='QUALIFIED'||row?.seededDefects!==41||
    row?.baselineCaught!==14||!Number.isSafeInteger(row?.caught)||row.caught<30||row.caught>41||
    row?.decoysFlagged!==0||row?.cleanControlCriticalHighFalsePositives!==0||
    typeof row?.independentRunId!=='string'||!row.independentRunId.trim()||
    !sha.test(row?.scoreSha256??'')||
    typeof row?.reviewedBy!=='string'||!row.reviewedBy.trim())
    throw new Error('V13_QUALIFICATION_REQUIRED: missing or failed independent 41-defect / zero-decoy release decision');
 if(repoRoot){
   // A signed-off receipt is never enough by itself. Its published, aggregate
   // result must exist and agree byte-for-byte with the reviewed score digest.
   const scoreFile=path.join(repoRoot,...ADR_V13_RELEASE_SCORE_V1.split('/'));
   if(!fs.existsSync(scoreFile))
     throw new Error('V13_QUALIFICATION_REQUIRED: aggregate score evidence is missing');
   const bytes=fs.readFileSync(scoreFile);
   if(createHash('sha256').update(bytes).digest('hex')!==row.scoreSha256)
     throw new Error('V13_QUALIFICATION_REQUIRED: score SHA-256 does not match review decision');
   let score;
   try{score=JSON.parse(bytes.toString('utf8'));}
   catch{throw new Error('V13_QUALIFICATION_REQUIRED: aggregate score JSON invalid');}
   const publicKeys=['caught','cleanControlCriticalHighFalsePositiveCount',
     'decoysFlagged','defectCount','gate','schemaVersion'].sort();
   const gateKeys=['maxDecoys','passed','requiredCaught'].sort();
   // Reject a raw private scorer report masquerading as the public artifact:
   // even aggregate contract/class or leak-stage names disclose hidden seeds.
   const publicOnly=score&&typeof score==='object'&&!Array.isArray(score)&&
     JSON.stringify(Object.keys(score).sort())===JSON.stringify(publicKeys)&&
     score.gate&&typeof score.gate==='object'&&!Array.isArray(score.gate)&&
     JSON.stringify(Object.keys(score.gate).sort())===JSON.stringify(gateKeys);
   if(!publicOnly)
     throw new Error('V13_QUALIFICATION_REQUIRED: forbidden private score fields');
   if(score?.schemaVersion!=='curveyield-seeded-detection-score-v1'||
     score?.defectCount!==41||score.caught!==row.caught||
     score.decoysFlagged!==0||score.cleanControlCriticalHighFalsePositiveCount!==0||
     score.gate?.passed!==true||!Number.isSafeInteger(score.gate?.requiredCaught)||
     score.gate.requiredCaught<30||score.gate.requiredCaught>41||
     score.gate?.maxDecoys!==0)
     throw new Error('V13_QUALIFICATION_REQUIRED: score does not substantiate a qualifying pass');
 }
 return {status:'QUALIFIED',seededDefects:41,caught:row.caught,
   decoysFlagged:0,independentRunId:row.independentRunId,scoreSha256:row.scoreSha256};
}
