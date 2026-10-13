import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAlertStore } from "../../packages/alert-store/index.js";
import { createRuleRegistry } from "../../packages/rule-registry/index.js";
import { createMonitor } from "../../packages/rule-registry/monitor.js";

const root=dirname(fileURLToPath(import.meta.url));
const assets={"/":["index.html","text/html; charset=utf-8"],"/styles.css":["styles.css","text/css; charset=utf-8"],"/app.js":["app.js","text/javascript; charset=utf-8"]};
function send(response,status,value){response.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});response.end(JSON.stringify(value))}
async function body(request){const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>1024*1024)throw new Error("body_too_large");chunks.push(chunk)}return JSON.parse(Buffer.concat(chunks).toString("utf8"))}
function parseAlertPath(path){const match=path.match(/^\/api\/alerts\/([^/]+)\/(acknowledge|resolve)$/);return match?{id:decodeURIComponent(match[1]),action:match[2]}:null}
const fixtureScenarios={
 pause:{ruleId:"fixture-paused",dedupKey:"fixture:onre:paused",severity:"critical",recommendedAction:"Review simulated protocol pause.",solanaMeaning:"In a real Solana deployment, the monitoring backend decoded the ONRE program's state/config account and observed its paused account state change from false to true. This means the protocol reports itself paused; it does not mean the Solana executable was frozen."},
 authority:{ruleId:"fixture-upgrade-authority",dedupKey:"fixture:onre:upgradeAuthority",severity:"high",recommendedAction:"Review simulated authority transfer.",solanaMeaning:"In a real Solana deployment, the monitoring backend decoded the Upgradeable Loader ProgramData account and observed the program upgrade authority change. The new authority can deploy different executable program bytes until that authority is removed."},
 vault:{ruleId:"fixture-vault-outflow",dedupKey:"fixture:onre:vaultBalance",severity:"high",recommendedAction:"Review simulated vault outflow.",solanaMeaning:"In a real Solana deployment, the monitoring backend observed a large decrease in an ONRE-controlled SPL token vault account balance between slots. This represents an on-chain asset outflow; by itself it does not prove theft or identify the business reason."},
};
function fixtureEvent(name){const scenario=fixtureScenarios[name];if(!scenario)return null;const occurredAt=new Date().toISOString();return{eventId:`manual:${name}:${occurredAt}`,dedupKey:scenario.dedupKey,mode:"fixture_simulation",level:"fixture_simulation",cluster:"devnet",subject:{type:"program",id:"onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe"},ruleId:scenario.ruleId,ruleVersion:1,status:"breach",severity:scenario.severity,uncertainty:"fixture_only",evidenceIds:[`manual-fixture:${name}`],recommendedAction:scenario.recommendedAction,solanaMeaning:scenario.solanaMeaning,occurredAt,source:{id:"manual-fixture-control",type:"fixture_rpc"},slot:1001}}

export function createAlertConsole({database=":memory:"}={}){
 const store=createAlertStore();const registry=createRuleRegistry({path:database});const monitor=createMonitor({registry,alerts:store});const streams=new Set();
 store.subscribe(change=>{const message=`event: alert\ndata: ${JSON.stringify(change)}\n\n`;for(const stream of streams)stream.write(message)});
 const server=http.createServer(async(request,response)=>{const url=new URL(request.url,"http://localhost");try{
  if(request.method==="GET"&&assets[url.pathname]){const[name,type]=assets[url.pathname];response.writeHead(200,{"content-type":type,"cache-control":"no-store"});response.end(await readFile(join(root,name)));return}
  if(request.method==="GET"&&url.pathname==="/api/health"){send(response,200,{status:"active",service:"alert-console",storage:database===":memory:"?"memory":"sqlite",capabilities:["rule_registry","monitoring","deduplication","lifecycle","sse"]});return}
  if(request.method==="GET"&&url.pathname==="/api/alerts"){send(response,200,store.list({mode:url.searchParams.get("mode"),lifecycle:url.searchParams.get("lifecycle"),severity:url.searchParams.get("severity")}));return}
  if(request.method==="GET"&&url.pathname==="/api/rules"){send(response,200,registry.list());return}
  if(request.method==="GET"&&url.pathname==="/api/rules/audit"){send(response,200,registry.audit());return}
  if(request.method==="GET"&&url.pathname==="/api/stream"){response.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-store","connection":"keep-alive"});response.write(": connected\n\n");streams.add(response);request.on("close",()=>streams.delete(response));return}
  if(request.method==="POST"&&url.pathname==="/api/events"){try{const result=store.ingest(await body(request));send(response,result.created?201:200,result)}catch(error){if(error.message.startsWith("invalid_alert_input")){send(response,400,{error:"invalid_alert_input",message:error.message});return}throw error}return}
  const demo=url.pathname.match(/^\/api\/demo\/activate\/([^/]+)$/);if(request.method==="POST"&&demo){const event=fixtureEvent(decodeURIComponent(demo[1]));if(!event){send(response,404,{error:"unknown_fixture_alert"});return}const result=store.ingest(event);send(response,result.created?201:200,result);return}
  if(request.method==="POST"&&url.pathname==="/api/demo/clear"){send(response,200,{cleared:store.clear({mode:"fixture_simulation"})});return}
  if(request.method==="POST"&&url.pathname==="/api/rules"){const input=await body(request);send(response,201,registry.publish(input.rule,{actor:input.actor}));return}
  if(request.method==="POST"&&(url.pathname==="/api/rules/activate"||url.pathname==="/api/rules/pause")){const input=await body(request);const result=url.pathname.endsWith("activate")?registry.activate(input.rules,{actor:input.actor}):registry.pause(input.rules,{actor:input.actor});send(response,200,result);return}
  if(request.method==="POST"&&url.pathname==="/api/monitor/evidence"){send(response,200,monitor.evaluate(await body(request)));return}
  const route=parseAlertPath(url.pathname);if(request.method==="POST"&&route){const input=await body(request);send(response,200,route.action==="acknowledge"?store.acknowledge(route.id,input.actor):store.resolve(route.id,input.resolution));return}
  send(response,404,{error:"not_found"});
 }catch(error){send(response,400,{error:error.message==="body_too_large"?error.message:"invalid_request",message:error.message})}});
 server.on("close",()=>{for(const stream of streams)stream.end();registry.close()});return server;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){const port=Number(process.env.ALERT_CONSOLE_PORT||7623);const database=process.env.ALERT_CONSOLE_DB||"var/alert-console.sqlite";createAlertConsole({database}).listen(port,"127.0.0.1",()=>console.log(`Kelvara Alert Console: http://127.0.0.1:${port}`))}
