import fs from 'node:fs';
import path from 'node:path';

// The bound, versioned skill manifest owns the v13 reviewer lineup.
// Frozen v12 audit campaigns preserve their historical caller identity.
// Both live logical v13 and its immutable digest-bound archive revisions use the
// same reviewer assignment topology. Authority bytes are still verified from
// the exact frozen manifest; matching the directory name is not a rebind.
export const isV13AuthorityV1=authorityRoot=>/(?:^|\/)Audit_Litemode_v13(?:_v13_[0-9]+)?(?:\/|$)/.test(String(authorityRoot??''));

export function boundReviewerLineupV13({root,authorityRoot}={}){
 if(!isV13AuthorityV1(authorityRoot))return null;
 if(!root)throw new Error('v13 reviewer mapping requires bound Audit-Controller root');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,...authorityRoot.split('/'),'MANIFEST.json'),'utf8'));
 const lineup=manifest.reviewerLineup;
 if(manifest.release!=='Audit_Litemode_v13'||lineup?.schemaVersion!=='curveyield-v13-reviewer-lineup-v1')
   throw new Error('v13 role authority manifest is missing or mismatched');
 const modern=lineup.masterSegments?.[0]?.segmentId==='reviewer-1-phases-01-03';
 const owners=modern
  ?['reviewer-1','reviewer-1','reviewer-1','reviewer-2','reviewer-3','reviewer-3','phase7-automation','reviewer-4','reviewer-4','reviewer-4']
  :['reviewer-1','reviewer-2','reviewer-2','reviewer-2','reviewer-3','reviewer-3','reviewer-3','reviewer-4','reviewer-4','reviewer-4'];
 for(let n=1;n<=10;n++)if(lineup.phaseReviewers?.[String(n)]!==owners[n-1])
   throw new Error('bound v13 phase owner mismatch '+n);
 const expected=modern
  ?[['reviewer-1-phases-01-03','reviewer-1',[1,2,3],3],['reviewer-2-phase-04','reviewer-2',[4],4],['reviewer-3-phases-05-06','reviewer-3',[5,6],6],['reviewer-4-phases-08-10','reviewer-4',[8,9,10],10]]
  :[['reviewer-1-phase-01','reviewer-1',[1],1],['reviewer-2-phases-02-04','reviewer-2',[2,3,4],4],['reviewer-3-phases-05-07','reviewer-3',[5,6,7],7],['reviewer-4-phases-08-10','reviewer-4',[8,9,10],10]];
 if(JSON.stringify(lineup.automaticPhases)!=='[7]'||lineup.discoveryAttacker!==(modern?'reviewer-2':'reviewer-3')||lineup.testExecutor!=='test-executor'||lineup.masterSegments?.length!==4)
  throw new Error('invalid bound v13 segment and executor identities');
 for(let i=0;i<4;i++){
   const [segmentId,reviewerId,phases,boundaryPhase]=expected[i],row=lineup.masterSegments[i];
   if(row?.segmentId!==segmentId||row?.reviewerId!==reviewerId||JSON.stringify(row?.phases)!==JSON.stringify(phases)||row?.boundaryPhase!==boundaryPhase)
     throw new Error('bound v13 segment mismatch '+segmentId);
 }
 return lineup;
}
export function boundReviewerForPhaseV1({root,authorityRoot,phase}={}){
 if(authorityRoot==='Audit Skill - Audit Preview/audit-preview-v1'){
   if(!Number.isInteger(Number(phase))||Number(phase)<1||Number(phase)>4)
     throw new Error('AUDIT_PREVIEW_PHASE_OUT_OF_SCOPE');
   return 'lite-solo-agent';
 }

 if(isV13AuthorityV1(authorityRoot))
   return boundReviewerLineupV13({root,authorityRoot}).phaseReviewers[String(phase)];
 const n=Number(phase);
 if(n===1)return 'reviewer-1';
 if(n>=2&&n<=5)return 'reviewer-2';
 if(n===6||n===7)return 'reviewer-3L';
 if(n>=8&&n<=10)return 'reviewer-4';
 throw new Error('unknown phase reviewer '+phase);
}

// Distinguish reassigned v13 from frozen campaign manifests at the bound revision.
export function isReassignedV13AuthorityV1({root,authorityRoot}={}){
 return Boolean(isV13AuthorityV1(authorityRoot)&&boundReviewerLineupV13({root,authorityRoot}).masterSegments[0].segmentId==='reviewer-1-phases-01-03');
}
