import {classesForTriggersV1} from './adr-taxonomy-v1.mjs';
const text=x=>String(x??'');
const sort=(a,b)=>text(a).localeCompare(text(b));
const unique=x=>[...new Set(x??[])].sort(sort);
const field=(artifact,key)=>artifact?.payload?.[key]??artifact?.[key];
const priority=(ctxs,klass,summary)=>{
 const found=field(summary,'perContext')??{};
 const items=field(summary,'reconciliationItems')??[];
 const paths=field(summary,'attackPaths')??[];
 const gaps=field(summary,'gaps')??[];
 const ids=new Set(ctxs.map(x=>x.contextId)),sourcePaths=new Set(ctxs.map(x=>x.path));
 if(ctxs.some(x=>['CONCERN','UNRESOLVED'].includes(found[x.contextId]?.[klass])))return true;
 if(items.some(x=>x.origin==='ATTACK_CONTRADICTS_REVIEW'&&x.contextIds?.some(id=>ids.has(id))))return true;
 if(items.some(x=>x.origin==='REVIEWER_UNRESOLVED'&&x.contextIds?.some(id=>ids.has(id))))return true;
 if(paths.some(p=>['VIABLE','UNCERTAIN'].includes(p.result)&&
   (p.contextIds?.some(id=>ids.has(id))||p.anchors?.some(a=>[...sourcePaths].some(file=>a.startsWith(file+':L'))))))return true;
 if(gaps.some(g=>g.contextId&&ids.has(g.contextId)||g.contextIds?.some(id=>ids.has(id))||
    g.path&&[...sourcePaths].includes(g.path)||g.code==='INVENTORY_INCOMPLETE'&&g.path==='*'))return true;
 return false;
}
export function deriveBaselineObligationsV1({inventory,taxonomy,summary}){
 if(!inventory||!taxonomy)throw new TypeError('inventory and taxonomy required');
 const classes=new Map(taxonomy.classes.map(x=>[x.classId,x])),pairs=new Map();
 for(const context of inventory.payload?.contexts??[]){
  if(context.scopeTier&&!['IN_SCOPE','INHERITED_DEPENDENCY'].includes(context.scopeTier))continue;
  const contract=context.effectiveIn?.[0]??context.qualifiedContainer;
  if(!contract)continue;
  const required=classesForTriggersV1(taxonomy,inventory.payload?.triggers?.[context.contextId]??[]);
  for(const classId of required){
   const kind=classes.get(classId);
   if(!kind?.testRequired)continue;
   const key=contract+'|'+classId,group=pairs.get(key)??{contract,classId,testMethod:kind.testMethod,
     title:kind.title+' holds for '+contract,contextIds:[],reviewChecks:kind.reviewChecks??[],
     contexts:[]};
   group.contextIds.push(context.contextId);group.contexts.push(context);pairs.set(key,group);
  }
 }
 const temp=[...pairs.values()].map(p=>({...p,contextIds:unique(p.contextIds),
  priority:priority(p.contexts,p.classId,summary)?'HIGH':'NORMAL'}));
 temp.sort((a,b)=>Number(b.priority==='HIGH')-Number(a.priority==='HIGH')||
    sort(a.contract,b.contract)||sort(a.classId,b.classId));
 const obligations=temp.map(({contexts,...row},i)=>({obligationId:'BOB-'+String(i+1).padStart(4,'0'),...row}));
 const contracts=unique(obligations.map(x=>x.contract)),testGroups=[];
 for(const contract of contracts){
  const rows=obligations.filter(x=>x.contract===contract);
  for(let i=0;i<rows.length;i+=8){
   const chunk=rows.slice(i,i+8);
   testGroups.push({testGroupId:'TG-'+String(testGroups.length+1).padStart(3,'0'),
    contract,obligationIds:chunk.map(x=>x.obligationId),
    testMethods:unique(chunk.map(x=>x.testMethod)),
    priority:chunk.some(x=>x.priority==='HIGH')?'HIGH':'NORMAL'});
  }
 }
 return {schemaVersion:'curveyield-baseline-obligations-v1',campaignId:inventory.campaignId,
  campaignGenerationId:inventory.campaignGenerationId,sourceSha256:inventory.sourceSha256,
  taxonomyVersion:'curveyield-defect-taxonomy-v1',detectionPolicy:'audit-detection-rebuild-v1',
  generatedAt:inventory.generatedAt,payload:{obligations,testGroups}};
}
