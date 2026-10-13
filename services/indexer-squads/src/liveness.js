const VERSION='0.1.0';

async function post(url,token,body,fetchImpl){
 const response=await fetchImpl(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
 if(!response.ok)throw new Error(`Observation Hub liveness HTTP ${response.status}`);
 return response.json();
}

function identity(assignment){
 const parts=assignment.subjectId.split(':');
 if(parts.length!==5||parts[0]!=='solana'||parts[1]!==assignment.network)throw new TypeError('assignment subject identity invalid');
 return{targetId:assignment.subjectId,chain:parts[0],network:parts[1],protocol:parts[2],kind:parts[3],address:parts[4]};
}

export function createSubjectLivenessPublisher({hubUrl,assignmentToken,fetchImpl=fetch,now=()=>new Date()}={}){
 if(typeof hubUrl!=='string'||!hubUrl||typeof assignmentToken!=='string'||assignmentToken.length<32)throw new TypeError('liveness publisher configuration required');
 const base=hubUrl.replace(/\/$/,'');
 return async({assignment,result})=>{
  const target=identity(assignment);
  if(result.state==='disabled'){
   await post(`${base}/internal/v1/assignments`,assignmentToken,{eventId:`disable:${assignment.assignmentId}:${now().toISOString()}`,eventType:'assignment.paused',payload:{...target,indexerId:assignment.assignmentId,revision:1}},fetchImpl);
   return{availability:'not_monitored'};
  }
  if(result.state!=='ready')return{availability:'unavailable',published:false};
  const token=assignment.credential?.token;
  if(typeof token!=='string'||token.length<32)throw new TypeError('subject credential required');
  await post(`${base}/internal/indexers/register`,token,{indexerId:assignment.assignmentId,protocol:target.protocol,network:target.network,version:VERSION,capabilities:['authorities']},fetchImpl);
  await post(`${base}/internal/v1/assignments`,assignmentToken,{eventId:`activate:${assignment.assignmentId}`,eventType:'assignment.activated',payload:{...target,indexerId:assignment.assignmentId,revision:1}},fetchImpl);
  await post(`${base}/internal/indexers/${encodeURIComponent(assignment.assignmentId)}/reconciliation`,token,{indexerId:assignment.assignmentId,targetId:target.targetId,status:'observing',cursor:result.result?.body?.committedCursor??null,error:null},fetchImpl);
  await post(`${base}/internal/indexers/${encodeURIComponent(assignment.assignmentId)}/heartbeat`,token,{indexerId:assignment.assignmentId,status:'healthy',lastSuccessAt:now().toISOString(),error:null},fetchImpl);
  return{availability:'healthy',published:true};
 };
}
