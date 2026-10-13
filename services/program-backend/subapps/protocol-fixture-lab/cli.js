#!/usr/bin/env node
const base=process.env.PROTOCOL_FIXTURE_LAB_URL||process.env.ONRE_FIXTURE_LAB_URL||"http://127.0.0.1:7630";
const [command,arg]=process.argv.slice(2);
async function request(path,method="GET"){const response=await fetch(`${base}${path}`,{method});const value=await response.json();if(!response.ok)throw new Error(value.error||`http_${response.status}`);return value}
try{
 let result;
 if(command==="status")result=await request("/api/state");
 else if(command==="scenarios")result=await request("/api/scenarios");
 else if(command==="trigger"&&arg)result=await request(`/api/scenarios/${encodeURIComponent(arg)}`,"POST");
 else if(command==="reset")result=await request("/api/reset","POST");
 else if(command==="export")result=await request("/api/export");
 else throw new Error("usage: status | scenarios | trigger <scenario> | reset | export");
 console.log(JSON.stringify(result,null,2));
}catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1}
