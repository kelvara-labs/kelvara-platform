import { evaluateRule } from "./index.js";

const STATUSES=["pass","review","breach","unknown"];

export function evaluateBatch(cases,{cluster,runId="batch",sampleLimit=20,includeResults=true}={}){
  if(!Array.isArray(cases))throw new TypeError("cases_must_be_array");
  if(!["mainnet-beta","devnet"].includes(cluster))throw new TypeError("unsupported_network");
  const counts={pass:0,review:0,breach:0,unknown:0};
  const results=[];
  const samples=[];
  for(let index=0;index<cases.length;index++){
    const item=cases[index]??{};
    const ruleCluster=item.rule?.cluster??item.evidence?.cluster;
    const evidenceCluster=item.evidence?.cluster;
    if(ruleCluster!==cluster||evidenceCluster!==cluster)throw new TypeError(`mixed_clusters at case ${index}`);
    const result=evaluateRule(item.rule,item.evidence);
    counts[result.status]++;
    const record={index,caseId:item.id??`case-${index}`,...result};
    if(includeResults)results.push(record);
    if(result.status!=="pass"&&samples.length<sampleLimit)samples.push(record);
  }
  return {schemaVersion:1,runId,cluster,total:cases.length,counts,samples,...(includeResults?{results}:{})};
}

export { STATUSES as batchStatuses };
