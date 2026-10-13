const MAX_LIMIT = 100;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function limitOf(value = '50') { if (!/^\d{1,3}$/.test(String(value))) throw new RangeError('limit must be an integer from 1 to 100'); const n=Number(value); if(n<1||n>MAX_LIMIT) throw new RangeError('limit must be an integer from 1 to 100'); return n; }
export function validateVelocityAddress(value) { if(typeof value !== 'string' || !ADDRESS.test(value)) throw new RangeError('address is invalid'); return value; }
function rows(db, address, limit) { return db.prepare(`SELECT payload_json FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY address ORDER BY slot DESC, observed_at DESC, observation_id DESC) AS rn FROM velocity_observations WHERE (?='' OR address=?)) WHERE rn=1 ORDER BY slot DESC, observed_at DESC, observation_id DESC LIMIT ?`).all(address,address,limit).map(r=>JSON.parse(r.payload_json)); }
function allRows(db) { return db.prepare('SELECT payload_json FROM velocity_observations ORDER BY slot DESC, observed_at DESC, observation_id DESC').all().map(r=>JSON.parse(r.payload_json)); }
export function velocityProtocolProjection(db) {
  const programs=allRows(db).filter(item=>item.kind==='program');
  const latest=programs[0];
  const networks=new Set(programs.map(item=>item.network));
  const network=networks.size===1 ? [...networks][0] : 'unknown';
  const tracked=db.prepare("SELECT COUNT(DISTINCT address) AS n FROM velocity_observations WHERE kind='account'").get().n;
  return { protocol:'velocity', network, programObservation: latest ? { status:latest.status,address:latest.address,slot:latest.slot,time:latest.observedAt,provenance:latest.provenance } : {status:'unknown',reason:'no_observation'}, trackedCount:Number(tracked), latestSlot:latest?.slot??null, latestTime:latest?.observedAt??null, freshness:latest?.observedAt?{status:'known',observedAt:latest.observedAt}:{status:'unknown',reason:'no_observation'} };
}
export function velocityAccountsProjection(db, query={}) { const limit=limitOf(query.limit); const items=rows(db,'',100).filter(item=>item.kind==='account').slice(0,limit).map(item=>({address:item.address,kind:item.kind,role:'tracked_account',owner:item.owner??null,executable:item.executable??null,dataLength:item.dataLength??null,slot:item.slot,time:item.observedAt,status:item.status,provenance:item.provenance,token:item.token??null})); return {status:'ok',items}; }
export function velocityAccountProjection(db,address,query={}) { validateVelocityAddress(address); const history=allRows(db).filter(item=>item.address===address).sort((a,b)=>Number(b.slot)-Number(a.slot)||String(b.observedAt).localeCompare(String(a.observedAt))||String(b.observationId).localeCompare(String(a.observationId))); if(!history.length)return {status:'not_found',address,items:[]}; return {status:'ok',address,latest:history[0],history}; }
export function unavailableVelocityReadModel(reason='transaction_index_not_implemented') { return {status:'unavailable',reason,items:[]}; }
