import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const AGENT_SCOPES = Object.freeze(['policy:read','policy:write','policy:activate','wallet:read','audit:read']);
const digest = value => createHash('sha256').update(String(value ?? '')).digest('hex');
const secret = prefix => `${prefix}${randomBytes(32).toString('base64url')}`;
const same = (a,b) => { const x=Buffer.from(String(a??'')), y=Buffer.from(String(b??'')); return x.length===y.length && timingSafeEqual(x,y); };
const clean = (input, name) => { if(typeof input!=='string'||!input.trim()||input.length>500||/[\u0000-\u001f\u007f]/.test(input)) throw new TypeError(`${name} is invalid`); return input.trim(); };
const scopes = value => { if(!Array.isArray(value)||!value.length||value.some(x=>typeof x!=='string'||!AGENT_SCOPES.includes(x))||new Set(value).size!==value.length) throw new TypeError('scopes are invalid'); return [...value].sort(); };
export function scopeForRequest(method,path) {
 const exact=new Map([
  ['GET /internal/v1/config/snapshot','policy:read'],['GET /internal/v1/config/discovery-manifest','policy:read'],['POST /internal/v1/config/batch-read','policy:read'],
  ['GET /internal/v1/admin/rules-by-vault','policy:read'],['GET /internal/v1/targets/:id/policy','policy:read'],['GET /internal/v1/wallets/:id/enrollments','wallet:read'],['GET /internal/v1/admin/audit','audit:read'],
  ['POST /internal/v1/admin/protocols','policy:write'],['POST /internal/v1/admin/targets','policy:write'],['POST /internal/v1/admin/rules','policy:write'],['POST /internal/v1/admin/rule-versions','policy:write'],['POST /internal/v1/admin/bindings','policy:write'],['POST /internal/v1/admin/policy-rules','policy:write'],['POST /internal/v1/admin/validate','policy:write'],['POST /internal/v1/admin/activate','policy:activate']]);
 if(method==='GET'&&/^\/internal\/v1\/wallets\/[^/]+\/enrollments$/.test(path)) return 'wallet:read';
 if(method==='GET'&&/^\/internal\/v1\/targets\/[^/]+\/policy$/.test(path)) return 'policy:read';
 return exact.get(`${method} ${path}`)??null;
}
export function createAgentAccessService({store,clock=Date.now,sessionMinutes=15}={}) {
 if(!store) throw new TypeError('store is required');
 const now=()=>clock();
 const request=input=>{ const ss=scopes(input?.scopes), reason=clean(input?.reason,'reason'), duration=input?.durationMinutes===undefined?15:input.durationMinutes; if(!Number.isInteger(duration)||duration<1||duration>60) throw new RangeError('durationMinutes must be between 1 and 60'); const retrievalSecret=secret('ret_'), id=`aar_${randomUUID()}`, created=now(), expires=created+duration*60000, exchangeSecret=`ex_${digest(`${retrievalSecret}:${id}`)}`; store.createAgentAccessRequest({id,scopes:ss,reason,durationMinutes:duration,createdAt:created,expiresAt:expires,retrievalDigest:digest(retrievalSecret),exchangeDigest:digest(exchangeSecret),exchangeExpiresAt:Math.min(expires,created+10*60000)}); return {requestId:id,retrievalSecret,scopes:ss,reason,durationMinutes:duration,expiresAt:new Date(expires).toISOString()}; };
 const approve=(id,actorId)=>store.approveAgentAccessRequest(id,{actorId,now:now()});
 const retrieve=(id,retrievalSecret)=>{ const row0=store.getAgentAccessRequest(id); if(!row0||row0.expires_at<=now()||!same(digest(retrievalSecret),row0.retrieval_digest)) throw new Error('request_unavailable'); const exchangeSecret=`ex_${digest(`${retrievalSecret}:${id}`)}`; const row=store.deliverAgentAccessExchange(id,digest(retrievalSecret),now()); if(!row) throw new Error('request_unavailable'); return {...row,exchangeSecret}; };
 const exchange=token=>{ const session=secret('as_'), expiresAt=now()+sessionMinutes*60000; const row=store.exchangeAgentAccess(digest(token),{tokenDigest:digest(session),expiresAt,now:now()}); if(!row) throw new Error('exchange_unavailable'); const bounded=Math.min(row.expiresAt,expiresAt); return {sessionToken:session,expiresAt:new Date(bounded).toISOString(),scopes:row.scopes}; };
 return {request, list:()=>store.listAgentAccessRequests(now()).map(({retrievalDigest,exchangeDigest,...x})=>x), approve, deny:(id,actorId)=>store.denyAgentAccessRequest(id,actorId), retrieve, exchange, revoke:(id,actorId)=>store.revokeAgentAccessRequest(id,actorId), authenticateAgent:(token,method,path)=>{const required=scopeForRequest(method,path); if(!required)return null; const s=store.getAgentAccessSession(digest(token)); if(!s||s.revoked||s.expiresAt<=now())return null; if(s.scopes.includes(required)) { store.recordAgentAccessScopedAction(s.requestId, required, method, path); return {scope:required,requestId:s.requestId,status:'allowed'}; } return {scope:required,requestId:s.requestId,status:'scope_denied'};}, authorize:(token,method,path)=>{const s=store.getAgentAccessSession(digest(token)), required=scopeForRequest(method,path); return s&&!s.revoked&&s.expiresAt>now()&&s.scopes.includes(required)?{scope:required,requestId:s.requestId}:null;}};
}
