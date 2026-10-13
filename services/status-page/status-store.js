import { DatabaseSync } from 'node:sqlite';

const iso=value=>new Date(value).toISOString();
const round=value=>Math.round(value*10000)/10000;

export function createStatusStore({path='/data/status.sqlite',services=[]}={}){
 const db=new DatabaseSync(path);
 db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS probes(service_id TEXT NOT NULL,checked_at INTEGER NOT NULL,ok INTEGER NOT NULL,latency_ms INTEGER,http_status INTEGER,PRIMARY KEY(service_id,checked_at));
  CREATE TABLE IF NOT EXISTS incidents(id INTEGER PRIMARY KEY,service_id TEXT NOT NULL,started_at INTEGER NOT NULL,confirmed_at INTEGER NOT NULL,resolved_at INTEGER);
  CREATE INDEX IF NOT EXISTS probes_time ON probes(service_id,checked_at);
  CREATE INDEX IF NOT EXISTS incidents_time ON incidents(service_id,started_at);`);
 const byId=new Map(services.map(service=>[service.id,service]));

 function record({serviceId,checkedAt=Date.now(),ok,latencyMs=null,httpStatus=null}){
  if(!byId.has(serviceId))throw new Error('unknown_service');
  db.prepare('INSERT OR REPLACE INTO probes VALUES(?,?,?,?,?)').run(serviceId,checkedAt,ok?1:0,latencyMs,httpStatus);
  const open=db.prepare('SELECT * FROM incidents WHERE service_id=? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1').get(serviceId);
  const recent=db.prepare('SELECT checked_at,ok FROM probes WHERE service_id=? ORDER BY checked_at DESC LIMIT 5').all(serviceId);
  if(!open&&recent.length===5&&recent.every(item=>item.ok===0)){
   db.prepare('INSERT INTO incidents(service_id,started_at,confirmed_at) VALUES(?,?,?)').run(serviceId,recent.at(-1).checked_at,checkedAt);
  }else if(open&&recent.length>=2&&recent[0].ok===1&&recent[1].ok===1){
   db.prepare('UPDATE incidents SET resolved_at=? WHERE id=?').run(recent[1].checked_at,open.id);
  }
  return snapshot(checkedAt);
 }

 function incidentRows(serviceId,start,end){
  return db.prepare('SELECT started_at,resolved_at FROM incidents WHERE service_id=? AND started_at<? AND COALESCE(resolved_at,?)>?').all(serviceId,end,end,start);
 }

 function period(serviceId,start,end,label){
  const eligible=Math.max(0,end-start);
  const rows=db.prepare('SELECT checked_at FROM probes WHERE service_id=? AND checked_at>=? AND checked_at<?').all(serviceId,start,end);
  const incidents=incidentRows(serviceId,start,end);
  let downtime=0;
  for(const item of incidents)downtime+=Math.max(0,Math.min(item.resolved_at??end,end)-Math.max(item.started_at,start));
  return{date:label,downtimeSeconds:Math.round(downtime/1000),uptimePercent:eligible?round(100*(eligible-downtime)/eligible):100,observedMinutes:rows.length,coveragePercent:eligible?round(100*Math.min(eligible,rows.length*60000)/eligible):0};
 }

 function state(service,now){
  const open=db.prepare('SELECT * FROM incidents WHERE service_id=? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1').get(service.id);
  const latest=db.prepare('SELECT * FROM probes WHERE service_id=? ORDER BY checked_at DESC LIMIT 1').get(service.id);
  const incidents=db.prepare('SELECT * FROM incidents WHERE service_id=? ORDER BY started_at DESC LIMIT 10').all(service.id);
  const currentStatus=open?'incident':!latest||now-latest.checked_at>180000?'no_data':'operational';
  return{id:service.id,name:service.name,description:service.description||'',currentStatus,status:currentStatus==='incident'?'outage':currentStatus==='no_data'?'unknown':'operational',checkedAt:latest?iso(latest.checked_at):null,latencyMs:latest?.latency_ms??null,incidents:incidents.map(item=>({startedAt:iso(item.started_at),confirmedAt:iso(item.confirmed_at),resolvedAt:item.resolved_at?iso(item.resolved_at):null}))};
 }

 function serviceModel(service,now){
  const start=now-86400000;
  const interval=1800000;
  const timeline=Array.from({length:48},(_,index)=>{
   const segmentStart=start+index*interval;
   const segmentEnd=index===47?now:segmentStart+interval;
   const incident=incidentRows(service.id,segmentStart,segmentEnd)[0];
   const observed=db.prepare('SELECT COUNT(*) AS count FROM probes WHERE service_id=? AND checked_at>=? AND checked_at<?').get(service.id,segmentStart,segmentEnd).count;
   return{timestamp:iso(segmentStart),status:incident?'incident':observed?'operational':'no_data',description:incident?'Confirmed service incident':observed?'Service checks passed':'No monitoring data'};
  });
  const aggregate=period(service.id,start,now,iso(start));
  return{...state(service,now),uptime24h:aggregate.observedMinutes?aggregate.uptimePercent:null,dataCoverage24h:aggregate.coveragePercent,timeline};
 }

 function snapshot(now=Date.now()){
  const models=services.map(service=>serviceModel(service,now));
  const publicServices=models.filter((_,index)=>services[index].group!=='details');
  const details=models.filter((_,index)=>services[index].group==='details');
  const operational=publicServices.filter(item=>item.currentStatus==='operational').length;
  const incidents=publicServices.reduce((count,item)=>count+item.incidents.filter(incident=>!incident.resolvedAt).length,0);
  const measured=publicServices.filter(item=>item.uptime24h!==null);
  const overallUptime24h=measured.length?round(measured.reduce((sum,item)=>sum+item.uptime24h,0)/measured.length):null;
  const statuses=publicServices.map(item=>item.currentStatus);
  return{schemaVersion:'kelvara-status/v2',generatedAt:iso(now),timeline:{unit:'minute',intervalMinutes:30,count:48,label:'Last 24 hours'},summary:{systems:publicServices.length,operational,incidents,overallUptime24h},overall:statuses.includes('incident')?'major_outage':statuses.some(status=>status!=='operational')?'degraded':'operational',services:publicServices,details};
 }

 function daily(serviceId,date,now=Date.now()){
  const start=Date.parse(`${date}T00:00:00.000Z`);
  return period(serviceId,start,Math.min(start+86400000,now),date);
 }
 return{record,snapshot,daily,close:()=>db.close()};
}
