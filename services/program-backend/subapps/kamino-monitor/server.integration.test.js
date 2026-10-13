import test from 'node:test';
import assert from 'node:assert/strict';
import { createKaminoMonitorServer } from './server.js';
import { SOLANA_NETWORKS } from './protection.js';

const wallet = '7sXH111111111111111111111111111111111111111';
const targetId = 'solana:devnet:kelvara-demo:position:9ntw';
const token = 'demo-token';
const scope = { network: 'devnet', wallet, targetId, genesisHash: SOLANA_NETWORKS.devnet.genesisHash };
const gate = { enabled: false, protectionMode: 'demo', demoExecutionEnabled: true, productionExecutionAuthorized: false, scope };

function auth(){ return { authorize(){ return wallet; }, authorizeSession(value){ if(value !== token) throw new Error('authentication_required'); return {...scope, demoMode:true}; } }; }
async function running(options={}) {
  const server = createKaminoMonitorServer({ inspector: { inspectControlPlane: async()=>({adminRights:{}}), inspect: async()=>({}) }, walletAuth: auth(), mainnetProtectionGate: gate, pollMs: 3600000, ...options });
  await new Promise(resolve=>server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, request: (path, init={}) => fetch(base + path, init) };
}
async function json(response){ return { status: response.status, body: await response.json() }; }
const headers = {'authorization': `Bearer ${token}`, 'content-type':'application/json', 'x-kelvara-network':'devnet', 'x-kelvara-genesis':scope.genesisHash};

test('healthz and api-config expose exact public fields', async t => {
  const {server, request} = await running(); t.after(()=>server.close());
  const health = await json(await request('/healthz'));
  assert.deepEqual(health.body, {ok:true,service:'kamino-monitor',network:'mainnet',releaseSha:null,monitoring:false,controlMonitoring:true,mainnetProtection:{enabled:false,protectionMode:'demo',demoExecutionEnabled:true,productionExecutionAuthorized:false,scope,reason:null},lastError:null,controlLastError:null});
  const config = await json(await request('/api/config'));
  assert.deepEqual(config.body, {network:'mainnet',vault:'BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5',name:'Steakhouse USDG High Yield',program:'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd',walletSigning:'client-only',evacuation:false,mainnetProtection:{enabled:false,protectionMode:'demo',demoExecutionEnabled:true,productionExecutionAuthorized:false,scope,reason:null}});
});

test('demo config unavailable outside demo and scoped wallet is exact', async t => {
  process.env.DEVNET_SCENARIO_PROGRAM_ID='program'; process.env.DEVNET_FUN_USD_MINT='mint'; process.env.DEVNET_DEMO_AUTHORITY_PUBLIC_KEY='authority';
  const {server, request} = await running(); t.after(()=>{server.close(); delete process.env.DEVNET_SCENARIO_PROGRAM_ID; delete process.env.DEVNET_FUN_USD_MINT; delete process.env.DEVNET_DEMO_AUTHORITY_PUBLIC_KEY});
  assert.deepEqual(await json(await request('/api/demo/config?network=mainnet')), {status:403,body:{error:'network_mismatch'}});
  const calls=[]; const service={prepare: async input=>(calls.push(['prepare',input]),{ok:true}), triggerIncident:async()=>({}), resetIncident:async()=>({})};
  const demo = await running({demoActivationService:service}); t.after(()=>demo.server.close());
  assert.deepEqual(await json(await demo.request('/api/demo/position/prepare?network=devnet',{method:'POST',headers,body:'{}'})), {status:200,body:{ok:true}});
  assert.equal(calls[0][1].wallet,wallet);
});

test('demo evacuation prepare submit finalize dispatch', async t => {
  const calls=[]; const activation={prepare:async()=>({prepared:true}),triggerIncident:async()=>({}),resetIncident:async()=>({})}; const evacuation={submit:async input=>(calls.push(['submit',input]),{submitted:true}),finalize:async input=>(calls.push(['finalize',input]),{finalized:true})};
  const {server,request}=await running({demoActivationService:activation,demoEvacuationSubmit:evacuation}); t.after(()=>server.close());
  assert.equal((await json(await request('/api/demo/position/prepare?network=devnet',{method:'POST',headers,body:'{}'}))).status,200);
  assert.equal((await json(await request('/api/demo/evacuation/submit?network=devnet',{method:'POST',headers,body:JSON.stringify({targetId,signedTransaction:'x',lastValidBlockHeight:1})}))).status,200);
  assert.equal((await json(await request('/api/demo/evacuation/finalize?network=devnet',{method:'POST',headers,body:JSON.stringify({targetId,signature:'sig'})}))).status,200);
  assert.deepEqual(calls.map(x=>x[0]),['submit','finalize']); assert.equal(calls[0][1].wallet,wallet);
  const wrongTarget=JSON.stringify({targetId:'solana:devnet:kelvara-demo:position:wrong'});
  assert.deepEqual(await json(await request('/api/protection/evacuation/prepare?network=devnet',{method:'POST',headers,body:wrongTarget})),{status:403,body:{error:'demo_scope_mismatch'}});
});

test('all legacy protection routes fail closed in demo before handlers', async t => {
  let authorized=0; const {server,request}=await running({walletAuth:{authorizeSession:()=>{authorized++; throw new Error('should_not_run')}}}); t.after(()=>server.close());
  const routes=['/api/protection/nonce-setup/prepare','/api/protection/nonce-setup/submit','/api/protection/prepare','/api/protection/arm','/api/evacuation/prepare','/api/protection/fast-close','/api/protection/revoke/prepare','/api/protection/revoke','/api/protection/revoke/finalize','/api/protection/manual-evacuation/finalize','/api/evacuation/submit'];
  for(const path of routes) assert.deepEqual(await json(await request(path,{method:'POST',headers,body:'{}'})),{status:503,body:{error:'mainnet_protection_disabled'}});
  assert.equal(authorized,0);
});
