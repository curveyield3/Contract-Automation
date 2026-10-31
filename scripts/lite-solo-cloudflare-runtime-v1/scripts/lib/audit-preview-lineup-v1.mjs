import fs from 'node:fs';
import path from 'node:path';
export const SOLO_ROOT='Audit Skill - Audit Preview/audit-preview-v1';
export const SOLO_ROOT_V5='Audit Skill - Lite-Solo Authority/lite-solo-v5';
export const SOLO_ROOT_V4='Audit Skill - Lite-Solo Authority/lite-solo-v4';
export const SOLO_ROOT_V3='Audit Skill - Lite-Solo Authority/lite-solo-v3';
export const SOLO_ROOT_V2='Audit Skill - Lite-Solo Authority/lite-solo-v2';
export const SOLO_ROOT_V1='Audit Skill - Lite-Solo Authority/lite-solo';
export const SOLO_ACTOR='lite-solo-agent';
export function assertLiteSoloAuthorityV1({root,authorityRoot,mode,actorId}={}){
 if(![SOLO_ROOT,SOLO_ROOT_V5,SOLO_ROOT_V4,SOLO_ROOT_V3,SOLO_ROOT_V2,SOLO_ROOT_V1].includes(authorityRoot)||mode!=='LITE_SOLO'||actorId!==SOLO_ACTOR)throw new Error('lite-solo authority, mode or actor mismatch');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,...authorityRoot.split('/'),'MANIFEST.json'),'utf8'));
 const l=manifest.reviewerLineup??{};
 if(manifest.release!==(authorityRoot===SOLO_ROOT?'audit-preview-v1':authorityRoot===SOLO_ROOT_V5?'lite-solo-v5':authorityRoot===SOLO_ROOT_V4?'lite-solo-v4':authorityRoot===SOLO_ROOT_V3?'lite-solo-v3':authorityRoot===SOLO_ROOT_V2?'lite-solo-v2':'lite-solo-v1')||
    manifest.packageRevision!==(authorityRoot===SOLO_ROOT?'v1':authorityRoot===SOLO_ROOT_V5?'v5':authorityRoot===SOLO_ROOT_V4?'v4':authorityRoot===SOLO_ROOT_V3?'v3':authorityRoot===SOLO_ROOT_V2?'v2':'v1')||manifest.mode!=='LITE_SOLO'||
    l.schemaVersion!=='lite-solo-reviewer-lineup-v1'||JSON.stringify(l.automaticPhases)!=='[]'||
    l.discoveryFlow!==SOLO_ACTOR||l.discoveryAttacker!==SOLO_ACTOR||
    !Array.isArray(l.masterSegments)||l.masterSegments.length!==0||manifest.masterReviewPolicy)
   throw new Error('lite-solo manifest role integrity check failed');
 for(let i=1;i<=4;i++)if(l.phaseReviewers?.[i]!==SOLO_ACTOR)
   throw new Error('lite-solo phase owner mismatch '+i);
 return manifest;
}
