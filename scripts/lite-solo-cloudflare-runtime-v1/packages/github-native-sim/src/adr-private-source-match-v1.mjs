// This module executes only inside trusted private qualification jobs.
// Never import a truth manifest in a reviewer or campaign delivery process.
const norm=s=>String(s??'').trim().toLowerCase();
const parseAnchor=x=>{
 if(typeof x==='object'&&x!==null&&!Array.isArray(x)){
  const path=x.path??x.sourcePath;
  if(typeof path!=='string'||!Number.isInteger(x.lineStart))return null;
  return {path,lineStart:x.lineStart,lineEnd:Number.isInteger(x.lineEnd)?x.lineEnd:x.lineStart};
 }
 const match=/^(.+):L(\d+)(?:-L(\d+))?$/.exec(String(x??''));
 return match?{path:match[1],lineStart:+match[2],lineEnd:+(match[3]??match[2])}:null;
};
function anchors(x){
 const items=[...(Array.isArray(x?.sourceAnchors)?x.sourceAnchors:[]),
  ...(Array.isArray(x?.anchors)?x.anchors:[]),x?.sourceAnchor,
  ...(x?.path&&Number.isInteger(x?.lineStart)?[{path:x.path,lineStart:x.lineStart,lineEnd:x.lineEnd}]:[])];
 return items.map(parseAnchor).filter(Boolean);
}
const overlap=(a,b)=>a.path===b.path&&a.lineStart<=b.lineEnd&&b.lineStart<=a.lineEnd;
export function sourceBoundAutoAdjudicationsV13({truth,findings,manualAmbiguities=[]}={}){
 if(!Array.isArray(truth)||!Array.isArray(findings))throw Error('real private truth and campaign findings required');
 if(!truth.every(x=>x.caseId&&x.kind&&x.classId&&anchors(x).length))
  throw Error('private truth must specify source path, ranges, IDs and class for every case');
 const decided=[],updated=findings.map(x=>({...x,caseRefs:[]})),ambiguous=[];
 for(const finding of updated){
  const cited=anchors(finding);
  const possibilities=truth.filter(c=>norm(c.classId)===norm(finding.classId)&&
   cited.some(a=>anchors(c).some(b=>overlap(a,b)))&&
   (norm(c.contract)===norm(finding.contract)||
    (norm(c.contract).split(':').at(-1)===norm(finding.contract).split(':').at(-1))));
  if(possibilities.length===1){
   const item=possibilities[0];
   finding.caseRefs=[item.caseId];
   decided.push({caseId:item.caseId,findingId:finding.findingId,match:'MATCH',
     severityReadjudicated:false,reason:'Private exact class/contract/source-range intersection'});
  }else if(possibilities.length>1){
   ambiguous.push({findingId:finding.findingId,candidateCount:possibilities.length});
   const choice=manualAmbiguities.find(x=>x.findingId===finding.findingId);
   if(choice&&possibilities.some(x=>x.caseId===choice.caseId)&&
     choice.evidenceReviewed===true&&String(choice.reason??'').length>40){
    finding.caseRefs=[choice.caseId];
    decided.push({caseId:choice.caseId,findingId:finding.findingId,match:'MATCH',
     severityReadjudicated:false,reason:choice.reason});
   }
  }
 }
 return {findings:updated,adjudications:decided,ambiguous,
  matchedCount:new Set(decided.map(x=>x.caseId)).size};
}
