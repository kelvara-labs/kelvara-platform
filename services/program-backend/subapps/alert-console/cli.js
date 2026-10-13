#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function options(args){const out={positionals:[]};for(let index=0;index<args.length;index++){const arg=args[index];if(arg.startsWith("--"))out[arg.slice(2)]=args[++index];else out.positionals.push(arg)}return out}
async function parseFile(path){const text=await readFile(path,"utf8");if(path.endsWith(".ndjson"))return text.split(/\r?\n/).filter(Boolean).map(JSON.parse);const value=JSON.parse(text);return Array.isArray(value)?value:[value]}
async function request(api,path,options={}){const response=await fetch(`${api.replace(/\/$/,"")}${path}`,options);const value=await response.json();if(!response.ok)throw new Error(`${value.error??"request_failed"}: ${value.message??response.status}`);return value}
export async function main(argv=process.argv.slice(2)){const command=argv[0];const parsed=options(argv.slice(1));const api=parsed.api??"http://127.0.0.1:7623";
 if(command==="ingest"){const events=await parseFile(parsed.positionals[0]);let created=0,deduplicated=0;for(const event of events){const result=await request(api,"/api/events",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(event)});result.created?created++:deduplicated++}return{accepted:events.length,created,deduplicated}}
 if(command==="list"){const params=new URLSearchParams();for(const key of ["mode","lifecycle","severity"])if(parsed[key])params.set(key,parsed[key]);return request(api,`/api/alerts?${params}`)}
 if(command==="acknowledge")return request(api,`/api/alerts/${encodeURIComponent(parsed.positionals[0])}/acknowledge`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({actor:parsed.actor??"cli"})});
 if(command==="resolve")return request(api,`/api/alerts/${encodeURIComponent(parsed.positionals[0])}/resolve`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({resolution:parsed.resolution??"resolved_by_cli"})});
 if(command==="publish-rules"){const rules=await parseFile(parsed.positionals[0]);const published=[];for(const rule of rules)published.push(await request(api,"/api/rules",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({rule,actor:parsed.actor??"cli"})}));return published}
 if(command==="list-rules"){const rules=await request(api,"/api/rules");return parsed.activation?rules.filter(item=>item.activation===parsed.activation):rules}
 if(command==="activate-rules"||command==="pause-rules"){const rules=await parseFile(parsed.positionals[0]);return request(api,`/api/rules/${command==="activate-rules"?"activate":"pause"}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({rules,actor:parsed.actor??"cli"})})}
 if(command==="monitor"){const evidence=(await parseFile(parsed.positionals[0]))[0];return request(api,"/api/monitor/evidence",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(evidence)})}
 if(command==="simulate")return request(api,`/api/demo/activate/${encodeURIComponent(parsed.positionals[0])}`,{method:"POST"});
 if(command==="clear-fixtures")return request(api,"/api/demo/clear",{method:"POST"});
 throw new TypeError("usage: ingest|list|acknowledge|resolve|publish-rules|list-rules|activate-rules|pause-rules|monitor|simulate <pause|authority|vault>|clear-fixtures")}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])main().then(value=>process.stdout.write(`${JSON.stringify(value)}\n`)).catch(error=>{process.stderr.write(`${JSON.stringify({error:error.message})}\n`);process.exitCode=1});
