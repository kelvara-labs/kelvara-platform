import { createHash } from "node:crypto";

const MODES=new Set(["paper","fixture_simulation","devnet","historical","live"]);
const RESULTS=new Set(["pass","review","breach","unknown"]);
function hash(value){return createHash("sha256").update(value).digest("hex").slice(0,24)}
function validate(input){const errors=[];if(!MODES.has(input?.mode))errors.push("mode is invalid");if(!RESULTS.has(input?.status))errors.push("status is invalid");if(!input?.dedupKey)errors.push("dedupKey is required");if(!input?.ruleId||!Number.isInteger(input?.ruleVersion))errors.push("rule identity is required");if(!input?.subject?.type||!input?.subject?.id)errors.push("subject is required");if(!Array.isArray(input?.evidenceIds)||!input.evidenceIds.length)errors.push("evidenceIds are required");if(!input?.occurredAt||!Number.isFinite(Date.parse(input.occurredAt)))errors.push("occurredAt is required");if(input?.mode==="devnet"&&(!input?.source?.id||input?.source?.type!=="monitoring_backend"||!Number.isInteger(input?.slot)))errors.push("devnet source and slot are required");if(errors.length)throw new TypeError(`invalid_alert_input: ${errors.join("; ")}`)}
function identity(input){return `${input.mode}|${input.cluster}|${input.dedupKey}|${input.ruleId}|${input.ruleVersion}|${input.subject.type}|${input.subject.id}`}
function clone(value){return structuredClone(value)}

export function createAlertStore({clock=()=>new Date().toISOString()}={}){
 const alerts=[];const listeners=new Set();
 const emit=(type,alert)=>{for(const listener of listeners)listener({type,alert:clone(alert)})};
 const findActive=key=>[...alerts].reverse().find(alert=>alert.identity===key&&["open","acknowledged"].includes(alert.lifecycle));
 return {
  ingest(input){validate(input);const key=identity(input);const active=findActive(key);
   if(input.status==="pass"){
    if(!active)return{created:false,resolved:false,alert:null};active.lifecycle="resolved";active.resolvedAt=clock();active.resolution="condition_cleared";active.updatedAt=clock();emit("resolved",active);return{created:false,resolved:true,alert:clone(active)};
   }
   if(input.status!=="breach"&&input.status!=="review")return{created:false,resolved:false,alert:null};
   if(active){active.occurrences++;active.lastSeenAt=input.occurredAt;active.eventIds.push(input.eventId);active.evidenceIds=[...new Set([...active.evidenceIds,...input.evidenceIds])];active.updatedAt=clock();emit("updated",active);return{created:false,resolved:false,alert:clone(active)}}
   const previous=[...alerts].reverse().find(alert=>alert.identity===key&&alert.lifecycle==="resolved");if(previous){previous.lifecycle="superseded";previous.supersededAt=clock()}
   const alert={id:`alert:${hash(`${key}|${input.eventId}|${input.occurredAt}`)}`,identity:key,lifecycle:"open",occurrences:1,createdAt:clock(),updatedAt:clock(),firstSeenAt:input.occurredAt,lastSeenAt:input.occurredAt,eventIds:[input.eventId],...clone(input)};alerts.push(alert);emit("created",alert);return{created:true,resolved:false,alert:clone(alert)};
  },
  acknowledge(id,actor){const alert=alerts.find(item=>item.id===id);if(!alert)throw new TypeError("alert_not_found");if(alert.lifecycle!=="open")throw new TypeError("alert_not_open");alert.lifecycle="acknowledged";alert.acknowledgedAt=clock();alert.acknowledgedBy=actor;alert.updatedAt=clock();emit("acknowledged",alert);return clone(alert)},
  resolve(id,resolution){const alert=alerts.find(item=>item.id===id);if(!alert)throw new TypeError("alert_not_found");if(!["open","acknowledged"].includes(alert.lifecycle))throw new TypeError("alert_not_active");alert.lifecycle="resolved";alert.resolvedAt=clock();alert.resolution=resolution;alert.updatedAt=clock();emit("resolved",alert);return clone(alert)},
  list(filters={}){return alerts.filter(alert=>Object.entries(filters).every(([key,value])=>!value||alert[key]===value)).map(clone)},
  get(id){const alert=alerts.find(item=>item.id===id);return alert?clone(alert):null},
  clear(filters={}){let cleared=0;for(let index=alerts.length-1;index>=0;index--){if(Object.entries(filters).every(([key,value])=>!value||alerts[index][key]===value)){const [removed]=alerts.splice(index,1);cleared++;emit("removed",removed)}}return cleared},
  subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener)},
 };
}
