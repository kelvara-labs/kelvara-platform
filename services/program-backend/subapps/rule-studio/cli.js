#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateRule } from "../../packages/rule-engine/index.js";
import { evaluateBatch } from "../../packages/rule-engine/batch.js";

function options(args){
  const out={positionals:[]};
  for(let index=0;index<args.length;index++){
    const arg=args[index];
    if(arg==="--summary-only")out.summaryOnly=true;
    else if(arg.startsWith("--")){const key=arg.slice(2);out[key]=args[++index];}
    else out.positionals.push(arg);
  }
  return out;
}

async function parseCases(path){
  const text=await readFile(path,"utf8");
  if(path.endsWith(".ndjson"))return text.split(/\r?\n/).filter(line=>line.trim()).map((line,index)=>{try{return JSON.parse(line)}catch{throw new TypeError(`invalid_ndjson_line_${index+1}`)}});
  const value=JSON.parse(text);
  if(!Array.isArray(value))throw new TypeError("batch_json_must_be_array");
  return value;
}

function simulatedCases(count,cluster){
  return Array.from({length:count},(_,index)=>({
    id:`breach-${index}`,
    rule:{id:`simulated-limit-${index}`,version:1,name:`Simulated limit ${index}`,cluster,field:"value",operator:"greater_than",threshold:100,nearThresholdPercent:5,severity:"high",recommendedAction:"Review simulated breach evidence."},
    evidence:{id:`simulation-evidence-${index}`,cluster,state:"active",freshness:{status:"fresh",ageMs:0,maxAgeMs:15000},confidence:"verified",coverage:"complete",value:{value:101}},
  }));
}

async function publish(url,run){
  const response=await fetch(`${url.replace(/\/$/,"")}/api/runs`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(run)});
  if(!response.ok)throw new Error(`publish_failed_${response.status}`);
  return response.json();
}

export async function main(argv=process.argv.slice(2)){
  const command=argv[0];
  const parsed=options(argv.slice(1));
  if(command==="validate"){
    if(!parsed.positionals[0])throw new TypeError("rule_file_required");
    const rule=JSON.parse(await readFile(parsed.positionals[0],"utf8"));
    return validateRule(rule);
  }
  if(command==="publish-rules"){
    if(!parsed.positionals[0]||!parsed["alert-console"])throw new TypeError("rule_file_and_alert_console_required");
    const text=await readFile(parsed.positionals[0],"utf8");const value=JSON.parse(text);const rules=Array.isArray(value)?value:[value];const output=[];
    for(const rule of rules){const validation=validateRule(rule);if(!validation.valid)throw new TypeError(`invalid_rule: ${validation.errors.join("; ")}`);const response=await fetch(`${parsed["alert-console"].replace(/\/$/,"")}/api/rules`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({rule,actor:parsed.actor??"rule-studio"})});if(!response.ok)throw new Error(`rule_publish_failed_${response.status}`);output.push(await response.json())}
    return output;
  }
  if(command==="run-levels"){
    if(!parsed.paper&&!parsed.devnet)throw new TypeError("paper_or_devnet_file_required");
    const output={};
    if(parsed.paper){
      const cases=await parseCases(parsed.paper);
      const cluster=cases[0]?.evidence?.cluster;
      output.paper=evaluateBatch(cases,{cluster,runId:parsed["run-id"]??"paper-run",includeResults:!parsed.summaryOnly,sampleLimit:Number(parsed["sample-limit"]??(parsed.summaryOnly?0:20))});
      output.paper.level="paper";
      output.paper.mode="paper";
    }
    if(parsed.devnet){
      const cases=await parseCases(parsed.devnet);
      for(let index=0;index<cases.length;index++){
        const evidence=cases[index]?.evidence;
        if(evidence?.cluster!=="devnet"||evidence?.source?.type!=="monitoring_backend"||!evidence?.source?.id||!Number.isInteger(evidence?.slot)||!Number.isFinite(Date.parse(evidence?.observedAt))||!Number.isFinite(Date.parse(evidence?.fetchedAt)))throw new TypeError(`invalid_devnet_evidence at case ${index}`);
      }
      output.devnet=evaluateBatch(cases,{cluster:"devnet",runId:parsed["run-id"]??"devnet-run",includeResults:!parsed.summaryOnly,sampleLimit:Number(parsed["sample-limit"]??(parsed.summaryOnly?0:20))});
      output.devnet.level="devnet";
      output.devnet.mode="monitored_evidence";
    }
    if(parsed.publish){
      if(output.paper)output.paper.published=await publish(parsed.publish,output.paper);
      if(output.devnet)output.devnet.published=await publish(parsed.publish,output.devnet);
    }
    return output;
  }
  const cluster=parsed.cluster;
  if(command==="run-batch"||command==="simulate-breach"){
    const count=Number(parsed.count??1000);
    if(command==="simulate-breach"&&(!Number.isInteger(count)||count<1||count>1_000_000))throw new TypeError("count_must_be_1_to_1000000");
    const cases=command==="run-batch"?await parseCases(parsed.positionals[0]):simulatedCases(count,cluster);
    const run=evaluateBatch(cases,{cluster,runId:parsed["run-id"]??`${command}-${cluster}`,includeResults:!parsed.summaryOnly,sampleLimit:Number(parsed["sample-limit"]??(parsed.summaryOnly?0:20))});
    if(command==="simulate-breach")run.mode="breach_simulation";
    else run.mode="batch";
    if(parsed.publish)run.published=await publish(parsed.publish,run);
    return run;
  }
  throw new TypeError("usage: validate <rule.json> | run-batch <batch.json|ndjson> --cluster <cluster> | simulate-breach --count N --cluster <cluster> | run-levels [--paper file] [--devnet file]");
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  main().then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{process.stderr.write(`${JSON.stringify({error:error.message})}\n`);process.exitCode=1});
}
